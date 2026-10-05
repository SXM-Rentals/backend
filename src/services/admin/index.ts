// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The work SXM Rentals staff actually do — approving
// businesses and vehicles, deciding refunds, releasing or keeping deposits,
// handling disputes, and looking after customer accounts.
//
// EVERY CHANGE IN THIS FILE IS WRITTEN INTO THE AUDIT LOG, with the reason the
// staff member gave. There is no way to change anything here without one: the
// audit helper refuses a blank reason, and so does the database. That is what
// makes "every staff change is recorded" a fact about the code rather than a
// hope about the people using it.
//
// TWO RULES THAT HOLD THROUGHOUT:
//   - A security deposit is never revenue. It appears in its own list, with its
//     own life cycle, and keeping any part of one needs a written reason.
//   - The headline figures always satisfy: gross money = what businesses are
//     paid + what SXM Rentals keeps. Deposits held are reported separately and
//     never added into any of those three.

import { requireTier } from './tiers.js';
import { markPayoutPaid as markPaidByBank, sendPayout as sendStripePayout } from '../payment-splitting/index.js';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adminStaff,
  bookings,
  customers,
  deposits,
  disputes,
  ledgerEntries,
  payouts,
  providerBusinessProfiles,
  providers,
  providerPayoutAccounts,
  bookingSignatures,
  fleetRequests,
  refundRequests,
  rewardLedger,
  vehicleDocuments,
  vehicles,
} from '../../db/schema/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import type { PaymentGateway } from '../../lib/stripe.js';
import type { PaymentService } from '../payments/index.js';
import {
  toAdminBooking,
  toAdminProvider,
  toAdminUser,
  toAdminVehicle,
  toDepositLedgerEntry,
  toDisputeCase,
  toRefundRequest,
} from '../serializers/admin.js';
import { buildMonthlySeries, buildSeries } from './analytics.js';
import type { AdminActor } from './auth.js';
import { recordAudit } from './audit.js';
import { anonymisedCustomer } from '../../lib/anonymise.js';
import { closeBusiness, reopenBusiness } from '../provider/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 200;

export type AdminServiceDeps = {
  db: Database;
  gateway: PaymentGateway;
  payments: PaymentService;
};

// How long something has been waiting, in the words the queue screen uses.
function urgencyFor(since: Date): 'normal' | 'aging' | 'overdue' {
  const days = (Date.now() - since.getTime()) / DAY_MS;
  if (days > 7) return 'overdue';
  if (days > 3) return 'aging';
  return 'normal';
}

// ---- WHAT STAFF MAY CORRECT ON A BUSINESS ----
// Split by the table each one lives on. Deliberately NOT here: verification and
// the SXM Verified badge, which have their own address, their own decision and
// their own audit entry — two ways to set one thing is how an audit log stops
// being trustworthy; the rating and review count, which are the sum of what
// customers said, so a staff-editable rating is not a rating; and whether the
// business is closed, which is what closeProvider is for.
const PROFILE_FIELDS = new Set([
  'legalName',
  'contactEmail',
  'website',
  'registrationNumber',
  'ownerName',
  'ownerPhone',
]);

const PROVIDER_FIELD_LABELS: Record<string, string> = {
  businessName: 'Business name',
  side: 'Island side',
  town: 'Town',
  description: 'Description',
  phone: 'Business phone',
  respondsIn: 'Replies within',
  deliversVehicles: 'Delivers vehicles',
  airportPickup: 'Airport pickup',
  legalName: 'Legal name',
  contactEmail: 'Contact email',
  website: 'Website',
  registrationNumber: 'Registration number',
  ownerName: 'Owner name',
  ownerPhone: 'Owner phone',
};

// Each field carries its own type, so a wrong one is refused at the edge as a
// 400 rather than reaching Postgres and failing as a driver error.
export type ProviderFieldPatch =
  | {
      field:
        | 'businessName'
        | 'town'
        | 'description'
        | 'phone'
        | 'respondsIn'
        | 'legalName'
        | 'contactEmail'
        | 'website'
        | 'registrationNumber'
        | 'ownerName'
        | 'ownerPhone';
      value: string;
    }
  | { field: 'side'; value: 'dutch' | 'french' }
  | { field: 'deliversVehicles' | 'airportPickup'; value: boolean };

export function createAdminService(deps: AdminServiceDeps) {
  const { db, gateway, payments } = deps;

  // ---- SMALL SHARED LOOKUPS ----
  const requireId = (id: string, what: string) => {
    if (!isUuid(id)) throw notFound(`We could not find that ${what}.`);
    return id;
  };

  const customerName = (customer: { firstName: string; lastName: string }) =>
    `${customer.firstName} ${customer.lastName}`;

  // A customer's points are the sum of their rewards ledger, never a stored
  // total that can drift away from the entries behind it.
  async function pointsFor(customerId: string): Promise<number> {
    const [row] = await db
      .select({ points: sql<number>`coalesce(sum(${rewardLedger.points}), 0)::int` })
      .from(rewardLedger)
      .where(eq(rewardLedger.customerId, customerId));
    return row?.points ?? 0;
  }

  async function loadCustomer(id: string) {
    const [customer] = await db.select().from(customers).where(eq(customers.id, requireId(id, 'customer'))).limit(1);
    if (!customer) throw notFound('We could not find that customer.');
    return customer;
  }

  // One "we could not find that business", shared by every address that acts on
  // one. A closed business still loads: staff look one up after it has gone.
  async function loadProvider(id: string) {
    const [provider] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, requireId(id, 'rental business')))
      .limit(1);
    if (!provider) throw notFound('We could not find that rental business.');
    return provider;
  }

  async function loadBookingContext(bookingId: string) {
    const [row] = await db
      .select({ booking: bookings, customer: customers, provider: providers })
      .from(bookings)
      .innerJoin(customers, eq(customers.id, bookings.customerId))
      .innerJoin(providers, eq(providers.id, bookings.providerId))
      .where(eq(bookings.id, bookingId))
      .limit(1);
    return row;
  }

  return {
    // ================= THE DASHBOARD =================

    // The headline figures, worked out once so the dashboard, the payments
    // screens and the analytics page cannot quietly disagree.
    async getSummary() {
      const [customerRows, providerRows, paidBookings, heldDeposits, openDisputes, pendingRefunds, pendingProviders] =
        await Promise.all([
          db
            .select({ verificationStatus: customers.verificationStatus, deletedAt: customers.deletedAt })
            .from(customers),
          db.select({ isVerified: providers.isVerified, verificationStatus: providers.verificationStatus }).from(providers),
          db
            .select({
              grossCents: bookings.grossCents,
              commissionCents: bookings.commissionCents,
              payoutCents: bookings.payoutCents,
              startDate: bookings.startDate,
            })
            .from(bookings)
            .where(eq(bookings.paymentStatus, 'paid')),
          db.select({ amountCents: deposits.amountCents }).from(deposits).where(eq(deposits.status, 'held')),
          db.select({ id: disputes.id }).from(disputes).where(inArray(disputes.status, ['open', 'investigating'])),
          db.select({ id: refundRequests.id }).from(refundRequests).where(eq(refundRequests.status, 'pending')),
          db.select({ id: providers.id }).from(providers).where(eq(providers.verificationStatus, 'pending')),
        ]);

      const live = customerRows.filter((customer) => !customer.deletedAt);
      const money = paidBookings.reduce(
        (sum, booking) => ({
          gross: sum.gross + booking.grossCents,
          commission: sum.commission + booking.commissionCents,
          payout: sum.payout + booking.payoutCents,
        }),
        { gross: 0, commission: 0, payout: 0 },
      );

      // The last six months, for the trend chart.
      const trend: { label: string; bookings: number; gmv: number }[] = [];
      for (let monthsAgo = 5; monthsAgo >= 0; monthsAgo -= 1) {
        const date = new Date();
        date.setUTCMonth(date.getUTCMonth() - monthsAgo, 1);
        const month = date.toISOString().slice(0, 7);
        const inMonth = paidBookings.filter((booking) => booking.startDate.startsWith(month));
        trend.push({
          label: month,
          bookings: inMonth.length,
          gmv: inMonth.reduce((sum, booking) => sum + booking.grossCents, 0) / 100,
        });
      }

      return {
        totalUsers: live.length,
        usersVerified: live.filter((customer) => customer.verificationStatus === 'approved').length,
        usersPending: live.filter((customer) => customer.verificationStatus === 'pending').length,
        totalProviders: providerRows.length,
        providersVerified: providerRows.filter((provider) => provider.isVerified).length,
        providersPending: pendingProviders.length,
        // gmv always equals paidOutToProviders + commissionRetained.
        gmv: money.gross / 100,
        paidOutToProviders: money.payout / 100,
        commissionRetained: money.commission / 100,
        bookingsInRange: paidBookings.length,
        // Shown on its own, apart from the revenue figures: not our money.
        depositsCurrentlyHeld: heldDeposits.reduce((sum, deposit) => sum + deposit.amountCents, 0) / 100,
        verificationsWaiting: pendingProviders.length,
        disputesOpen: openDisputes.length,
        refundsPending: pendingRefunds.length,
        bookingTrend: trend,
      };
    },

    // The three queues flattened into one list, oldest first, so staff can work
    // top to bottom instead of checking three screens and forgetting the third.
    async getQueue() {
      const [pendingProviders, pendingDocuments, openDisputes, pendingRefunds, waitingFleetRequests] = await Promise.all([
        db
          .select({ id: providers.id, name: providers.businessName, at: providers.createdAt })
          .from(providers)
          .where(eq(providers.verificationStatus, 'pending')),
        db
          .select({ id: vehicleDocuments.id, kind: vehicleDocuments.kind, at: vehicleDocuments.uploadedAt, vehicleId: vehicleDocuments.vehicleId })
          .from(vehicleDocuments)
          .where(eq(vehicleDocuments.status, 'pending')),
        db
          .select({ id: disputes.id, reference: disputes.reference, subject: disputes.subject, at: disputes.openedAt })
          .from(disputes)
          .where(inArray(disputes.status, ['open', 'investigating'])),
        db
          .select({ id: refundRequests.id, amountCents: refundRequests.amountCents, at: refundRequests.requestedAt })
          .from(refundRequests)
          .where(eq(refundRequests.status, 'pending')),
        db
          .select({ id: fleetRequests.id, at: fleetRequests.createdAt, name: providers.businessName })
          .from(fleetRequests)
          .innerJoin(providers, eq(providers.id, fleetRequests.providerId))
          .where(eq(fleetRequests.status, 'waiting')),
      ]);

      const items = [
        ...pendingProviders.map((provider) => ({
          id: provider.id,
          kind: 'verification' as const,
          title: `Business waiting for approval — ${provider.name}`,
          detail: 'Its paperwork has not been checked yet.',
          waitingSince: provider.at.toISOString(),
          href: `/providers/${provider.id}/verification`,
          urgency: urgencyFor(provider.at),
        })),
        ...pendingDocuments.map((document) => ({
          id: document.id,
          kind: 'verification' as const,
          title: `Vehicle ${document.kind} to review`,
          detail: 'A document has been uploaded and needs reading.',
          waitingSince: document.at.toISOString(),
          href: `/vehicles/${document.vehicleId}/verification`,
          urgency: urgencyFor(document.at),
        })),
        ...openDisputes.map((dispute) => ({
          id: dispute.id,
          kind: 'dispute' as const,
          title: `Dispute ${dispute.reference}`,
          detail: dispute.subject,
          waitingSince: dispute.at.toISOString(),
          href: `/disputes/${dispute.id}`,
          urgency: urgencyFor(dispute.at),
        })),
        ...pendingRefunds.map((refund) => ({
          id: refund.id,
          kind: 'refund' as const,
          title: `Refund request — $${(refund.amountCents / 100).toFixed(2)}`,
          detail: 'Waiting for a decision.',
          waitingSince: refund.at.toISOString(),
          href: `/payments/refunds`,
          urgency: urgencyFor(refund.at),
        })),
        ...waitingFleetRequests.map((request) => ({
          id: request.id,
          kind: 'fleet_request' as const,
          title: `Fleet to set up — ${request.name}`,
          detail: 'A business asked us to add its cars for it.',
          waitingSince: request.at.toISOString(),
          href: `/fleet-requests/${request.id}`,
          urgency: urgencyFor(request.at),
        })),
      ];

      // Oldest to the top: the thing waiting longest is the thing to do next.
      return items.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
    },

    // ================= CUSTOMERS =================

    async listUsers(query: { search?: string | undefined; limit?: number | undefined }) {
      const rows = await db
        .select()
        .from(customers)
        .where(
          query.search
            ? or(
                sql`${customers.email} ilike ${`%${query.search}%`}`,
                sql`${customers.firstName} || ' ' || ${customers.lastName} ilike ${`%${query.search}%`}`,
              )
            : undefined,
        )
        .orderBy(desc(customers.createdAt))
        .limit(Math.min(query.limit ?? 50, PAGE_LIMIT));

      return Promise.all(rows.map((customer) => this.getUserRecord(customer)));
    },

    // Shared by the list and the single-customer view.
    async getUserRecord(customer: typeof customers.$inferSelect) {
      const [points, bookingRows] = await Promise.all([
        pointsFor(customer.id),
        db
          .select({ grossCents: bookings.grossCents, paymentStatus: bookings.paymentStatus })
          .from(bookings)
          .where(eq(bookings.customerId, customer.id)),
      ]);
      return toAdminUser(customer, {
        points,
        bookingCount: bookingRows.length,
        lifetimeSpendCents: bookingRows
          .filter((booking) => booking.paymentStatus === 'paid')
          .reduce((sum, booking) => sum + booking.grossCents, 0),
      });
    },

    async getUser(id: string) {
      return this.getUserRecord(await loadCustomer(id));
    },

    // One field at a time, because one audit entry records one field with a
    // before and an after. Changing three things at once would make the log
    // unreadable a year later.
    async updateUserField(
      actor: AdminActor,
      id: string,
      input: { field: 'firstName' | 'lastName' | 'email' | 'phone' | 'accountType' | 'isIslander'; value: string | boolean; reason: string },
    ) {
      const customer = await loadCustomer(id);
      const before = String(customer[input.field] ?? '');
      const value =
        input.field === 'email' && typeof input.value === 'string' ? input.value.trim().toLowerCase() : input.value;

      await db
        .update(customers)
        .set({ [input.field]: value })
        .where(eq(customers.id, customer.id));

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'account_updated',
        subjectType: 'customer',
        subjectId: customer.id,
        subjectLabel: `Customer · ${customerName(customer)}`,
        field: input.field,
        before,
        after: String(value),
        reason: input.reason,
      });

      return this.getUser(customer.id);
    },

    // Points are added as a ledger entry, never by overwriting a total.
    async adjustPoints(actor: AdminActor, id: string, input: { points: number; reason: string }) {
      const customer = await loadCustomer(id);
      if (!Number.isInteger(input.points) || input.points === 0) {
        throw badRequest('invalid_points', 'Give a whole number of points to add or take away.');
      }
      const before = await pointsFor(customer.id);

      await db.insert(rewardLedger).values({
        customerId: customer.id,
        label: `Staff adjustment — ${input.reason.trim()}`,
        points: input.points,
      });

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'points_adjusted',
        subjectType: 'customer',
        subjectId: customer.id,
        subjectLabel: `Customer · ${customerName(customer)}`,
        field: 'Rewards points',
        before: before.toLocaleString(),
        after: (before + input.points).toLocaleString(),
        reason: input.reason,
      });

      return this.getUser(customer.id);
    },

    // Closing an account is blocked while a rental is running or a deposit is
    // held: closing then would strand money nobody can reclaim.
    async closeAccount(actor: AdminActor, id: string, input: { reason: string }) {
      const customer = await loadCustomer(id);
      if (customer.deletedAt) throw conflict('already_closed', 'That account is already closed.');

      const [liveBooking] = await db
        .select({ reference: bookings.reference, status: bookings.status })
        .from(bookings)
        .where(and(eq(bookings.customerId, customer.id), inArray(bookings.status, ['upcoming', 'active'])))
        .limit(1);
      if (liveBooking) {
        throw conflict(
          'has_live_rental',
          `This account has a rental that is ${liveBooking.status} (${liveBooking.reference}). It cannot be closed yet.`,
        );
      }

      const [heldDeposit] = await db
        .select({ id: deposits.id })
        .from(deposits)
        .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
        .where(and(eq(bookings.customerId, customer.id), eq(deposits.status, 'held')))
        .limit(1);
      if (heldDeposit) {
        throw conflict('has_held_deposit', 'A deposit is still being held for this account. It cannot be closed yet.');
      }

      // The same anonymising as when somebody closes their own account: the
      // phone number goes, the surname comes down to an initial, and the email
      // address is freed so the person can sign up again. Closing from the panel
      // and closing from the app must leave the same thing behind, or which door
      // was used decides what is kept.
      await db
        .update(customers)
        .set({ deletedAt: new Date(), ...anonymisedCustomer({ id: customer.id, lastName: customer.lastName }) })
        .where(eq(customers.id, customer.id));
      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'account_deleted',
        subjectType: 'customer',
        subjectId: customer.id,
        subjectLabel: `Customer · ${customerName(customer)}`,
        field: 'Account',
        before: 'Open',
        after: 'Closed',
        reason: input.reason,
      });
    },

    // ================= RENTAL BUSINESSES =================

    async listProviders(query: { status?: 'pending' | 'approved' | 'rejected' | undefined; limit?: number | undefined }) {
      const rows = await db
        .select({ provider: providers, profile: providerBusinessProfiles })
        .from(providers)
        .leftJoin(providerBusinessProfiles, eq(providerBusinessProfiles.providerId, providers.id))
        .where(query.status ? eq(providers.verificationStatus, query.status) : undefined)
        .orderBy(desc(providers.createdAt))
        .limit(Math.min(query.limit ?? 50, PAGE_LIMIT));

      return Promise.all(rows.map((row) => this.decorateProvider(row.provider, row.profile)));
    },

    async decorateProvider(
      provider: typeof providers.$inferSelect,
      profile: typeof providerBusinessProfiles.$inferSelect | null,
    ) {
      const [fleet, bookingRows] = await Promise.all([
        db
          .select({ id: vehicles.id })
          .from(vehicles)
          .where(and(eq(vehicles.providerId, provider.id), isNull(vehicles.deletedAt))),
        db
          .select({ grossCents: bookings.grossCents, paymentStatus: bookings.paymentStatus })
          .from(bookings)
          .where(eq(bookings.providerId, provider.id)),
      ]);
      return toAdminProvider(provider, profile, {
        vehicleCount: fleet.length,
        bookingCount: bookingRows.length,
        grossVolumeCents: bookingRows
          .filter((booking) => booking.paymentStatus === 'paid')
          .reduce((sum, booking) => sum + booking.grossCents, 0),
      });
    },

    async getProvider(id: string) {
      const [row] = await db
        .select({ provider: providers, profile: providerBusinessProfiles })
        .from(providers)
        .leftJoin(providerBusinessProfiles, eq(providerBusinessProfiles.providerId, providers.id))
        .where(eq(providers.id, requireId(id, 'rental business')))
        .limit(1);
      if (!row) throw notFound('We could not find that rental business.');
      return this.decorateProvider(row.provider, row.profile);
    },

    // ---- CLOSING A BUSINESS, AND OPENING IT AGAIN ----
    // The panel used to do this by taking every car down one at a time, which is
    // not the same thing: the cars come back the moment anybody puts one live,
    // the business still looks open everywhere, and it can list a new car
    // tomorrow. This is the real closure, in one transaction — and if the fourth
    // of six take-downs failed, the panel no longer has to report a half-done
    // job.
    //
    // THE AUDIT ENTRY IS THE POINT. A business closing itself leaves no staff
    // record at all; a closure by staff has to leave one, with a reason.
    async closeProvider(actor: AdminActor, id: string, input: { reason: string }) {
      const provider = await loadProvider(id);
      // Its own refusals come through untouched — already_closed, has_live_rental,
      // has_held_deposit, payout_pending — because the panel shows the server's
      // sentence to the staff member word for word. 'staff' only changes who
      // those sentences address.
      await closeBusiness(db, provider.id, 'staff');

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'business_closed',
        subjectType: 'provider',
        subjectId: provider.id,
        subjectLabel: `Business · ${provider.businessName}`,
        field: 'Status',
        before: 'Open',
        after: 'Closed',
        reason: input.reason,
      });
      return this.getProvider(provider.id);
    },

    async reopenProvider(actor: AdminActor, id: string, input: { reason: string }) {
      const provider = await loadProvider(id);
      const result = await reopenBusiness(db, provider.id);

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'business_reopened',
        subjectType: 'provider',
        subjectId: provider.id,
        subjectLabel: `Business · ${provider.businessName}`,
        field: 'Status',
        before: 'Closed',
        // Said out loud in the log, because it is the part people are surprised
        // by: the business may trade again, but its cars are still off the site.
        after: `Open · ${result.vehiclesStillSuspended} car(s) still suspended`,
        reason: input.reason,
      });
      return this.getProvider(provider.id);
    },

    // ---- CORRECTING A BUSINESS'S DETAILS ----
    // For the narrow job staff actually need: a legal name spelled wrong on a
    // payout, an email that bounces, a phone number that changed since a dispute
    // was opened. One field at a time, with a reason, like a customer's record.
    async updateProviderField(actor: AdminActor, id: string, input: ProviderFieldPatch & { reason: string }) {
      const provider = await loadProvider(id);
      const [profile] = await db
        .select()
        .from(providerBusinessProfiles)
        .where(eq(providerBusinessProfiles.providerId, provider.id))
        .limit(1);

      const { field, value } = input;
      const onProfile = PROFILE_FIELDS.has(field);
      if (onProfile && !profile) {
        throw conflict('no_business_profile', 'This business has no paperwork on file to change.');
      }

      const before = onProfile
        ? String((profile as unknown as Record<string, unknown>)[field] ?? '')
        : String((provider as unknown as Record<string, unknown>)[field] ?? '');

      if (onProfile) {
        await db
          .update(providerBusinessProfiles)
          .set({ [field]: value })
          .where(eq(providerBusinessProfiles.providerId, provider.id));
      } else {
        await db
          .update(providers)
          .set({ [field]: value })
          .where(eq(providers.id, provider.id));
      }

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'business_updated',
        subjectType: 'provider',
        subjectId: provider.id,
        subjectLabel: `Business · ${provider.businessName}`,
        // Words, not a column name: somebody reading the log next year should
        // not have to know what "respondsIn" is.
        field: PROVIDER_FIELD_LABELS[field] ?? field,
        before,
        after: String(value),
        reason: input.reason,
      });
      return this.getProvider(provider.id);
    },

    // The "SXM Verified" decision. Only staff can make it, and it is recorded.
    async decideProviderVerification(actor: AdminActor, id: string, input: { approve: boolean; reason: string }) {
      const [provider] = await db
        .select()
        .from(providers)
        .where(eq(providers.id, requireId(id, 'rental business')))
        .limit(1);
      if (!provider) throw notFound('We could not find that rental business.');

      await db
        .update(providers)
        .set({
          isVerified: input.approve,
          verificationStatus: input.approve ? 'approved' : 'rejected',
        })
        .where(eq(providers.id, provider.id));
      // The business reads the reason on its own record when it is turned down.
      await db
        .update(providerBusinessProfiles)
        .set({ verificationReason: input.approve ? null : input.reason.trim() })
        .where(eq(providerBusinessProfiles.providerId, provider.id));

      await recordAudit(db, {
        staffId: actor.staffId,
        action: input.approve ? 'verification_approved' : 'verification_rejected',
        subjectType: 'provider',
        subjectId: provider.id,
        subjectLabel: `Business · ${provider.businessName}`,
        field: 'Verification',
        before: provider.verificationStatus,
        after: input.approve ? 'approved' : 'rejected',
        reason: input.reason,
      });

      return this.getProvider(provider.id);
    },

    // The signed agreement on a booking, drawing and all, for a disputed
    // deposit. Staff are the only people besides the renter who see it.
    async getBookingAgreement(id: string) {
      const [booking] = await db
        .select({
          id: bookings.id,
          signedAt: bookings.agreementSignedAt,
          version: bookings.agreementVersion,
        })
        .from(bookings)
        .where(eq(bookings.id, requireId(id, 'booking')))
        .limit(1);
      if (!booking) throw notFound('We could not find that booking.');
      const [drawing] = await db.select().from(bookingSignatures).where(eq(bookingSignatures.bookingId, booking.id)).limit(1);
      return {
        signedAt: booking.signedAt?.toISOString() ?? null,
        version: booking.version,
        // Lines only: the panel draws them itself as paths.
        signature: drawing ? { width: drawing.width, height: drawing.height, strokes: drawing.strokes } : null,
        platform: drawing?.platform ?? null,
        ipAddress: drawing?.ipAddress ?? null,
      };
    },

    // ================= VEHICLES =================

    async listVehicles(query: { status?: 'live' | 'pending_review' | 'suspended' | undefined; limit?: number | undefined }) {
      const rows = await db
        .select({ vehicle: vehicles, providerName: providers.businessName })
        .from(vehicles)
        .innerJoin(providers, eq(providers.id, vehicles.providerId))
        .where(
          and(
            isNull(vehicles.deletedAt),
            query.status ? eq(vehicles.listingStatus, query.status) : undefined,
          ),
        )
        .orderBy(desc(vehicles.createdAt))
        .limit(Math.min(query.limit ?? 50, PAGE_LIMIT));

      return rows.map((row) => toAdminVehicle(row.vehicle, row.providerName));
    },

    async getVehicle(id: string) {
      const [row] = await db
        .select({ vehicle: vehicles, providerName: providers.businessName })
        .from(vehicles)
        .innerJoin(providers, eq(providers.id, vehicles.providerId))
        .where(eq(vehicles.id, requireId(id, 'vehicle')))
        .limit(1);
      if (!row) throw notFound('We could not find that vehicle.');

      const documents = await db.select().from(vehicleDocuments).where(eq(vehicleDocuments.vehicleId, row.vehicle.id));
      return {
        ...toAdminVehicle(row.vehicle, row.providerName),
        documents: documents.map((document) => ({
          id: document.id,
          kind: document.kind,
          status: document.status,
          fileName: document.fileName,
          uploadedAt: document.uploadedAt.toISOString(),
          ...(document.expiresAt ? { expiresAt: document.expiresAt } : {}),
          ...(document.reason ? { reason: document.reason } : {}),
          ...(document.reviewedAt ? { reviewedAt: document.reviewedAt.toISOString() } : {}),
        })),
      };
    },

    // Whether customers can see a car. A new listing starts hidden.
    async decideVehicleListing(actor: AdminActor, id: string, input: { approve: boolean; reason: string }) {
      const [vehicle] = await db
        .select()
        .from(vehicles)
        .where(eq(vehicles.id, requireId(id, 'vehicle')))
        .limit(1);
      if (!vehicle) throw notFound('We could not find that vehicle.');

      const after = input.approve ? 'live' : 'suspended';
      await db.update(vehicles).set({ listingStatus: after }).where(eq(vehicles.id, vehicle.id));

      await recordAudit(db, {
        staffId: actor.staffId,
        action: input.approve ? 'verification_approved' : 'verification_rejected',
        subjectType: 'vehicle',
        subjectId: vehicle.id,
        subjectLabel: `Vehicle · ${vehicle.reference} (${vehicle.make} ${vehicle.model})`,
        field: 'Listing',
        before: vehicle.listingStatus,
        after,
        reason: input.reason,
      });

      return this.getVehicle(vehicle.id);
    },

    // Registration, insurance and roadworthiness are read by a person: an
    // insurance certificate needs somebody to check the dates on it.
    async reviewVehicleDocument(actor: AdminActor, documentId: string, input: { approve: boolean; reason: string }) {
      const [document] = await db
        .select()
        .from(vehicleDocuments)
        .where(eq(vehicleDocuments.id, requireId(documentId, 'document')))
        .limit(1);
      if (!document) throw notFound('We could not find that document.');

      const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, document.vehicleId)).limit(1);

      await db
        .update(vehicleDocuments)
        .set({
          status: input.approve ? 'approved' : 'rejected',
          // A rejection always carries its reason; the database insists too.
          reason: input.approve ? null : input.reason.trim(),
          reviewedByStaffId: actor.staffId,
          reviewedAt: new Date(),
        })
        .where(eq(vehicleDocuments.id, document.id));

      await recordAudit(db, {
        staffId: actor.staffId,
        action: input.approve ? 'verification_approved' : 'verification_rejected',
        subjectType: 'vehicle',
        subjectId: document.vehicleId,
        subjectLabel: `Vehicle · ${vehicle?.reference ?? document.vehicleId}`,
        field: `${document.kind} document`,
        before: document.status,
        after: input.approve ? 'approved' : 'rejected',
        reason: input.reason,
      });
    },

    // ================= BOOKINGS =================

    async listBookings(query: { reference?: string | undefined; limit?: number | undefined }) {
      const rows = await db
        .select({ booking: bookings, customer: customers, provider: providers, vehicle: vehicles })
        .from(bookings)
        .innerJoin(customers, eq(customers.id, bookings.customerId))
        .innerJoin(providers, eq(providers.id, bookings.providerId))
        .innerJoin(vehicles, eq(vehicles.id, bookings.vehicleId))
        .where(query.reference ? eq(bookings.reference, query.reference.toUpperCase()) : undefined)
        .orderBy(desc(bookings.createdAt))
        .limit(Math.min(query.limit ?? 50, PAGE_LIMIT));
      if (rows.length === 0) return [];

      const depositRows = await db
        .select()
        .from(deposits)
        .where(inArray(deposits.bookingId, rows.map((row) => row.booking.id)));

      return rows.map((row) =>
        toAdminBooking(
          row.booking,
          {
            customerName: customerName(row.customer),
            providerName: row.provider.businessName,
            vehicleLabel: `${row.vehicle.make} ${row.vehicle.model} (${row.vehicle.reference})`,
          },
          depositRows.find((deposit) => deposit.bookingId === row.booking.id),
        ),
      );
    },

    async getBooking(id: string) {
      const row = await loadBookingContext(requireId(id, 'booking'));
      if (!row) throw notFound('We could not find that booking.');
      const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, row.booking.vehicleId)).limit(1);
      const [deposit] = await db.select().from(deposits).where(eq(deposits.bookingId, row.booking.id)).limit(1);

      return toAdminBooking(
        row.booking,
        {
          customerName: customerName(row.customer),
          providerName: row.provider.businessName,
          vehicleLabel: vehicle ? `${vehicle.make} ${vehicle.model} (${vehicle.reference})` : '',
        },
        deposit,
      );
    },

    // ================= DEPOSITS =================
    // The customer's money, held and given back. Never revenue, never a payout.

    async listDeposits(query: { status?: 'not_taken' | 'held' | 'released' | 'claimed' | undefined }) {
      const rows = await db
        .select({ deposit: deposits, booking: bookings, customer: customers, provider: providers })
        .from(deposits)
        .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
        .innerJoin(customers, eq(customers.id, bookings.customerId))
        .innerJoin(providers, eq(providers.id, bookings.providerId))
        .where(query.status ? eq(deposits.status, query.status) : undefined)
        .orderBy(desc(deposits.createdAt))
        .limit(PAGE_LIMIT);

      return rows.map((row) =>
        toDepositLedgerEntry(row.deposit, {
          bookingRef: row.booking.reference,
          customerName: customerName(row.customer),
          providerName: row.provider.businessName,
        }),
      );
    },

    async releaseDeposit(actor: AdminActor, id: string, input: { reason: string }) {
      const [deposit] = await db.select().from(deposits).where(eq(deposits.id, requireId(id, 'deposit'))).limit(1);
      if (!deposit) throw notFound('We could not find that deposit.');
      const booking = await loadBookingContext(deposit.bookingId);

      await payments.releaseDeposit(deposit.id);
      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'deposit_released',
        subjectType: 'payment',
        subjectId: deposit.id,
        subjectLabel: `Deposit · ${booking?.booking.reference ?? deposit.bookingId}`,
        field: 'Deposit',
        before: deposit.status,
        after: 'released',
        reason: input.reason,
      });
    },

    // Keeping any part of a deposit: the most disputable thing the platform can
    // do, so the reason is written down and the amount can never exceed what
    // was held.
    async claimDeposit(actor: AdminActor, id: string, input: { amountCents: number; reason: string }) {
      const [deposit] = await db.select().from(deposits).where(eq(deposits.id, requireId(id, 'deposit'))).limit(1);
      if (!deposit) throw notFound('We could not find that deposit.');
      const booking = await loadBookingContext(deposit.bookingId);

      await payments.claimDeposit(deposit.id, { reason: input.reason, amountCents: input.amountCents });
      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'deposit_claimed',
        subjectType: 'payment',
        subjectId: deposit.id,
        subjectLabel: `Deposit · ${booking?.booking.reference ?? deposit.bookingId}`,
        field: 'Deposit',
        before: `${(deposit.amountCents / 100).toFixed(2)} held`,
        after: `${(input.amountCents / 100).toFixed(2)} kept`,
        reason: input.reason,
      });
    },

    // ================= REFUNDS =================

    async listRefunds(query: { status?: 'pending' | 'approved' | 'denied' | undefined }) {
      const rows = await db
        .select({ refund: refundRequests, booking: bookings, customer: customers, provider: providers, staffName: adminStaff.name })
        .from(refundRequests)
        .innerJoin(bookings, eq(bookings.id, refundRequests.bookingId))
        .innerJoin(customers, eq(customers.id, bookings.customerId))
        .innerJoin(providers, eq(providers.id, bookings.providerId))
        .leftJoin(adminStaff, eq(adminStaff.id, refundRequests.decidedByStaffId))
        .where(query.status ? eq(refundRequests.status, query.status) : undefined)
        .orderBy(desc(refundRequests.requestedAt))
        .limit(PAGE_LIMIT);

      return rows.map((row) =>
        toRefundRequest(
          row.refund,
          {
            bookingRef: row.booking.reference,
            customerName: customerName(row.customer),
            providerName: row.provider.businessName,
          },
          row.staffName,
        ),
      );
    },

    // Approving sends the money back through Stripe. Either way the decision
    // and its reason are recorded against the staff member who made it.
    async decideRefund(
      actor: AdminActor,
      id: string,
      // customerNote: what the customer is told when it is denied. Separate from
      // the reason, which is for the audit log and may be for staff only.
      input: { approve: boolean; reason: string; customerNote?: string | undefined },
    ) {
      const [refund] = await db
        .select()
        .from(refundRequests)
        .where(eq(refundRequests.id, requireId(id, 'refund request')))
        .limit(1);
      if (!refund) throw notFound('We could not find that refund request.');
      if (refund.status !== 'pending') throw conflict('already_decided', 'That refund has already been decided.');

      const context = await loadBookingContext(refund.bookingId);

      if (input.approve) {
        if (context?.booking.stripePaymentIntentId) {
          await gateway.refundPayment(context.booking.stripePaymentIntentId, refund.amountCents);
          await db.insert(ledgerEntries).values({
            bookingId: refund.bookingId,
            kind: 'refund',
            amountCents: refund.amountCents,
            status: 'pending',
            stripeRef: context.booking.stripePaymentIntentId,
            occurredAt: new Date(),
          });
        }
      }

      await db
        .update(refundRequests)
        .set({
          status: input.approve ? 'approved' : 'denied',
          decidedByStaffId: actor.staffId,
          decidedAt: new Date(),
          decisionReason: input.reason.trim(),
          customerNote: input.customerNote ?? null,
        })
        .where(eq(refundRequests.id, refund.id));

      await recordAudit(db, {
        staffId: actor.staffId,
        action: input.approve ? 'refund_approved' : 'refund_denied',
        subjectType: 'payment',
        subjectId: refund.id,
        subjectLabel: `Refund · ${context?.booking.reference ?? refund.bookingId}`,
        field: 'Refund request',
        before: 'pending',
        after: input.approve ? 'approved' : 'denied',
        reason: input.reason,
      });
    },

    // ================= DISPUTES =================

    async listDisputes(query: { status?: 'open' | 'investigating' | 'resolved' | undefined }) {
      const rows = await db
        .select({ dispute: disputes, booking: bookings, customer: customers, provider: providers, staffName: adminStaff.name })
        .from(disputes)
        .innerJoin(bookings, eq(bookings.id, disputes.bookingId))
        .innerJoin(customers, eq(customers.id, bookings.customerId))
        .innerJoin(providers, eq(providers.id, bookings.providerId))
        .leftJoin(adminStaff, eq(adminStaff.id, disputes.assignedToStaffId))
        .where(query.status ? eq(disputes.status, query.status) : undefined)
        .orderBy(desc(disputes.openedAt))
        .limit(PAGE_LIMIT);

      return rows.map((row) =>
        toDisputeCase(
          row.dispute,
          {
            bookingRef: row.booking.reference,
            customerName: customerName(row.customer),
            providerName: row.provider.businessName,
          },
          row.staffName,
        ),
      );
    },

    async getDispute(id: string) {
      const all = await this.listDisputes({});
      const dispute = all.find((entry) => entry.id === requireId(id, 'dispute'));
      if (!dispute) throw notFound('We could not find that dispute.');
      return dispute;
    },

    // An unowned dispute is the thing most likely to be forgotten about, so
    // assigning one is a recorded action like any other.
    async assignDispute(actor: AdminActor, id: string, input: { staffId: string; reason: string }) {
      const [dispute] = await db.select().from(disputes).where(eq(disputes.id, requireId(id, 'dispute'))).limit(1);
      if (!dispute) throw notFound('We could not find that dispute.');

      const [assignee] = await db
        .select({ id: adminStaff.id, name: adminStaff.name })
        .from(adminStaff)
        .where(eq(adminStaff.id, requireId(input.staffId, 'staff member')))
        .limit(1);
      if (!assignee) throw notFound('We could not find that staff member.');

      await db
        .update(disputes)
        .set({ assignedToStaffId: assignee.id, status: dispute.status === 'open' ? 'investigating' : dispute.status })
        .where(eq(disputes.id, dispute.id));

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'dispute_assigned',
        subjectType: 'booking',
        subjectId: dispute.bookingId,
        subjectLabel: `Dispute · ${dispute.reference}`,
        field: 'Assigned to',
        before: dispute.assignedToStaffId ? 'someone else' : 'nobody',
        after: assignee.name,
        reason: input.reason,
      });

      return this.getDispute(dispute.id);
    },

    async resolveDispute(actor: AdminActor, id: string, input: { notes: string; reason: string }) {
      const [dispute] = await db.select().from(disputes).where(eq(disputes.id, requireId(id, 'dispute'))).limit(1);
      if (!dispute) throw notFound('We could not find that dispute.');
      if (dispute.status === 'resolved') throw conflict('already_resolved', 'That dispute is already resolved.');

      await db
        .update(disputes)
        .set({ status: 'resolved', resolutionNotes: input.notes.trim(), resolvedAt: new Date() })
        .where(eq(disputes.id, dispute.id));

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'dispute_resolved',
        subjectType: 'booking',
        subjectId: dispute.bookingId,
        subjectLabel: `Dispute · ${dispute.reference}`,
        field: 'Status',
        before: dispute.status,
        after: 'resolved',
        reason: input.reason,
      });

      return this.getDispute(dispute.id);
    },

    // ================= MONEY, READ ONLY =================

    async listLedger(query: { limit?: number | undefined }) {
      const rows = await db
        .select({ entry: ledgerEntries, booking: bookings, customer: customers, provider: providers })
        .from(ledgerEntries)
        .leftJoin(bookings, eq(bookings.id, ledgerEntries.bookingId))
        .leftJoin(customers, eq(customers.id, bookings.customerId))
        .leftJoin(providers, eq(providers.id, bookings.providerId))
        .orderBy(desc(ledgerEntries.occurredAt))
        .limit(Math.min(query.limit ?? 100, PAGE_LIMIT));

      return rows.map((row) => ({
        id: row.entry.id,
        at: row.entry.occurredAt.toISOString(),
        bookingRef: row.booking?.reference ?? '',
        customerName: row.customer ? customerName(row.customer) : '',
        providerName: row.provider?.businessName ?? '',
        kind: row.entry.kind,
        amount: row.entry.amountCents / 100,
        status: row.entry.status,
        stripeRef: row.entry.stripeRef,
      }));
    },

    async listPayouts(query: { limit?: number | undefined }) {
      const rows = await db
        .select({ payout: payouts, providerName: providers.businessName, method: providerPayoutAccounts.method })
        .from(payouts)
        .innerJoin(providers, eq(providers.id, payouts.providerId))
        .leftJoin(providerPayoutAccounts, eq(providerPayoutAccounts.providerId, payouts.providerId))
        .orderBy(desc(payouts.periodEnd))
        .limit(Math.min(query.limit ?? 100, PAGE_LIMIT));

      return rows.map((row) => ({
        id: row.payout.id,
        reference: row.payout.reference,
        providerName: row.providerName,
        amount: row.payout.amountCents / 100,
        grossAmount: row.payout.grossCents / 100,
        commission: row.payout.commissionCents / 100,
        bookingCount: row.payout.bookingCount,
        periodStart: row.payout.periodStart,
        periodEnd: row.payout.periodEnd,
        status: row.payout.status,
        ...(row.payout.paidOn ? { paidOn: row.payout.paidOn.toISOString().slice(0, 10) } : {}),
        // How it is paid: "send" it through Stripe, or record a bank transfer.
        method: row.method ?? 'stripe',
        bankReference: row.payout.bankReference,
      }));
    },

    // ---- PAYING A BUSINESS ITS SHARE ----
    // Real money leaving SXM Rentals, so Owner access and the authenticator
    // code, and always on the audit log.
    async sendPayout(actor: AdminActor, id: string, input: { reason: string }) {
      requireTier(actor, 'owner');
      const payout = await this.loadPayout(id);
      await sendStripePayout(db, gateway, payout.id);
      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'payout_sent',
        subjectType: 'payment',
        subjectId: payout.id,
        subjectLabel: `Payout · ${payout.reference}`,
        field: 'Status',
        before: payout.status,
        after: 'paid',
        reason: input.reason,
      });
      return this.payoutView(payout.id);
    },

    async markPayoutPaid(actor: AdminActor, id: string, input: { reason: string; bankReference: string }) {
      requireTier(actor, 'owner');
      const payout = await this.loadPayout(id);
      await markPaidByBank(db, payout.id, { bankReference: input.bankReference, staffId: actor.staffId });
      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'payout_marked_paid',
        subjectType: 'payment',
        subjectId: payout.id,
        subjectLabel: `Payout · ${payout.reference}`,
        field: 'Status',
        before: payout.status,
        after: `paid by bank transfer (${input.bankReference})`,
        reason: input.reason,
      });
      return this.payoutView(payout.id);
    },

    async loadPayout(id: string) {
      const [payout] = await db.select().from(payouts).where(eq(payouts.id, requireId(id, 'payout'))).limit(1);
      if (!payout) throw notFound('We could not find that payout.');
      return payout;
    },

    async payoutView(id: string) {
      const all = await this.listPayouts({ limit: PAGE_LIMIT });
      return all.find((payout) => payout.id === id)!;
    },

    // ================= ANALYTICS =================
    // Money taken, bookings made and people who signed up, bucketed to suit the
    // span asked about. See services/admin/analytics.ts for why the bucket
    // follows the question rather than the other way round.

    async getAnalytics(query: { months?: number | undefined; from?: string | undefined; to?: string | undefined }) {
      if (query.from && query.to) {
        if (query.from > query.to) {
          throw badRequest('invalid_range', 'The start of the range has to be before the end.');
        }
        return buildSeries(db, query.from, query.to);
      }
      return buildMonthlySeries(db, query.months ?? 6);
    },

    // Staff names, for assigning disputes.
    async listStaff() {
      const rows = await db
        .select({ id: adminStaff.id, name: adminStaff.name, email: adminStaff.email, avatarInitials: adminStaff.avatarInitials })
        .from(adminStaff)
        .where(isNull(adminStaff.disabledAt))
        .orderBy(adminStaff.name);
      return rows;
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
