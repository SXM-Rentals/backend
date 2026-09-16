// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the figures behind the staff analytics charts —
// that the bars are bucketed to suit the span asked about, that money is
// counted by when the booking was made, that a cancelled booking is counted but
// brings in nothing, and that security deposits never appear in any total.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, customers, deposits } from '../src/db/schema/index.js';
import { bucketFor } from '../src/services/admin/analytics.js';
import {
  createSignedInStaff,
  createTestContext,
  seedProvider,
  seedVehicle,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let staff: Awaited<ReturnType<typeof createSignedInStaff>>;
let providerId: string;
let vehicleId: string;

const asStaff = () => ({ cookie: staff.cookie, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });

const day = 24 * 60 * 60 * 1000;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

// A booking made on a particular day, for a particular amount.
let reference = 6000;
async function bookingMade(options: { daysAgo: number; grossDollars: number; cancelled?: boolean }) {
  reference += 1;
  const gross = Math.round(options.grossDollars * 100);
  const commission = Math.round(gross * 0.3);
  const [row] = await ctx.db
    .insert(bookings)
    .values({
      reference: `SXM-${reference}`,
      customerId: (await ctx.db.select().from(customers).limit(1))[0]!.id,
      vehicleId,
      providerId,
      status: options.cancelled ? 'cancelled' : 'completed',
      startDate: isoDate(-options.daysAgo),
      endDate: isoDate(-options.daysAgo + 2),
      pickupTime: '10:00',
      returnTime: '10:00',
      collection: 'pickup',
      location: 'Philipsburg',
      grossCents: gross,
      commissionCents: commission,
      payoutCents: gross - commission,
      totalDueTodayCents: gross,
      paymentStatus: options.cancelled ? 'refunded' : 'paid',
      createdAt: new Date(Date.now() - options.daysAgo * day),
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  ctx = await createTestContext();
  staff = await createSignedInStaff(ctx);

  const provider = await seedProvider(ctx.db);
  providerId = provider.id;
  vehicleId = (await seedVehicle(ctx.db, provider.id, { depositAmountCents: 50000 })).id;

  // Somebody to own the bookings.
  await ctx.db.insert(customers).values({
    firstName: 'Aria',
    lastName: 'Duncan',
    email: 'analytics-customer@example.com',
    accountType: 'tourist',
  });
});
afterAll(async () => {
  await ctx.close();
});

describe('choosing how wide a bar is', () => {
  it('follows the span, so the shape of the question stays visible', () => {
    expect(bucketFor(isoDate(-7), isoDate(0))).toBe('day');
    expect(bucketFor(isoDate(-50), isoDate(0))).toBe('week');
    expect(bucketFor(isoDate(-365), isoDate(0))).toBe('month');
    expect(bucketFor(isoDate(-365 * 5), isoDate(0))).toBe('quarter');
    // Past about ten years, quarters would overflow the readable limit too.
    expect(bucketFor(isoDate(-365 * 12), isoDate(0))).toBe('year');
  });

  it('never produces more bars than a chart can show', async () => {
    for (const span of [7, 50, 120, 400, 365 * 3, 365 * 12]) {
      const res = await get(`/admin/analytics?from=${isoDate(-span)}&to=${isoDate(0)}`, asStaff());
      expect(res.statusCode).toBe(200);
      expect(res.json().length).toBeLessThanOrEqual(41);
      expect(res.json().length).toBeGreaterThan(0);
    }
  });
});

describe('the figures themselves', () => {
  it('counts money by when the booking was made, and leaves cancelled ones out of the total', async () => {
    await bookingMade({ daysAgo: 2, grossDollars: 200 });
    await bookingMade({ daysAgo: 2, grossDollars: 150 });
    await bookingMade({ daysAgo: 2, grossDollars: 999, cancelled: true });

    const res = await get(`/admin/analytics?from=${isoDate(-3)}&to=${isoDate(0)}`, asStaff());
    const points = res.json() as { label: string; gmv: number; bookings: number; newUsers: number }[];

    const total = points.reduce((sum, point) => sum + point.gmv, 0);
    const made = points.reduce((sum, point) => sum + point.bookings, 0);
    // The cancelled one is counted as a booking but brought in nothing.
    expect(total).toBe(350);
    expect(made).toBe(3);
  });

  it('never counts a security deposit as money taken', async () => {
    const booking = await bookingMade({ daysAgo: 1, grossDollars: 100 });
    await ctx.db.insert(deposits).values({ bookingId: booking.id, amountCents: 50000, status: 'held' });

    const points = (await get(`/admin/analytics?from=${isoDate(-1)}&to=${isoDate(0)}`, asStaff())).json() as {
      gmv: number;
    }[];
    const total = points.reduce((sum, point) => sum + point.gmv, 0);

    // $100 for the rental. The $500 held on the card is not ours and is not here.
    expect(total).toBe(100);
    expect(total).toBeLessThan(500);
  });

  it('counts people who signed up in the period', async () => {
    const points = (await get(`/admin/analytics?from=${isoDate(-2)}&to=${isoDate(0)}`, asStaff())).json() as {
      newUsers: number;
    }[];
    // The staff member's own customer records were made during this test run.
    expect(points.reduce((sum, point) => sum + point.newUsers, 0)).toBeGreaterThan(0);
  });

  it('gives the last few whole months when asked that way', async () => {
    const res = await get('/admin/analytics?months=6', asStaff());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(6);
    // Labels read like "Oct 26".
    expect(res.json()[0].label).toMatch(/^[A-Z][a-z]{2} \d{2}$/);
  });

  it('refuses a range that runs backwards', async () => {
    const res = await get(`/admin/analytics?from=${isoDate(0)}&to=${isoDate(-30)}`, asStaff());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_range');
  });
});

describe('who may see it', () => {
  it('is staff only', async () => {
    expect((await get('/admin/analytics?months=3')).statusCode).toBe(401);
    expect((await get('/admin/analytics?months=3', { cookie: 'sxm_admin=not-a-real-session' })).statusCode).toBe(401);
  });
});
