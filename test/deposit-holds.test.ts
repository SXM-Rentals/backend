// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the warning that a deposit hold is about to stop
// existing while the car is still out.
//
// A security deposit is held on the customer's card rather than taken, which is
// the right shape for it and has one limitation nobody chose: a card hold lasts
// about seven days, and then the bank drops it whatever the rental is doing. On a
// ten-day rental the deposit quietly disappears on day seven, and if the car came
// back damaged on day ten the first anybody knew was a claim that failed.
//
// Nothing here renews a hold — that means charging a card with nobody at the
// keyboard, which needs the customer's agreement to keep it on file. What it does
// is make the problem findable while there is still time to act on it.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, deposits } from '../src/db/schema/index.js';
import {
  HOLD_LIFETIME_DAYS,
  holdExpiresAt,
  holdExpiringSoon,
  holdsExpiringBeforeReturn,
} from '../src/services/payments/holds.js';
import {
  createSignedInStaff,
  createTestContext,
  dateIn,
  seedBooking,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// A held deposit on a booking whose car is due back on a given day.
async function heldDeposit(options: { authorisedDaysAgo: number; carDueBackInDays: number }) {
  const { booking } = await seedBooking(ctx.db);
  await ctx.db
    .update(bookings)
    .set({ status: 'active', startDate: dateIn(-2), endDate: dateIn(options.carDueBackInDays) })
    .where(eq(bookings.id, booking.id));
  await ctx.db.insert(deposits).values({
    bookingId: booking.id,
    amountCents: 50_000,
    status: 'held',
    authorizedAt: daysAgo(options.authorisedDaysAgo),
    stripePaymentIntentId: `pi_hold_${booking.id.slice(0, 8)}`,
  });
  return booking;
}

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('when a hold runs out', () => {
  it('is seven days after it was placed, and nothing when none was', () => {
    const placed = new Date('2026-10-01T12:00:00Z');
    expect(holdExpiresAt(placed)?.toISOString().slice(0, 10)).toBe('2026-10-08');
    expect(HOLD_LIFETIME_DAYS).toBe(7);
    // A deposit never taken has nothing to run out.
    expect(holdExpiresAt(null)).toBeNull();
    expect(holdExpiringSoon(null)).toBe(false);
  });

  it('counts as soon when it has two days left', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    // Placed six days ago: one day left.
    expect(holdExpiringSoon(new Date('2026-10-02T12:00:00Z'), now)).toBe(true);
    // Placed yesterday: six days left.
    expect(holdExpiringSoon(new Date('2026-10-07T12:00:00Z'), now)).toBe(false);
  });
});

describe('finding the holds that matter', () => {
  it('warns about a hold that ends before the car is due back', async () => {
    // Placed six days ago, car out for another four: the hold dies on day seven,
    // three days before the car comes back.
    const booking = await heldDeposit({ authorisedDaysAgo: 6, carDueBackInDays: 4 });

    const expiring = await holdsExpiringBeforeReturn(ctx.db);
    const found = expiring.find((hold) => hold.bookingId === booking.id);
    expect(found).toBeTruthy();
    expect(found?.amountCents).toBe(50_000);
    // It says both dates, because the gap between them is the problem.
    expect(found?.expiresAt.slice(0, 10) <= found!.rentalEndsOn).toBe(true);
  });

  it('says nothing about a hold that outlives the rental', async () => {
    // Placed six days ago, so it ends tomorrow; the car is due back today. The
    // hold outlasts the rental, which is how a deposit is meant to end.
    //
    // A hold ending on the SAME day the car comes back does count as at risk:
    // the bank can drop it hours before anybody has looked the car over.
    const booking = await heldDeposit({ authorisedDaysAgo: 6, carDueBackInDays: 0 });

    const expiring = await holdsExpiringBeforeReturn(ctx.db);
    expect(expiring.some((hold) => hold.bookingId === booking.id)).toBe(false);
  });

  it('says nothing about a hold placed this morning', async () => {
    const booking = await heldDeposit({ authorisedDaysAgo: 0, carDueBackInDays: 10 });

    const expiring = await holdsExpiringBeforeReturn(ctx.db);
    // It will matter in five days. Warning now, every day until then, is how a
    // warning stops being read.
    expect(expiring.some((hold) => hold.bookingId === booking.id)).toBe(false);
  });

  it('says nothing about a deposit that was never held', async () => {
    const { booking } = await seedBooking(ctx.db);
    await ctx.db
      .update(bookings)
      .set({ status: 'active', endDate: dateIn(6) })
      .where(eq(bookings.id, booking.id));
    await ctx.db.insert(deposits).values({ bookingId: booking.id, amountCents: 50_000, status: 'not_taken' });

    const expiring = await holdsExpiringBeforeReturn(ctx.db);
    expect(expiring.some((hold) => hold.bookingId === booking.id)).toBe(false);
  });
});

describe('what staff see', () => {
  it('carries the expiry date and the warning on every held deposit', async () => {
    const staff = await createSignedInStaff(ctx);
    await heldDeposit({ authorisedDaysAgo: 6, carDueBackInDays: 5 });

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/deposits?status=held',
      headers: { cookie: staff.cookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
    });
    expect(listed.statusCode).toBe(200);

    const rows = listed.json() as { holdExpiresAt: string | null; holdExpiringSoon: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    // Additive: the existing fields are untouched, so the panel keeps working
    // exactly as it does today and can show these when it is ready.
    expect(rows.every((row) => 'holdExpiresAt' in row && 'holdExpiringSoon' in row)).toBe(true);
    expect(rows.some((row) => row.holdExpiringSoon)).toBe(true);
  });
});
