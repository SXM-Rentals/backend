// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Turns database rows into the shapes the BUSINESS
// dashboard draws: the private half of a business's own record, its payments
// from SXM Rentals, and how each of its cars is doing.
//
// None of this is ever shown to a customer. The public half of a business — its
// name, rating and description — is built by serializers/vehicles.ts instead.
// Keeping the two apart is what stops a customer screen showing a business's
// earnings by accident.
//
// Every money figure here is the business's OWN share, after commission, with
// the deduction shown beside it rather than hidden.

import type { payouts, providerBusinessProfiles, providers } from '../../db/schema/index.js';

type ProfileRow = typeof providerBusinessProfiles.$inferSelect;
type ProviderRow = typeof providers.$inferSelect;
type PayoutRow = typeof payouts.$inferSelect;

const toAmount = (cents: number) => cents / 100;

// ---- THE PRIVATE HALF OF A BUSINESS'S RECORD ----
export function toBusinessProfile(profile: ProfileRow, provider: ProviderRow) {
  return {
    providerId: profile.providerId,
    legalName: profile.legalName,
    ...(profile.website ? { website: profile.website } : {}),
    registrationStatus: profile.registrationStatus,
    ...(profile.registeredIn ? { registeredIn: profile.registeredIn } : {}),
    ...(profile.registrationNumber ? { registrationNumber: profile.registrationNumber } : {}),
    fleetSizeBand: profile.fleetSizeBand,
    locations: profile.locations,
    operatingSide: profile.operatingSide,
    // THE BUSINESS'S OWN CONTACT DETAILS. PATCH has always accepted all three,
    // and this never returned them — so the profile page could offer to change
    // an email address it could not show. This is the business looking at its
    // own record, which is the one place these belong; nothing a CUSTOMER reads
    // carries them, and nothing a customer reads ever should.
    contactEmail: profile.contactEmail,
    ownerName: profile.ownerName,
    ownerPhone: profile.ownerPhone,
    // The business line, from the public record so the two cannot disagree.
    phone: provider.phone,
    // These two are shown on the public page as well, so they are read from
    // the public record — one source, so the two cannot disagree.
    deliversVehicles: provider.deliversVehicles,
    airportPickup: provider.airportPickup,
    // Where its application stands — waiting, approved or turned down — and,
    // when turned down, staff's reason, so the dashboard can say which and why.
    // isVerified on the public record alone cannot tell waiting from refused.
    verificationStatus: provider.verificationStatus,
    verificationReason: provider.verificationStatus === 'rejected' ? (profile.verificationReason ?? null) : null,
    // Where it is based. Moving sides is the owner's to do (PATCH, with a town).
    side: provider.side,
    town: provider.town,
    apiConnected: profile.apiConnected,
    ...(profile.apiLastSyncedAt ? { apiLastSyncedAt: profile.apiLastSyncedAt.toISOString() } : {}),
  };
}

// ---- ONE PAYMENT FROM SXM RENTALS ----
// `amount` is what reaches the bank; `grossAmount` is what customers paid
// before commission. Both are shown so the deduction is visible.
// A security deposit is never part of a payout.
export function toPayoutRecord(payout: PayoutRow) {
  return {
    id: payout.id,
    reference: payout.reference,
    amount: toAmount(payout.amountCents),
    grossAmount: toAmount(payout.grossCents),
    commission: toAmount(payout.commissionCents),
    bookingCount: payout.bookingCount,
    periodStart: payout.periodStart,
    periodEnd: payout.periodEnd,
    ...(payout.paidOn ? { paidOn: payout.paidOn.toISOString().slice(0, 10) } : {}),
    status: payout.status,
  };
}

// ---- HOW ONE CAR IS DOING ----
// Revenue is the business's share, after commission. Occupancy is the share of
// the days in the period the car was actually out, between 0 and 1.
export function toVehiclePerformance(row: {
  vehicleId: string;
  // Money from rentals that are finished AND paid for: the business's share of
  // what has actually been earned.
  earnedCents: number;
  // Money from rentals that are booked but not yet both of those — still to come,
  // or finished and not paid. Real, and not the same thing.
  bookedCents: number;
  grossEarnedCents: number;
  commissionEarnedCents: number;
  grossBookedCents: number;
  commissionBookedCents: number;
  bookings: number;
  daysOut: number;
  daysInPeriod: number;
  conversations: number;
}) {
  return {
    vehicleId: row.vehicleId,
    // EARNED AND BOOKED, SAID SEPARATELY. One "revenue" figure used to add
    // together rentals that were over and paid, rentals still in the future, and
    // — while payments were switched off — rentals nobody had paid for at all.
    // A business reading it had no way to tell which of its money had arrived.
    revenueEarned: toAmount(row.earnedCents),
    revenueBooked: toAmount(row.bookedCents),
    // Gross, commission and net together (product rule 3): gross less
    // commission is exactly the revenue beside it.
    grossEarned: toAmount(row.grossEarnedCents),
    commissionEarned: toAmount(row.commissionEarnedCents),
    grossBooked: toAmount(row.grossBookedCents),
    commissionBooked: toAmount(row.commissionBookedCents),
    // The old name, kept for one release while the apps move across. It is the
    // two added together, which is what it always was.
    revenue: toAmount(row.earnedCents + row.bookedCents),
    bookings: row.bookings,
    occupancyRate: row.daysInPeriod > 0 ? Math.min(1, row.daysOut / row.daysInPeriod) : 0,
    // How many people asked about this car. Counts only — never the people.
    //
    // It is NOT a conversion rate, and the old pair of names invited one: most
    // bookings never start with a conversation at all, so dividing one by the
    // other came out above 100%.
    conversations: row.conversations,
    bookingsInPeriod: row.bookings,
    // Old names, same release-long grace as revenue above.
    inquiries: row.conversations,
    conversions: row.bookings,
  };
}
