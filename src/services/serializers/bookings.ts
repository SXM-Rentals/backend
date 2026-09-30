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
import type { Booking, DepositStatus, ProviderBooking, VerificationStatus, CarSummary } from '../../types/api.js';

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

// What a booking needs besides its own row, gathered once for a whole list.
export type BookingContext = { vehicle: CarSummary | null; providerName: string };

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
export function toCustomerBooking(
  booking: BookingRow,
  lines: PriceLineRow[],
  deposit: DepositRow | undefined,
  // Loaded in one go by services/summaries for the whole list, never per row.
  context: BookingContext,
): Booking {
  return {
    id: booking.id,
    reference: booking.reference,
    vehicleId: booking.vehicleId,
    providerId: booking.providerId,
    vehicle: context.vehicle,
    providerName: context.providerName,
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
    // Where paying for it has got to: "authorized" means not paid yet, "paid"
    // and "refunded" mean what they say, and "failed" means the last attempt
    // did not go through — so the app knows whether to offer "Pay for this".
    paymentStatus: booking.paymentStatus,
    agreementSigned: booking.agreementSignedAt !== null,
    createdAt: booking.createdAt.toISOString(),
  };
}

// ---- THE RENTAL BUSINESS'S VIEW ----
export function toProviderBooking(
  booking: BookingRow,
  deposit: DepositRow | undefined,
  renter: RenterSummary,
  // A business needs the car named too — its own fleet, but a list of
  // references is not a list anybody can read. It does not need its own name.
  vehicle: CarSummary | null,
  threadId?: string,
): ProviderBooking {
  return {
    id: booking.id,
    reference: booking.reference,
    vehicleId: booking.vehicleId,
    vehicle,
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
    // A CANCELLED BOOKING PAYS NOBODY. The figures stay on the row — they are
    // what it would have been worth, and the ledger needs them — but reporting
    // them here told a business "you receive $210" for money that is never
    // coming. Zero is the true answer, and anything that adds these up gets the
    // right total without having to know about cancellations.
    ...(booking.status === 'cancelled'
      ? { grossAmount: 0, commission: 0, netAmount: 0 }
      : {
          grossAmount: toAmount(booking.grossCents),
          commission: toAmount(booking.commissionCents),
          netAmount: toAmount(booking.payoutCents),
        }),
    ...depositView(deposit),
  };
}
