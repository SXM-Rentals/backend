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
    // These two are shown on the public page as well, so they are read from
    // the public record — one source, so the two cannot disagree.
    deliversVehicles: provider.deliversVehicles,
    airportPickup: provider.airportPickup,
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
  revenueCents: number;
  bookings: number;
  daysOut: number;
  daysInPeriod: number;
  inquiries: number;
}) {
  return {
    vehicleId: row.vehicleId,
    revenue: toAmount(row.revenueCents),
    bookings: row.bookings,
    occupancyRate: row.daysInPeriod > 0 ? Math.min(1, row.daysOut / row.daysInPeriod) : 0,
    // How many people asked about this car, and how many of those booked.
    // Counts only — never the people themselves.
    inquiries: row.inquiries,
    conversions: row.bookings,
  };
}
