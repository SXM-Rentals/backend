// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Everything a rental business sees and does about ITSELF:
// registering with SXM Rentals, its own record, its fleet, how each car is
// doing, the bookings across that fleet, what it has been paid, and setting up
// where the money goes.
//
// THE WALL BETWEEN BUSINESSES. Every function here starts from a membership —
// which signed-in person acts for which business — and every query is tied to
// that business's id. There is no way to ask about another business by changing
// a number: their cars and bookings simply are not found.
//
// WHAT A BUSINESS NEVER SEES. Bookings come back through the provider
// serializer, which has no field for a customer's phone number or email. A
// business gets a display name and whether the person has been verified, which
// is what is actually needed to hand over a car.
//
// EVERY FIGURE IS THEIR OWN SHARE, after SXM Rentals' commission, with the
// deduction shown beside it rather than hidden.

import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import {
  bookings,
  chatThreads,
  customers,
  deposits,
  payouts,
  providerBusinessProfiles,
  providerMembers,
  providerPayoutAccounts,
  providers,
  vehicleAccidentRecords,
  vehiclePhotos,
  vehicles,
} from '../../db/schema/index.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import type { Actor } from '../../lib/ownership.js';
import { isUuid } from '../../lib/ownership.js';
import type { PaymentGateway } from '../../lib/stripe.js';
import { daysBetween, unavailableDatesFor } from '../availability-engine/index.js';
import { nextPayoutDate } from '../payment-splitting/index.js';
import { toBusinessProfile, toPayoutRecord, toVehiclePerformance } from '../serializers/business.js';
import { toProviderBooking } from '../serializers/bookings.js';
import { toVehicle } from '../serializers/vehicles.js';

// How far back the performance figures look.
const PERFORMANCE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ProviderContext = { providerId: string; role: 'owner' | 'staff' };

// ---- WHICH BUSINESS IS THIS PERSON ACTING FOR? ----
// Everything else in this file starts here. Somebody with no business linked to
// their account is told so plainly, rather than being shown an empty dashboard.
export async function requireProviderFor(db: Database, actor: Actor): Promise<ProviderContext> {
  const [membership] = await db
    .select({ providerId: providerMembers.providerId, role: providerMembers.role })
    .from(providerMembers)
    .where(eq(providerMembers.customerId, actor.customerId))
    .limit(1);
  if (!membership) {
    throw new AppError(403, 'not_a_provider', 'This account is not linked to a rental business.');
  }
  return membership;
}

export type ApplyInput = {
  businessName: string;
  legalName: string;
  contactEmail: string;
  ownerName: string;
  ownerPhone: string;
  town: string;
  side: 'dutch' | 'french';
  operatingSide: 'dutch' | 'french' | 'both';
  phone?: string | undefined;
  description?: string | undefined;
  website?: string | undefined;
  registrationStatus?: 'registered' | 'not_registered' | 'pending' | undefined;
  registrationNumber?: string | undefined;
  registeredIn?: string | undefined;
  fleetSizeBand?: string | undefined;
  locations?: string[] | undefined;
  deliversVehicles?: boolean | undefined;
  airportPickup?: boolean | undefined;
};

// ---- REGISTERING A BUSINESS ----
// The business is created unverified: staff check its paperwork before the
// "SXM Verified" badge appears, and its cars wait for approval before any
// customer can see them.
export async function applyAsProvider(db: Database, actor: Actor, input: ApplyInput) {
  const [existing] = await db
    .select({ providerId: providerMembers.providerId })
    .from(providerMembers)
    .where(eq(providerMembers.customerId, actor.customerId))
    .limit(1);
  if (existing) {
    throw conflict('already_a_provider', 'This account is already linked to a rental business.');
  }

  return db.transaction(async (tx) => {
    const [provider] = await tx
      .insert(providers)
      .values({
        businessName: input.businessName,
        side: input.side,
        town: input.town,
        description: input.description ?? '',
        phone: input.phone ?? '',
        deliversVehicles: input.deliversVehicles ?? false,
        airportPickup: input.airportPickup ?? false,
        isVerified: false,
        verificationStatus: 'pending',
      })
      .returning();
    if (!provider) throw new Error('Business was not created');

    const [profile] = await tx
      .insert(providerBusinessProfiles)
      .values({
        providerId: provider.id,
        legalName: input.legalName,
        contactEmail: input.contactEmail.trim().toLowerCase(),
        website: input.website,
        registrationStatus: input.registrationStatus ?? 'pending',
        registrationNumber: input.registrationNumber,
        registeredIn: input.registeredIn,
        fleetSizeBand: input.fleetSizeBand ?? '',
        locations: input.locations ?? [],
        operatingSide: input.operatingSide,
        ownerName: input.ownerName,
        ownerPhone: input.ownerPhone,
      })
      .returning();

    // Whoever applied runs the business.
    await tx.insert(providerMembers).values({
      providerId: provider.id,
      customerId: actor.customerId,
      role: 'owner',
    });
    // Nothing can be paid out until they have given Stripe their details.
    await tx.insert(providerPayoutAccounts).values({ providerId: provider.id, status: 'not_started' });

    return toBusinessProfile(profile!, provider);
  });
}

// ---- THE BUSINESS'S OWN RECORD ----
export async function getBusinessProfile(db: Database, providerId: string) {
  const [row] = await db
    .select({ profile: providerBusinessProfiles, provider: providers })
    .from(providerBusinessProfiles)
    .innerJoin(providers, eq(providers.id, providerBusinessProfiles.providerId))
    .where(eq(providerBusinessProfiles.providerId, providerId))
    .limit(1);
  if (!row) throw notFound('We could not find that rental business.');
  return toBusinessProfile(row.profile, row.provider);
}

export type ProfilePatch = {
  // Shown to customers on the public page.
  description?: string | undefined;
  town?: string | undefined;
  phone?: string | undefined;
  deliversVehicles?: boolean | undefined;
  airportPickup?: boolean | undefined;
  // The private half.
  website?: string | undefined;
  legalName?: string | undefined;
  contactEmail?: string | undefined;
  ownerName?: string | undefined;
  ownerPhone?: string | undefined;
  fleetSizeBand?: string | undefined;
  locations?: string[] | undefined;
  operatingSide?: 'dutch' | 'french' | 'both' | undefined;
};

// A business can edit its own description and details. It cannot make itself
// verified: that is a staff decision, so those fields are not touched here.
export async function updateBusinessProfile(db: Database, providerId: string, patch: ProfilePatch) {
  const publicChanges = {
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.town !== undefined ? { town: patch.town } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
    ...(patch.deliversVehicles !== undefined ? { deliversVehicles: patch.deliversVehicles } : {}),
    ...(patch.airportPickup !== undefined ? { airportPickup: patch.airportPickup } : {}),
  };
  const privateChanges = {
    ...(patch.website !== undefined ? { website: patch.website } : {}),
    ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
    ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail.trim().toLowerCase() } : {}),
    ...(patch.ownerName !== undefined ? { ownerName: patch.ownerName } : {}),
    ...(patch.ownerPhone !== undefined ? { ownerPhone: patch.ownerPhone } : {}),
    ...(patch.fleetSizeBand !== undefined ? { fleetSizeBand: patch.fleetSizeBand } : {}),
    ...(patch.locations !== undefined ? { locations: patch.locations } : {}),
    ...(patch.operatingSide !== undefined ? { operatingSide: patch.operatingSide } : {}),
  };

  if (Object.keys(publicChanges).length > 0) {
    await db.update(providers).set(publicChanges).where(eq(providers.id, providerId));
  }
  if (Object.keys(privateChanges).length > 0) {
    await db
      .update(providerBusinessProfiles)
      .set(privateChanges)
      .where(eq(providerBusinessProfiles.providerId, providerId));
  }
  return getBusinessProfile(db, providerId);
}

// ---- THE HEADLINE FIGURES ----
export async function getSummary(db: Database, providerId: string) {
  const since = new Date(Date.now() - PERFORMANCE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);

  const [fleet, payoutRows, bookingRows, [threads]] = await Promise.all([
    db
      .select({ rating: vehicles.rating, reviewCount: vehicles.reviewCount })
      .from(vehicles)
      .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt))),
    db.select().from(payouts).where(eq(payouts.providerId, providerId)),
    db
      .select({ status: bookings.status, startDate: bookings.startDate })
      .from(bookings)
      .where(eq(bookings.providerId, providerId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatThreads)
      .where(eq(chatThreads.providerId, providerId)),
  ]);

  const paidOutCents = payoutRows
    .filter((payout) => payout.status === 'paid')
    .reduce((sum, payout) => sum + payout.amountCents, 0);
  const pendingCents = payoutRows
    .filter((payout) => payout.status !== 'paid')
    .reduce((sum, payout) => sum + payout.amountCents, 0);

  const rated = fleet.filter((vehicle) => vehicle.reviewCount > 0);
  const recentBookings = bookingRows.filter((booking) => booking.startDate >= since && booking.status !== 'cancelled');

  return {
    // Their share, after commission. Deposits are never counted here.
    paidOut: paidOutCents / 100,
    pending: pendingCents / 100,
    nextPayoutDate: nextPayoutDate(),
    activeBookings: bookingRows.filter((booking) => booking.status === 'active').length,
    upcomingBookings: bookingRows.filter((booking) => booking.status === 'upcoming').length,
    fleetSize: fleet.length,
    averageRating: rated.length > 0 ? rated.reduce((sum, v) => sum + v.rating, 0) / rated.length : 0,
    // Enquiries are conversations started with this business. Messaging is not
    // built yet, so this is 0 rather than a made-up number.
    totalInquiries: threads?.count ?? 0,
    totalConversions: recentBookings.length,
  };
}

// ---- THE FLEET ----
// Every car the business has, including ones still waiting for staff approval —
// which is why this is not the same query as the public search.
export async function listFleet(db: Database, providerId: string) {
  const rows = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)))
    .orderBy(desc(vehicles.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [photos, accidents, taken] = await Promise.all([
    db.select().from(vehiclePhotos).where(inArray(vehiclePhotos.vehicleId, ids)),
    db.select().from(vehicleAccidentRecords).where(inArray(vehicleAccidentRecords.vehicleId, ids)),
    unavailableDatesFor(db, ids),
  ]);

  return rows.map((row) => ({
    ...toVehicle(
      row,
      photos.filter((photo) => photo.vehicleId === row.id),
      accidents.filter((accident) => accident.vehicleId === row.id),
      taken.get(row.id) ?? [],
    ),
    // Extra, for the business only: whether customers can see this car yet.
    listingStatus: row.listingStatus,
    reference: row.reference,
  }));
}

export type VehicleInput = {
  make: string;
  model: string;
  year: number;
  vehicleClass: 'economy' | 'compact' | 'suv' | 'van' | 'fourByFour' | 'luxury';
  transmission: 'automatic' | 'manual';
  fuel: 'petrol' | 'diesel' | 'hybrid' | 'electric';
  seats: number;
  doors: number;
  dailyRate: number;
  depositAmount: number;
  pickupTown: string;
  side: 'dutch' | 'french';
  latitude: number;
  longitude: number;
  trim?: string | undefined;
  weeklyRate?: number | undefined;
  minimumDays?: number | undefined;
  maximumDays?: number | undefined;
  airConditioning?: boolean | undefined;
  deliveryAvailable?: boolean | undefined;
  description?: string | undefined;
};

// A new car waits for staff approval before customers can see it.
export async function addVehicle(db: Database, providerId: string, input: VehicleInput) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const [vehicle] = await db
        .insert(vehicles)
        .values({
          reference: `SXM-V-${100 + Math.floor(Math.random() * 9900)}`,
          providerId,
          make: input.make,
          model: input.model,
          year: input.year,
          trim: input.trim,
          vehicleClass: input.vehicleClass,
          transmission: input.transmission,
          fuel: input.fuel,
          seats: input.seats,
          doors: input.doors,
          airConditioning: input.airConditioning ?? true,
          dailyRateCents: Math.round(input.dailyRate * 100),
          weeklyRateCents: input.weeklyRate === undefined ? null : Math.round(input.weeklyRate * 100),
          minimumDays: input.minimumDays ?? 1,
          maximumDays: input.maximumDays ?? 30,
          depositAmountCents: Math.round(input.depositAmount * 100),
          depositIsVehicleSpecific: true,
          pickupTown: input.pickupTown,
          side: input.side,
          deliveryAvailable: input.deliveryAvailable ?? false,
          latitude: input.latitude,
          longitude: input.longitude,
          description: input.description ?? '',
          listingStatus: 'pending_review',
        })
        .returning();
      if (vehicle) return { ...toVehicle(vehicle, [], [], []), listingStatus: vehicle.listingStatus, reference: vehicle.reference };
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code;
      if (code !== '23505') throw error;
    }
  }
  throw new Error('Could not allocate a vehicle reference');
}

// One of this business's own cars, or "not found".
async function loadOwnVehicle(db: Database, providerId: string, vehicleId: string) {
  if (!isUuid(vehicleId)) throw notFound('We could not find that vehicle.');
  const [vehicle] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)))
    .limit(1);
  if (!vehicle) throw notFound('We could not find that vehicle.');
  return vehicle;
}

export type VehiclePatch = Partial<VehicleInput>;

export async function updateVehicle(db: Database, providerId: string, vehicleId: string, patch: VehiclePatch) {
  const existing = await loadOwnVehicle(db, providerId, vehicleId);
  const changes = {
    ...(patch.dailyRate !== undefined ? { dailyRateCents: Math.round(patch.dailyRate * 100) } : {}),
    ...(patch.weeklyRate !== undefined ? { weeklyRateCents: Math.round(patch.weeklyRate * 100) } : {}),
    ...(patch.depositAmount !== undefined ? { depositAmountCents: Math.round(patch.depositAmount * 100) } : {}),
    ...(patch.minimumDays !== undefined ? { minimumDays: patch.minimumDays } : {}),
    ...(patch.maximumDays !== undefined ? { maximumDays: patch.maximumDays } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.pickupTown !== undefined ? { pickupTown: patch.pickupTown } : {}),
    ...(patch.deliveryAvailable !== undefined ? { deliveryAvailable: patch.deliveryAvailable } : {}),
    ...(patch.airConditioning !== undefined ? { airConditioning: patch.airConditioning } : {}),
    ...(patch.seats !== undefined ? { seats: patch.seats } : {}),
    ...(patch.doors !== undefined ? { doors: patch.doors } : {}),
    ...(patch.trim !== undefined ? { trim: patch.trim } : {}),
  };
  if (Object.keys(changes).length === 0) {
    return { ...toVehicle(existing, [], [], []), listingStatus: existing.listingStatus, reference: existing.reference };
  }

  const [updated] = await db.update(vehicles).set(changes).where(eq(vehicles.id, existing.id)).returning();
  return { ...toVehicle(updated!, [], [], []), listingStatus: updated!.listingStatus, reference: updated!.reference };
}

// Taking a car off the platform. Refused while somebody is due to collect it:
// removing it then would strand a real booking.
export async function removeVehicle(db: Database, providerId: string, vehicleId: string) {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  const [liveBooking] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.vehicleId, vehicle.id),
        inArray(bookings.status, ['upcoming', 'active']),
      ),
    )
    .limit(1);
  if (liveBooking) {
    throw conflict('vehicle_has_bookings', 'This vehicle has a rental coming up, so it cannot be removed yet.');
  }
  await db
    .update(vehicles)
    .set({ deletedAt: new Date(), listingStatus: 'suspended' })
    .where(eq(vehicles.id, vehicle.id));
}

// ---- HOW EACH CAR IS DOING ----
export async function listPerformance(db: Database, providerId: string) {
  const windowStart = new Date(Date.now() - PERFORMANCE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  const [fleet, rows, threadRows] = await Promise.all([
    db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt))),
    db
      .select({
        vehicleId: bookings.vehicleId,
        payoutCents: bookings.payoutCents,
        startDate: bookings.startDate,
        endDate: bookings.endDate,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.providerId, providerId),
          ne(bookings.status, 'cancelled'),
          sql`${bookings.endDate} >= ${windowStart}`,
        ),
      ),
    db
      .select({ vehicleId: chatThreads.vehicleId, count: sql<number>`count(*)::int` })
      .from(chatThreads)
      .where(eq(chatThreads.providerId, providerId))
      .groupBy(chatThreads.vehicleId),
  ]);

  return fleet.map((vehicle) => {
    const forVehicle = rows.filter((row) => row.vehicleId === vehicle.id);
    // Days the car was actually out, counting only days inside the window.
    const daysOut = forVehicle.reduce(
      (sum, row) => sum + daysBetween(row.startDate, row.endDate).filter((day) => day >= windowStart && day <= todayIso).length,
      0,
    );
    return toVehiclePerformance({
      vehicleId: vehicle.id,
      // Their share, after commission.
      revenueCents: forVehicle.reduce((sum, row) => sum + row.payoutCents, 0),
      bookings: forVehicle.length,
      daysOut,
      daysInPeriod: PERFORMANCE_WINDOW_DAYS,
      inquiries: threadRows.find((thread) => thread.vehicleId === vehicle.id)?.count ?? 0,
    });
  });
}

// ---- BOOKINGS ACROSS THE FLEET ----
// Built through the provider serializer, which has no field for a customer's
// phone number or email.
export async function listProviderBookings(db: Database, providerId: string) {
  const rows = await db
    .select({ booking: bookings, renter: customers })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(eq(bookings.providerId, providerId))
    .orderBy(desc(bookings.startDate));
  if (rows.length === 0) return [];

  const depositRows = await db
    .select()
    .from(deposits)
    .where(inArray(deposits.bookingId, rows.map((row) => row.booking.id)));

  return rows.map((row) =>
    toProviderBooking(
      row.booking,
      depositRows.find((deposit) => deposit.bookingId === row.booking.id),
      {
        firstName: row.renter.firstName,
        lastName: row.renter.lastName,
        verificationStatus: row.renter.verificationStatus,
      },
    ),
  );
}

export async function getProviderBooking(db: Database, providerId: string, bookingId: string) {
  if (!isUuid(bookingId)) throw notFound('We could not find that booking.');
  const [row] = await db
    .select({ booking: bookings, renter: customers })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, providerId)))
    .limit(1);
  if (!row) throw notFound('We could not find that booking.');

  const [deposit] = await db.select().from(deposits).where(eq(deposits.bookingId, row.booking.id)).limit(1);
  return toProviderBooking(row.booking, deposit, {
    firstName: row.renter.firstName,
    lastName: row.renter.lastName,
    verificationStatus: row.renter.verificationStatus,
  });
}

// ---- WHAT THEY HAVE BEEN PAID ----
export async function listPayouts(db: Database, providerId: string) {
  const rows = await db
    .select()
    .from(payouts)
    .where(eq(payouts.providerId, providerId))
    .orderBy(desc(payouts.periodEnd));
  return rows.map(toPayoutRecord);
}

// ---- WHERE THE MONEY GOES ----
// The business gives its bank details to Stripe directly, through a one-time
// link. Those details never pass through this server.
export async function startPayoutOnboarding(
  db: Database,
  gateway: PaymentGateway,
  config: Config,
  providerId: string,
) {
  const [row] = await db
    .select({ account: providerPayoutAccounts, provider: providers, profile: providerBusinessProfiles })
    .from(providerPayoutAccounts)
    .innerJoin(providers, eq(providers.id, providerPayoutAccounts.providerId))
    .innerJoin(providerBusinessProfiles, eq(providerBusinessProfiles.providerId, providerPayoutAccounts.providerId))
    .where(eq(providerPayoutAccounts.providerId, providerId))
    .limit(1);
  if (!row) throw notFound('We could not find that rental business.');

  let accountId = row.account.stripeAccountId;
  if (!accountId) {
    const created = await gateway.createConnectedAccount({
      providerId,
      businessName: row.provider.businessName,
      email: row.profile.contactEmail,
      country: row.account.country,
    });
    accountId = created.id;
    await db
      .update(providerPayoutAccounts)
      .set({ stripeAccountId: accountId, status: 'pending' })
      .where(eq(providerPayoutAccounts.providerId, providerId));
  }

  const link = await gateway.createAccountOnboardingLink({
    accountId,
    returnUrl: `${config.appUrl}/provider/payouts`,
    refreshUrl: `${config.appUrl}/provider/payouts`,
  });
  return { url: link.url };
}

export async function getPayoutAccount(db: Database, gateway: PaymentGateway, providerId: string) {
  const [account] = await db
    .select()
    .from(providerPayoutAccounts)
    .where(eq(providerPayoutAccounts.providerId, providerId))
    .limit(1);
  if (!account) throw notFound('We could not find that rental business.');

  // Ask Stripe for the current state where we can, so the dashboard is not
  // stale while a business is part-way through giving their details.
  if (account.stripeAccountId) {
    const live = await gateway.getConnectedAccount(account.stripeAccountId).catch(() => null);
    if (live) {
      const status = live.payoutsEnabled ? 'active' : live.outstanding.length > 0 ? 'pending' : account.status;
      await db
        .update(providerPayoutAccounts)
        .set({ payoutsEnabled: live.payoutsEnabled, outstanding: live.outstanding, status })
        .where(eq(providerPayoutAccounts.providerId, providerId));
      return { status, payoutsEnabled: live.payoutsEnabled, outstanding: live.outstanding, country: account.country };
    }
  }

  return {
    status: account.status,
    payoutsEnabled: account.payoutsEnabled,
    outstanding: account.outstanding,
    country: account.country,
  };
}
