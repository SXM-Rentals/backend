// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what the phone app needed from payments — saved
// cards, when a deposit may be held, what the deposit panel says about the hold
// running out, whether a booking is paid, and sending a business back to the app
// after it sets up payouts.
//
// The tests that matter most:
//
//   - a card is never seen by this server: the app gets brand, last four and
//     expiry, and another customer's card is "not found";
//   - a deposit cannot be held more than two days before pickup. A hold lasts
//     about a week, so one placed at booking time for a trip three weeks away
//     would be gone before the car was collected, while the customer believed a
//     deposit was held;
//   - the payout return address is fixed, so it cannot be used to send anybody
//     somewhere else.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, customers } from '../src/db/schema/index.js';
import {
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedProvider,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let customer: string;
let vehicleId: string;
let offset = 30;

const as = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const get = (url: string, bearer = customer) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as(bearer), remoteAddress: uniqueIp() });
const post = (url: string, payload: object = {}, bearer = customer) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: as(bearer), remoteAddress: uniqueIp() });
const del = (url: string, bearer = customer) =>
  ctx.app.inject({ method: 'DELETE', url: `/api/v1${url}`, headers: as(bearer), remoteAddress: uniqueIp() });

async function aBooking(startsInDays?: number) {
  offset += 5;
  const start = startsInDays ?? offset;
  const created = await post('/bookings', { vehicleId, startDate: dateIn(start), endDate: dateIn(start + 3) });
  if (created.statusCode !== 201) throw new Error(`Could not book: ${created.body}`);
  return created.json() as { id: string };
}

beforeAll(async () => {
  // Saved cards need the owner's switch AND Stripe's keys, as they will live.
  ctx = await createTestContext({ env: { FEATURES: 'paymentMethods', STRIPE_SECRET_KEY: 'sk_test_x' } });
  const account = await createVerifiedAccount(ctx);
  customer = await signInMobile(ctx, account.email, account.password);
  const provider = await seedProvider(ctx.db, { isVerified: true });
  vehicleId = (await seedVehicle(ctx.db, provider.id)).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('saved cards', () => {
  it('starts with none, and makes the Stripe record only when a card is saved', async () => {
    expect((await get('/payments/methods')).json()).toEqual([]);
    const [row] = await ctx.db.select().from(customers).limit(1);
    // Looking at an empty list gives nobody a Stripe record.
    expect(row?.stripeCustomerId ?? null).toBeNull();

    const setup = await post('/payments/methods/setup');
    expect(setup.statusCode).toBe(200);
    expect(setup.json().clientSecret).toMatch(/^seti_/);
  });

  it('lists what Stripe holds — brand, last four and expiry, never more', async () => {
    // The Stripe record made when the first test asked for a setup secret.
    const stripeId = (await ctx.db.select().from(customers)).find((c) => c.stripeCustomerId)!.stripeCustomerId!;

    // What Stripe's own form does when the customer saves a card.
    const cardId = ctx.gateway.saveCard(stripeId, { brand: 'visa', last4: '4242' });

    const cards = (await get('/payments/methods')).json();
    expect(cards).toEqual([{ id: cardId, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: false }]);

    const defaulted = await post(`/payments/methods/${cardId}/default`);
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.json()[0].isDefault).toBe(true);

    expect((await del(`/payments/methods/${cardId}`)).statusCode).toBe(204);
    expect((await get('/payments/methods')).json()).toEqual([]);
  });

  it('treats somebody else card as one that does not exist', async () => {
    const other = await createVerifiedAccount(ctx);
    const otherToken = await signInMobile(ctx, other.email, other.password);
    await post('/payments/methods/setup', {}, otherToken);
    const otherStripe = (await ctx.db.select().from(customers)).find(
      (c) => c.email === other.email.toLowerCase(),
    )!.stripeCustomerId!;
    const theirCard = ctx.gateway.saveCard(otherStripe, { brand: 'mastercard', last4: '5555' });

    expect((await del(`/payments/methods/${theirCard}`)).statusCode).toBe(404);
    expect((await post(`/payments/methods/${theirCard}/default`)).statusCode).toBe(404);
    // Still theirs, untouched.
    expect((await get('/payments/methods', otherToken)).json()).toHaveLength(1);
  });

  it('refuses while the owner has not switched saved cards on', async () => {
    const off = await createTestContext({ env: { STRIPE_SECRET_KEY: 'sk_test_x' } });
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const refused = await off.app.inject({
        method: 'GET',
        url: '/api/v1/payments/methods',
        headers: as(token),
        remoteAddress: uniqueIp(),
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error.code).toBe('feature_off');
    } finally {
      await off.close();
    }
  });
});

describe('when a deposit may be held', () => {
  it('refuses more than two days before pickup, and says when it opens', async () => {
    const booking = await aBooking(21);
    const refused = await post(`/deposits/bookings/${booking.id}/authorize`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('too_early');
    // A sentence the app can show as it is.
    expect(refused.json().error.message).toContain('two days before pickup');
  });

  it('allows it inside the two days', async () => {
    const booking = await aBooking(80);
    await ctx.db.update(bookings).set({ startDate: dateIn(1), endDate: dateIn(3) }).where(eq(bookings.id, booking.id));
    const held = await post(`/deposits/bookings/${booking.id}/authorize`);
    expect(held.statusCode).toBe(200);
  });

  it('tells the app when the window opens and when a hold would end', async () => {
    const booking = await aBooking(90);
    const panel = (await get(`/deposits/bookings/${booking.id}`)).json();
    expect(panel.holdOpensAt).toEqual(expect.any(String));
    // Nothing held yet, so nothing to run out.
    expect(panel.holdExpiresAt).toBeNull();
    expect(panel.expiresBeforeReturn).toBe(false);
  });
});

describe('whether a booking is paid', () => {
  it('is on the customer booking, so the app knows whether to offer to pay', async () => {
    const booking = await aBooking();
    expect((await get(`/bookings/${booking.id}`)).json().paymentStatus).toBe('authorized');

    await ctx.db.update(bookings).set({ paymentStatus: 'paid' }).where(eq(bookings.id, booking.id));
    const listed = (await get('/bookings')).json() as { id: string; paymentStatus: string }[];
    expect(listed.find((b) => b.id === booking.id)?.paymentStatus).toBe('paid');
  });
});

describe('sending a business back to the app after payouts', () => {
  it('hands over to the app from a fixed https address on this API', async () => {
    const redirect = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/providers/payout-return?next=https://evil.example',
      remoteAddress: uniqueIp(),
    });
    expect(redirect.statusCode).toBe(302);
    // Fixed. Nothing in the request changes where it goes.
    expect(redirect.headers.location).toBe('sxmrentals://business/payout');
  });
});
