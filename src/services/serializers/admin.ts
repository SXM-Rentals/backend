// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Turns database rows into the shapes the STAFF admin
// panel draws. These are the only responses in the whole backend that do carry
// a customer's contact details — handling a support call is exactly the job
// that panel exists for — which is why they are built here, apart from every
// other serializer, and are only ever reachable behind the staff sign-in.
//
// Money is stored in cents and handed out in dollars. Security deposits are
// reported separately from revenue everywhere they appear.

import type { bookings, customers, deposits, disputes, providers, refundRequests, vehicles } from '../../db/schema/index.js';

type CustomerRow = typeof customers.$inferSelect;
type ProviderRow = typeof providers.$inferSelect;
type VehicleRow = typeof vehicles.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;
type DepositRow = typeof deposits.$inferSelect;
type RefundRow = typeof refundRequests.$inferSelect;
type DisputeRow = typeof disputes.$inferSelect;

const toAmount = (cents: number) => cents / 100;

// ---- A CUSTOMER, AS STAFF SEE THEM ----
export function toAdminUser(
  customer: CustomerRow,
  extras: { points: number; bookingCount: number; lifetimeSpendCents: number },
) {
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone ?? '',
    accountType: customer.accountType,
    verification: {
      status: customer.verificationStatus,
      selfieDone: customer.selfieDone,
      licenseDone: customer.licenseDone,
      identityDocDone: customer.identityDocDone,
      ...(customer.verificationReason ? { reason: customer.verificationReason } : {}),
      ...(customer.verificationSubmittedAt ? { submittedAt: customer.verificationSubmittedAt.toISOString() } : {}),
    },
    isIslander: customer.isIslander,
    memberSince: customer.createdAt.toISOString(),
    points: extras.points,
    tier: tierForPoints(extras.points),
    bookingCount: extras.bookingCount,
    lifetimeSpend: toAmount(extras.lifetimeSpendCents),
    lastActiveAt: customer.updatedAt.toISOString(),
    // Set when an account is closed. The row stays so the audit trail still
    // points at something that exists.
    ...(customer.deletedAt ? { deletedAt: customer.deletedAt.toISOString() } : {}),
  };
}

// The tier thresholds from the overview document. Points are the sum of the
// rewards ledger, so a tier is worked out rather than stored and left to drift.
export function tierForPoints(points: number): 'explorer' | 'traveler' | 'vip' | 'elite' {
  if (points >= 10_000) return 'elite';
  if (points >= 5_000) return 'vip';
  if (points >= 1_500) return 'traveler';
  return 'explorer';
}

// ---- A RENTAL BUSINESS, AS STAFF SEE IT ----
export function toAdminProvider(
  provider: ProviderRow,
  profile: {
    legalName: string;
    contactEmail: string;
    ownerName: string;
    ownerPhone: string;
    website: string | null;
    registrationNumber: string | null;
  } | null,
  extras: { vehicleCount: number; bookingCount: number; grossVolumeCents: number },
) {
  return {
    id: provider.id,
    businessName: provider.businessName,
    side: provider.side,
    town: provider.town,
    rating: provider.rating,
    reviewCount: provider.reviewCount,
    isVerified: provider.isVerified,
    respondsIn: provider.respondsIn,
    phone: provider.phone,
    description: provider.description,
    deliversVehicles: provider.deliversVehicles,
    airportPickup: provider.airportPickup,
    memberSince: provider.createdAt.toISOString(),
    verificationStatus: provider.verificationStatus,
    legalName: profile?.legalName ?? '',
    contactEmail: profile?.contactEmail ?? '',
    // The owner's own mobile, as opposed to the business line above. A personal
    // number belonging to a named individual: think twice before exporting it.
    ownerName: profile?.ownerName ?? '',
    ownerPhone: profile?.ownerPhone ?? '',
    ...(profile?.website ? { website: profile.website } : {}),
    ...(profile?.registrationNumber ? { registrationNumber: profile.registrationNumber } : {}),
    vehicleCount: extras.vehicleCount,
    bookingCount: extras.bookingCount,
    grossVolume: toAmount(extras.grossVolumeCents),
  };
}

// ---- A VEHICLE, AS STAFF SEE IT ----
export function toAdminVehicle(vehicle: VehicleRow, providerName: string) {
  return {
    id: vehicle.id,
    reference: vehicle.reference,
    providerId: vehicle.providerId,
    providerName,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    vehicleClass: vehicle.vehicleClass,
    dailyRate: toAmount(vehicle.dailyRateCents),
    side: vehicle.side,
    listingStatus: vehicle.listingStatus,
  };
}

// ---- A BOOKING, AS STAFF SEE IT ----
// The customer AND the business on one row, which is the whole reason this
// view exists separately from the other two.
export function toAdminBooking(
  booking: BookingRow,
  names: { customerName: string; providerName: string; vehicleLabel: string },
  deposit: DepositRow | undefined,
  messageCount = 0,
) {
  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    customerId: booking.customerId,
    customerName: names.customerName,
    providerId: booking.providerId,
    providerName: names.providerName,
    vehicleLabel: names.vehicleLabel,
    startDate: booking.startDate,
    endDate: booking.endDate,
    // The money, split three ways. Gross is always payout plus commission.
    gross: toAmount(booking.grossCents),
    commission: toAmount(booking.commissionCents),
    payout: toAmount(booking.payoutCents),
    // Held against the customer's card. Never part of gross.
    depositAmount: deposit ? toAmount(deposit.amountCents) : 0,
    depositStatus: deposit?.status ?? 'not_taken',
    paymentStatus: booking.paymentStatus,
    agreementSigned: booking.agreementSignedAt !== null,
    messageCount,
    createdAt: booking.createdAt.toISOString(),
  };
}

// ---- A DEPOSIT THROUGH ITS LIFE ----
// Ring-fenced from revenue at every step: the customer's money being held, not
// the platform's being earned.
export function toDepositLedgerEntry(
  deposit: DepositRow,
  names: { bookingRef: string; customerName: string; providerName: string },
) {
  return {
    id: deposit.id,
    bookingRef: names.bookingRef,
    customerName: names.customerName,
    providerName: names.providerName,
    amount: toAmount(deposit.amountCents),
    status: deposit.status,
    authorizedAt: deposit.authorizedAt?.toISOString() ?? null,
    ...(deposit.releasedAt ? { releasedAt: deposit.releasedAt.toISOString() } : {}),
    ...(deposit.claimedAt ? { claimedAt: deposit.claimedAt.toISOString() } : {}),
    // Required whenever a deposit is kept rather than returned.
    ...(deposit.claimReason ? { claimReason: deposit.claimReason } : {}),
    ...(deposit.claimedAmountCents ? { claimedAmount: toAmount(deposit.claimedAmountCents) } : {}),
  };
}

// ---- A REFUND REQUEST ----
export function toRefundRequest(
  refund: RefundRow,
  names: { bookingRef: string; customerName: string; providerName: string },
  decidedByName: string | null,
) {
  return {
    id: refund.id,
    bookingRef: names.bookingRef,
    customerName: names.customerName,
    providerName: names.providerName,
    amount: toAmount(refund.amountCents),
    requestedAt: refund.requestedAt.toISOString(),
    reasonGiven: refund.reasonGiven,
    status: refund.status,
    ...(decidedByName ? { decidedBy: decidedByName } : {}),
    ...(refund.decidedAt ? { decidedAt: refund.decidedAt.toISOString() } : {}),
    ...(refund.decisionReason ? { decisionReason: refund.decisionReason } : {}),
  };
}

// ---- A DISPUTE ----
export function toDisputeCase(
  dispute: DisputeRow,
  names: { bookingRef: string; customerName: string; providerName: string },
  assignedToName: string | null,
) {
  return {
    id: dispute.id,
    reference: dispute.reference,
    bookingRef: names.bookingRef,
    openedAt: dispute.openedAt.toISOString(),
    openedBy: dispute.openedBy,
    customerName: names.customerName,
    providerName: names.providerName,
    subject: dispute.subject,
    detail: dispute.detail,
    amountAtStake: toAmount(dispute.amountAtStakeCents),
    status: dispute.status,
    // Unassigned is a real state and looks like one: an unowned dispute is the
    // thing most likely to be forgotten about.
    ...(dispute.assignedToStaffId ? { assignedToId: dispute.assignedToStaffId } : {}),
    ...(assignedToName ? { assignedToName } : {}),
    ...(dispute.resolutionNotes ? { resolutionNotes: dispute.resolutionNotes } : {}),
    ...(dispute.resolvedAt ? { resolvedAt: dispute.resolvedAt.toISOString() } : {}),
  };
}
