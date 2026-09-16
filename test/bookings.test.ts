// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the price of a rental and the making of a booking:
// that the sums are right, that the deposit stays outside the total, that the
// same car cannot be booked twice for the same days, that the rules about
// minimum days and dates in the past hold, and that one customer can never see
// or cancel another's booking.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, deposits } from '../src/db/schema/index.js';
import {
  WEB_ORIGIN,
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedProvider,
  seedVehicle,
  signInMobile,
  uniqueIp,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let vehicleId: string;
let token: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = await seedProvider(ctx.db);
  // $65 a day, $390 a week, $25 delivery, $500 deposit, 2 to 30 days.
  const vehicle = await seedVehicle(ctx.db, provider.id, {
    dailyRateCents: 6500,
    weeklyRateCents: 39000,
    deliveryAvailable: true,
    deliveryFeeCents: 2500,
    depositAmountCents: 50000,
    minimumDays: 2,
    maximumDays: 30,
  });
  vehicleId = vehicle.id;

  const account = await createVerifiedAccount(ctx);
  token = await signInMobile(ctx, account.email, account.password);
});
afterAll(async () => {
  await ctx.close();
});

const asCustomer = (bearer = token) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });

describe('what a rental costs', () => {
  it('adds up the rental and the 5% service fee, and keeps the deposit outside the total', async () => {
    const res = await post('/bookings/quote', { vehicleId, startDate: dateIn(20), endDate: dateIn(23) });
    expect(res.statusCode).toBe(200);
    const quote = res.json();

    expect(quote.days).toBe(3);
    expect(quote.lines).toEqual([
      { label: 'Rental (3 days x $65)', amount: 195 },
      { label: 'Service fee', amount: 9.75 },
    ]);
    expect(quote.totalDueToday).toBe(204.75);
    // Beside the total, never inside it.
    expect(quote.depositAmount).toBe(500);
    expect(quote.lines.reduce((sum: number, l: { amount: number }) => sum + l.amount, 0)).toBe(quote.totalDueToday);
    expect(quote.available).toBe(true);
  });

  it('charges whole weeks at the weekly price, and never charges for delivery', async () => {
    const res = await post('/bookings/quote', {
      vehicleId,
      startDate: dateIn(40),
      endDate: dateIn(49),
      collection: 'delivery',
    });
    const quote = res.json();
    // 9 days = one week at $390 plus 2 days at $65, then the fee. Delivery was
    // asked for and adds nothing: there is no delivery line at all.
    expect(quote.lines.map((l: { label: string }) => l.label)).toEqual([
      'Rental (1 week x $390)',
      'Rental (2 days x $65)',
      'Service fee',
    ]);
    // $520 rental + $26 fee (5% of the rental). Nothing for delivery.
    expect(quote.lines.find((l: { label: string }) => l.label === 'Service fee').amount).toBe(26);
    expect(quote.totalDueToday).toBe(546);
  });
});

describe('making a booking', () => {
  it('records the booking, its price lines and a deposit of its own', async () => {
    const res = await post(
      '/bookings',
      { vehicleId, startDate: dateIn(60), endDate: dateIn(63), pickupTime: '09:30', returnTime: '11:00' },
      asCustomer(),
    );
    expect(res.statusCode).toBe(201);
    const booking = res.json();

    expect(booking).toMatchObject({
      vehicleId,
      status: 'upcoming',
      startDate: dateIn(60),
      endDate: dateIn(63),
      pickupTime: '09:30',
      collection: 'pickup',
      totalDueToday: 204.75,
      depositAmount: 500,
      depositStatus: 'not_taken',
      agreementSigned: false,
    });
    expect(booking.reference).toMatch(/^SXM-\d{4}$/);

    // What the business is owed, in the database: 30% to SXM Rentals, and the
    // three figures always add up.
    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.grossCents).toBe(20475);
    expect(row!.commissionCents).toBe(6143);
    expect(row!.payoutCents).toBe(14332);
    expect(row!.payoutCents + row!.commissionCents).toBe(row!.grossCents);

    // The deposit is a row of its own, not a column on the booking.
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));
    expect(deposit).toMatchObject({ amountCents: 50000, status: 'not_taken' });
  });

  it('refuses a second booking of the same car for overlapping days', async () => {
    const first = await post(
      '/bookings',
      { vehicleId, startDate: dateIn(80), endDate: dateIn(84) },
      asCustomer(),
    );
    expect(first.statusCode).toBe(201);

    const clash = await post(
      '/bookings',
      { vehicleId, startDate: dateIn(82), endDate: dateIn(86) },
      asCustomer(),
    );
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('vehicle_unavailable');

    // The day the car comes back is free for the next person.
    const after = await post(
      '/bookings',
      { vehicleId, startDate: dateIn(84), endDate: dateIn(86) },
      asCustomer(),
    );
    expect(after.statusCode).toBe(201);
  });

  it('refuses dates that break the rules, in words a screen can show', async () => {
    const cases = [
      [{ startDate: dateIn(-2), endDate: dateIn(2) }, 'invalid_dates'],
      [{ startDate: dateIn(5), endDate: dateIn(5) }, 'invalid_dates'],
      [{ startDate: dateIn(5), endDate: dateIn(6) }, 'below_minimum_days'],
      [{ startDate: dateIn(5), endDate: dateIn(40) }, 'above_maximum_days'],
    ] as const;

    for (const [dates, code] of cases) {
      const res = await post('/bookings', { vehicleId, ...dates }, asCustomer());
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(code);
    }
  });

  it('refuses delivery for a car that is collection only', async () => {
    const provider = await seedProvider(ctx.db);
    const collectOnly = await seedVehicle(ctx.db, provider.id, { deliveryAvailable: false });
    const res = await post(
      '/bookings',
      { vehicleId: collectOnly.id, startDate: dateIn(100), endDate: dateIn(103), collection: 'delivery' },
      asCustomer(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('delivery_unavailable');
  });

  it('will not book anything for somebody who is not signed in', async () => {
    const res = await post('/bookings', { vehicleId, startDate: dateIn(120), endDate: dateIn(123) });
    expect(res.statusCode).toBe(401);
  });
});

describe('your own bookings', () => {
  it('lists them, opens one, and cancels one that has not started', async () => {
    const created = (
      await post('/bookings', { vehicleId, startDate: dateIn(140), endDate: dateIn(143) }, asCustomer())
    ).json();

    const list = await get('/bookings', asCustomer());
    expect(list.statusCode).toBe(200);
    expect(list.json().some((b: { id: string }) => b.id === created.id)).toBe(true);

    const one = await get(`/bookings/${created.id}`, asCustomer());
    expect(one.json().reference).toBe(created.reference);

    const cancelled = await post(`/bookings/${created.id}/cancel`, {}, asCustomer());
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    // A deposit that was never taken stops being expected.
    expect(cancelled.json().depositStatus).toBe('released');

    // Cancelling twice is refused, and the dates are free again.
    expect((await post(`/bookings/${created.id}/cancel`, {}, asCustomer())).statusCode).toBe(409);
    const rebooked = await post('/bookings', { vehicleId, startDate: dateIn(140), endDate: dateIn(143) }, asCustomer());
    expect(rebooked.statusCode).toBe(201);
  });

  it("answers 'not found' for somebody else's booking, and never cancels it", async () => {
    const other = await createVerifiedAccount(ctx);
    const otherToken = await signInMobile(ctx, other.email, other.password);
    const theirs = (
      await post('/bookings', { vehicleId, startDate: dateIn(160), endDate: dateIn(163) }, asCustomer(otherToken))
    ).json();

    expect((await get(`/bookings/${theirs.id}`, asCustomer())).statusCode).toBe(404);
    expect((await post(`/bookings/${theirs.id}/cancel`, {}, asCustomer())).statusCode).toBe(404);
    expect((await get('/bookings', asCustomer())).json().some((b: { id: string }) => b.id === theirs.id)).toBe(false);

    // Still theirs, still upcoming.
    expect((await get(`/bookings/${theirs.id}`, asCustomer(otherToken))).json().status).toBe('upcoming');
  });
});
