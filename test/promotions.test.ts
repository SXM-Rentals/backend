// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests a rental business's own discount codes — making
// them, pausing and deleting them, and a customer using one when they book.
//
// The tests that matter most are about money: the discount comes off the rental
// lines only, as a line of its own; the service fee and the commission are then
// worked out on what the renter actually pays, so the business and SXM Rentals
// share the cost; the lines always add up; and a code that no longer applies at
// booking refuses the booking rather than quietly charging the full price.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings } from '../src/db/schema/index.js';
import {
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let ownerToken: string;
let rivalToken: string;
let customerToken: string;
let vehicleId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: auth(token), remoteAddress: uniqueIp(), ...(payload ? { payload } : {}) });

const application = (businessName: string) => ({
  businessName,
  legalName: `${businessName} N.V.`,
  contactEmail: `hello@${businessName.toLowerCase().replace(/\W/g, '')}.sx`,
  ownerName: 'Marie Richardson',
  ownerPhone: '+1 721 555 0188',
  town: 'Simpson Bay',
  side: 'dutch' as const,
  operatingSide: 'dutch' as const,
});

const makeCode = (body: object, token = ownerToken) => send('POST', '/providers/me/promotions', token, body);
const quote = (startsIn: number, days: number, promoCode?: string) =>
  send('POST', '/bookings/quote', customerToken, {
    vehicleId,
    startDate: dateIn(startsIn),
    endDate: dateIn(startsIn + days),
    ...(promoCode ? { promoCode } : {}),
  });
const book = (startsIn: number, days: number, promoCode?: string) =>
  send('POST', '/bookings', customerToken, {
    vehicleId,
    startDate: dateIn(startsIn),
    endDate: dateIn(startsIn + days),
    ...(promoCode ? { promoCode } : {}),
  });
const cents = (amount: number) => Math.round(amount * 100);
const lineTotal = (lines: { amount: number }[]) => lines.reduce((sum, line) => sum + cents(line.amount), 0);

beforeAll(async () => {
  ctx = await createTestContext({ env: { FEATURES: 'promotions,dateChanges' } });
  const owner = await createVerifiedAccount(ctx);
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  const providerId = (await send('POST', '/providers/apply', ownerToken, application('Discount Cars'))).json().providerId;
  // $65 a day, no weekly rate: 3 days is $195 of rental.
  vehicleId = (await seedVehicle(ctx.db, providerId, { dailyRateCents: 6500 })).id;

  const rival = await createVerifiedAccount(ctx);
  rivalToken = await signInMobile(ctx, rival.email, rival.password);
  await send('POST', '/providers/apply', rivalToken, application('Rival Discounts'));

  const customer = await createVerifiedAccount(ctx);
  customerToken = await signInMobile(ctx, customer.email, customer.password);
});
afterAll(async () => {
  await ctx.close();
});

describe('making a code', () => {
  it('stores it in capitals, and refuses the same code twice in one business', async () => {
    const made = await makeCode({ code: 'summer10', percentOff: 10 });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      code: 'SUMMER10',
      percentOff: 10,
      minDays: null,
      startsOn: null,
      endsOn: null,
      maxUses: null,
      timesUsed: 0,
      active: true,
    });
    const again = await makeCode({ code: 'Summer10', percentOff: 15 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('code_taken');

    // Another business may have its own SUMMER10.
    expect((await makeCode({ code: 'SUMMER10', percentOff: 20 }, rivalToken)).statusCode).toBe(201);
  });

  it('keeps to 5% to 50%, 4 to 16 letters and digits, and dates in order', async () => {
    expect((await makeCode({ code: 'HALFOFF', percentOff: 60 })).statusCode).toBe(400);
    expect((await makeCode({ code: 'TINY', percentOff: 4 })).statusCode).toBe(400);
    expect((await makeCode({ code: 'AB', percentOff: 10 })).statusCode).toBe(400);
    expect((await makeCode({ code: 'NO-DASH', percentOff: 10 })).statusCode).toBe(400);
    const backwards = await makeCode({ code: 'BACKWARDS', percentOff: 10, startsOn: dateIn(20), endsOn: dateIn(10) });
    expect(backwards.json().error.code).toBe('invalid_dates');
  });
});

describe('using a code in a quote', () => {
  it('takes the percentage off the rental as its own line, with the fee worked out after it', async () => {
    const plain = (await quote(10, 3)).json();
    const discounted = (await quote(10, 3, 'summer10')).json();

    expect(discounted.promo).toEqual({ code: 'SUMMER10', applied: true, message: null });
    expect(discounted.lines).toContainEqual({ label: 'Promotion SUMMER10', amount: -19.5 });
    // Service fee on the discounted rental: 5% of $175.50.
    const fee = discounted.lines.find((line: { label: string }) => line.label === 'Service fee');
    expect(cents(fee.amount)).toBe(Math.round((19500 - 1950) * 0.05));
    expect(lineTotal(discounted.lines)).toBe(cents(discounted.totalDueToday));
    expect(discounted.totalDueToday).toBeLessThan(plain.totalDueToday);
    // The deposit is never discounted.
    expect(discounted.depositAmount).toBe(plain.depositAmount);
  });

  it('never fails the quote for a bad code, and says why it did not apply', async () => {
    const plain = (await quote(10, 3)).json();
    const cases: [string, string][] = [];

    await makeCode({ code: 'PAUSED10', percentOff: 10 }).then(async (res) =>
      send('PATCH', `/providers/me/promotions/${res.json().id}`, ownerToken, { active: false }),
    );
    await makeCode({ code: 'LONGSTAY', percentOff: 10, minDays: 5 });
    await makeCode({ code: 'LATER10', percentOff: 10, startsOn: dateIn(60) });
    await makeCode({ code: 'OVER10', percentOff: 10, endsOn: dateIn(5) });
    await makeCode({ code: 'RIVALONLY', percentOff: 10 }, rivalToken);

    cases.push(
      ['NOSUCHCODE', 'We do not recognise this code.'],
      ['PAUSED10', 'This code is paused at the moment.'],
      ['LONGSTAY', 'This code needs a rental of at least 5 days.'],
      ['LATER10', `This code works for pickups from ${dateIn(60)}.`],
      ['OVER10', 'This code has expired.'],
      ['RIVALONLY', 'This code is not for this car.'],
    );
    for (const [code, message] of cases) {
      const res = await quote(10, 3, code);
      expect(res.statusCode).toBe(200);
      expect(res.json().promo).toEqual({ code, applied: false, message });
      expect(res.json().totalDueToday).toBe(plain.totalDueToday);
    }
  });
});

describe('booking with a code', () => {
  it('books the discounted price, and the business sees gross, commission and net after it', async () => {
    const made = await book(20, 3, 'SUMMER10');
    expect(made.statusCode).toBe(201);
    const booking = made.json();
    expect(booking.lines).toContainEqual({ label: 'Promotion SUMMER10', amount: -19.5 });
    expect(lineTotal(booking.lines)).toBe(cents(booking.totalDueToday));

    const theirs = (await send('GET', `/providers/me/bookings/${booking.id}`, ownerToken)).json();
    expect(theirs.grossAmount).toBe(booking.totalDueToday);
    expect(cents(theirs.grossAmount)).toBe(cents(theirs.commission) + cents(theirs.netAmount));

    const [listed] = (await send('GET', '/providers/me/promotions', ownerToken))
      .json()
      .filter((promotion: { code: string }) => promotion.code === 'SUMMER10');
    expect(listed.timesUsed).toBe(1);
  });

  it('refuses a code that does not apply, rather than booking at full price', async () => {
    const refused = await book(30, 3, 'LONGSTAY');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'promo_not_applicable',
      message: 'This code needs a rental of at least 5 days.',
    });
  });

  it('counts uses as bookings, and a cancelled booking gives its use back', async () => {
    await makeCode({ code: 'ONCEONLY', percentOff: 25, maxUses: 1 });
    const first = (await book(40, 2, 'ONCEONLY')).json();
    const second = await book(45, 2, 'ONCEONLY');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toBe('This code has been used up.');

    await send('POST', `/bookings/${first.id}/cancel`, customerToken, {});
    expect((await book(45, 2, 'ONCEONLY')).statusCode).toBe(201);
  });
});

describe('changing the dates of a discounted booking', () => {
  it('keeps the discount at the new dates, while the rental is still long enough for it', async () => {
    await makeCode({ code: 'THREEPLUS', percentOff: 20, minDays: 3 });
    const booking = (await book(70, 4, 'THREEPLUS')).json();

    const longer = (
      await send('POST', `/bookings/${booking.id}/date-changes/quote`, customerToken, {
        startDate: booking.startDate,
        endDate: dateIn(76),
      })
    ).json();
    // Six days at $65 is $390 of rental; 20% off is $78.
    expect(longer.lines).toContainEqual({ label: 'Promotion THREEPLUS', amount: -78 });

    const tooShort = (
      await send('POST', `/bookings/${booking.id}/date-changes/quote`, customerToken, {
        startDate: booking.startDate,
        endDate: dateIn(72),
      })
    ).json();
    expect(tooShort.lines.map((line: { label: string }) => line.label)).not.toContain('Promotion THREEPLUS');
  });
});

describe('deleting and pausing', () => {
  it('deletes a code, which stays on the bookings that used it', async () => {
    const made = (await makeCode({ code: 'GONESOON', percentOff: 10 })).json();
    const booking = (await book(50, 3, 'GONESOON')).json();

    expect((await send('DELETE', `/providers/me/promotions/${made.id}`, ownerToken)).statusCode).toBe(204);
    const codes = (await send('GET', '/providers/me/promotions', ownerToken)).json();
    expect(codes.map((promotion: { code: string }) => promotion.code)).not.toContain('GONESOON');

    const kept = (await send('GET', `/bookings/${booking.id}`, customerToken)).json();
    expect(kept.lines).toContainEqual({ label: 'Promotion GONESOON', amount: -19.5 });
    const [row] = await ctx.db.select({ promotionId: bookings.promotionId }).from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.promotionId).toBe(made.id);

    expect((await quote(60, 3, 'GONESOON')).json().promo.applied).toBe(false);
    // The name is free to use again.
    expect((await makeCode({ code: 'GONESOON', percentOff: 10 })).statusCode).toBe(201);
  });

  it('is the business own: another business is told it does not exist', async () => {
    const made = (await makeCode({ code: 'MINEONLY', percentOff: 10 })).json();
    const res = await send('PATCH', `/providers/me/promotions/${made.id}`, rivalToken, { active: false });
    expect(res.statusCode).toBe(404);
    expect((await send('DELETE', `/providers/me/promotions/${made.id}`, rivalToken)).statusCode).toBe(404);
  });
});

describe('while switched off', () => {
  it('quotes without the code, refuses a booking with one, and closes the addresses', async () => {
    const off = await createTestContext();
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const providerId = (
        await off.app.inject({
          method: 'POST',
          url: '/api/v1/providers/apply',
          payload: application('Switched Off Cars'),
          headers: auth(token),
          remoteAddress: uniqueIp(),
        })
      ).json().providerId;
      const car = await seedVehicle(off.db, providerId);
      const body = { vehicleId: car.id, startDate: dateIn(10), endDate: dateIn(13), promoCode: 'ANYCODE' };

      const quoted = await off.app.inject({
        method: 'POST',
        url: '/api/v1/bookings/quote',
        payload: body,
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(quoted.json().promo).toEqual({
        code: 'ANYCODE',
        applied: false,
        message: 'Discount codes are not switched on yet.',
      });
      const booked = await off.app.inject({
        method: 'POST',
        url: '/api/v1/bookings',
        payload: body,
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(booked.json().error.code).toBe('promo_not_applicable');
      const list = await off.app.inject({
        method: 'GET',
        url: '/api/v1/providers/me/promotions',
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(list.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
