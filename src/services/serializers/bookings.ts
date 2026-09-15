// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Turns a booking's database rows into the two views of it
// the apps show — the CUSTOMER'S (their price breakdown and deposit) and the
// RENTAL BUSINESS'S (who is collecting the car, and the money split three
// ways). Money is stored in cents and handed out in dollars.
//
// THIS FILE UPHOLDS ALL THREE PRODUCT RULES. Each has a test in test/rules/.
//
// 1. A deposit is never revenue: the customer's total comes only from the
//    booking's own money, and the deposit is reported beside it, never in it.
// 2. A business never sees a customer's phone or email: the business view is
//    built from a renter summary that has no contact fields, field by field, so
//    even passing a whole customer record in cannot leak one.
// 3. A business always sees its own share: gross, commission and net are
//    always returned together.

import type { bookingPriceLines, bookings, deposits } from '../../db/schema/index.js';
import type { Booking, DepositStatus, ProviderBooking, VerificationStatus } from '../../types/api.js';

type BookingRow = typeof bookings.$inferSelect;
type PriceLineRow = typeof bookingPriceLines.$inferSelect;
type DepositRow = typeof deposits.$inferSelect;

// What a business is allowed to know about the person renting from them.
// DO NOT add contact details here — see rule 2 above.
export type RenterSummary = {
  firstName: string;
  lastName: string;
  verificationStatus: VerificationStatus;
};

// Cents to dollars: 4550 → 45.5
const toAmount = (cents: number) => cents / 100;

// A booking with no deposit row yet has simply not had one taken.
function depositView(deposit: DepositRow | undefined): { depositAmount: number; depositStatus: DepositStatus } {
  return {
    depositAmount: deposit ? toAmount(deposit.amountCents) : 0,
    depositStatus: deposit?.status ?? 'not_taken',
  };
}

// "Benjamin Jones" → "Benjamin J." — enough to greet the right person.
export function renterDisplayName(firstName: string, lastName: string): string {
  const initial = lastName.trim().charAt(0).toUpperCase();
  return initial ? `${firstName.trim()} ${initial}.` : firstName.trim();
}

// ---- THE CUSTOMER'S VIEW ----
export function toCustomerBooking(booking: BookingRow, lines: PriceLineRow[], deposit: DepositRow | undefined): Booking {
  return {
    id: booking.id,
    reference: booking.reference,
    vehicleId: booking.vehicleId,
    providerId: booking.providerId,
    status: booking.status,
    startDate: booking.startDate,
    endDate: booking.endDate,
    pickupTime: booking.pickupTime,
    returnTime: booking.returnTime,
    collection: booking.collection,
    location: booking.location,
    lines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        label: line.label,
        amount: toAmount(line.amountCents),
        ...(line.note ? { note: line.note } : {}),
      })),
    ...depositView(deposit),
    // From the booking's own money only. The deposit is never added in.
    totalDueToday: toAmount(booking.totalDueTodayCents),
    agreementSigned: booking.agreementSignedAt !== null,
    createdAt: booking.createdAt.toISOString(),
  };
}

// ---- THE RENTAL BUSINESS'S VIEW ----
export function toProviderBooking(
  booking: BookingRow,
  deposit: DepositRow | undefined,
  renter: RenterSummary,
  threadId?: string,
): ProviderBooking {
  return {
    id: booking.id,
    reference: booking.reference,
    vehicleId: booking.vehicleId,
    status: booking.status,
    renterDisplayName: renterDisplayName(renter.firstName, renter.lastName),
    renterVerified: renter.verificationStatus === 'approved',
    ...(threadId ? { threadId } : {}),
    startDate: booking.startDate,
    endDate: booking.endDate,
    pickupTime: booking.pickupTime,
    returnTime: booking.returnTime,
    collection: booking.collection,
    location: booking.location,
    grossAmount: toAmount(booking.grossCents),
    commission: toAmount(booking.commissionCents),
    netAmount: toAmount(booking.payoutCents),
    ...depositView(deposit),
  };
}
