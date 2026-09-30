// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Works out when the hold on a customer's card for their
// security deposit will stop existing, and finds the ones about to.
//
// ---- THE PROBLEM THIS EXISTS FOR ----
//
// A security deposit is not taken. It is HELD: the bank sets the money aside on
// the customer's card, and SXM Rentals never receives it. That is the right shape
// for a deposit, and it has one limitation nobody chose:
//
//   A CARD HOLD LASTS ABOUT SEVEN DAYS. After that the bank drops it, on its own,
//   whether or not the rental is over. Stripe cancels an uncaptured payment at
//   the same point.
//
// So on a ten-day rental, the deposit quietly stops existing on day seven. The
// car is still out. If it comes back damaged on day ten, there is nothing to
// claim against, and the first anybody knows is when the claim fails.
//
// ---- WHAT THIS DOES ABOUT IT, AND WHAT IT DOES NOT ----
//
// It makes the problem VISIBLE before it bites: every held deposit carries the
// day its hold runs out, and the ones running out while the car is still out are
// findable — by staff in the admin panel, and in the daily job's output.
//
// It does NOT renew the hold automatically. Doing that means charging a card
// while nobody is at the keyboard, which needs the customer's agreement to keep
// their card on file, a saved payment method, and somewhere for the renewal to
// fail to — all of which are decisions rather than code. Until then a person
// acts on the warning, which is slower and honest.

import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings, deposits } from '../../db/schema/index.js';

// How long a card hold survives. Banks vary by a day or so either way, and card
// networks allow longer for some kinds of business, but seven is what to plan
// for and what Stripe documents for a manual capture.
export const HOLD_LIFETIME_DAYS = 7;

// ---- WHEN A HOLD MAY BE PLACED AT ALL ----
// A hold lasts about seven days, so one placed when a trip three weeks away is
// booked has gone before the car is collected — and the customer believes a
// deposit is held when nothing is. So a hold may only be placed in the two days
// before pickup (and on the day). The phone app offers it only then; this is
// what stops an older or altered app doing it anyway.
export const DEPOSIT_HOLD_WINDOW_HOURS = 48;

// The moment the window opens for a booking collected at this date and time.
export function holdWindowOpensAt(startDate: string, pickupTime: string): Date {
  const pickup = new Date(`${startDate}T${pickupTime.padEnd(5, '0')}:00Z`);
  return new Date(pickup.getTime() - DEPOSIT_HOLD_WINDOW_HOURS * 60 * 60 * 1000);
}

// The day a hold placed at this moment stops existing. Null when nothing is held.
export function holdExpiresAt(authorizedAt: Date | null | undefined): Date | null {
  if (!authorizedAt) return null;
  return new Date(authorizedAt.getTime() + HOLD_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
}

// True when this hold runs out within the next `withinDays` days. Used to warn
// while there is still time to do something about it.
export function holdExpiringSoon(
  authorizedAt: Date | null | undefined,
  now: Date = new Date(),
  withinDays = 2,
): boolean {
  const expires = holdExpiresAt(authorizedAt);
  if (!expires) return false;
  return expires.getTime() - now.getTime() <= withinDays * 24 * 60 * 60 * 1000;
}

export type ExpiringHold = {
  depositId: string;
  bookingId: string;
  bookingReference: string;
  amountCents: number;
  expiresAt: string;
  // The day the car is due back. The whole problem is this being after the day
  // above.
  rentalEndsOn: string;
};

// Every hold that will run out BEFORE the car is due back. A hold expiring after
// the rental ends is not a problem — that is simply how a deposit ends when
// nothing was claimed.
export async function holdsExpiringBeforeReturn(db: Database, now: Date = new Date()): Promise<ExpiringHold[]> {
  const cutoff = new Date(now.getTime() - (HOLD_LIFETIME_DAYS - 2) * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      depositId: deposits.id,
      bookingId: bookings.id,
      reference: bookings.reference,
      amountCents: deposits.amountCents,
      authorizedAt: deposits.authorizedAt,
      endDate: bookings.endDate,
    })
    .from(deposits)
    .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
    .where(
      and(
        eq(deposits.status, 'held'),
        // Placed long enough ago to be near the end of its life.
        lte(deposits.authorizedAt, cutoff),
        // And the car is still out.
        sql`${bookings.endDate} >= ${now.toISOString().slice(0, 10)}`,
        isNull(bookings.payoutId),
      ),
    );

  return rows
    .map((row) => ({
      depositId: row.depositId,
      bookingId: row.bookingId,
      bookingReference: row.reference,
      amountCents: row.amountCents,
      expiresAt: holdExpiresAt(row.authorizedAt)!.toISOString(),
      rentalEndsOn: row.endDate,
    }))
    // Only the ones where the hold really does run out first. The same day
    // counts: a bank can drop a hold hours before anybody has looked the car
    // over, and the return day is exactly when a claim would be made.
    .filter((hold) => hold.expiresAt.slice(0, 10) <= hold.rentalEndsOn);
}
