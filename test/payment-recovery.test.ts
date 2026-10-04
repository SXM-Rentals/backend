// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what happens when Stripe's messages do not arrive
// the way they should — late, lost, about a booking this database does not
// have, or arriving while the database has a hiccup — and that a refund is
// recorded once, for the right amount.
//
// The rule behind every test here: a payment Stripe has is recorded exactly
// once, however many ways the news of it arrives, and a payment Stripe does not
// have is never recorded at all.

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import { bookings, deposits, ledgerEntries, processedWebhookEvents, refundRequests } from '../src/db/schema/index.js';
import { createPaymentService } from '../src/services/payments/index.js';
import {
  TEST_SIGNATURE,
  createSignedInStaff,
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
let token: string;
let vehicleId: string;

const asCustomer = () => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const post = (url: string, payload: object = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: asCustomer(), remoteAddress: uniqueIp() });
const sendWebhook = (event: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': TEST_SIGNATURE },
    payload: JSON.stringify(event),
    remoteAddress: uniqueIp(),
  });

let nextStart = 20;
async function aBooking(startsInDays?: number) {
  const start = startsInDays ?? (nextStart += 7);
  const created = await post('/bookings', { vehicleId, startDate: dateIn(start), endDate: dateIn(start + 2) });
  if (created.statusCode !== 201) throw new Error(created.body);
  return created.json() as { id: string; totalDueToday: number };
}
const bookingRow = async (id: string) => (await ctx.db.select().from(bookings).where(eq(bookings.id, id)))[0]!;
const chargesFor = (bookingId: string) =>
  ctx.db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.bookingId, bookingId), eq(ledgerEntries.kind, 'charge')));

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = await seedProvider(ctx.db);
  vehicleId = (await seedVehicle(ctx.db, provider.id, { dailyRateCents: 6500, depositAmountCents: 50000 })).id;
  const account = await createVerifiedAccount(ctx);
  token = await signInMobile(ctx, account.email, account.password);
});
afterAll(async () => {
  await ctx.close();
});

describe('a payment Stripe already has', () => {
  it('is recorded when the customer asks to pay again, and the late message changes nothing', async () => {
    const booking = await aBooking();
    await post(`/payments/bookings/${booking.id}/intent`);
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;

    // Paid in Stripe's sheet; Stripe's message never arrived.
    ctx.gateway.setStatus(paymentId, 'succeeded');
    const again = await post(`/payments/bookings/${booking.id}/intent`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_paid');
    expect((await bookingRow(booking.id)).paymentStatus).toBe('paid');
    expect(await chargesFor(booking.id)).toHaveLength(1);

    // The message turns up after all: still one payment.
    const late = await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', paymentId));
    expect(late.statusCode).toBe(200);
    expect(await chargesFor(booking.id)).toHaveLength(1);
  });

  it('hands back a payment that is still waiting for the card, as before', async () => {
    const booking = await aBooking();
    const first = (await post(`/payments/bookings/${booking.id}/intent`)).json();
    const again = await post(`/payments/bookings/${booking.id}/intent`);
    expect(again.statusCode).toBe(200);
    expect(again.json().clientSecret).toBe(first.clientSecret);
  });

  it('records a deposit hold already on the card, and never hands it back', async () => {
    // A hold may only be placed in the two days before pickup.
    const booking = await aBooking(1);
    await post(`/deposits/bookings/${booking.id}/authorize`);
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));

    ctx.gateway.setStatus(deposit!.stripePaymentIntentId!, 'requires_capture');
    const again = await post(`/deposits/bookings/${booking.id}/authorize`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('deposit_already_held');
    const [held] = await ctx.db.select().from(deposits).where(eq(deposits.id, deposit!.id));
    expect(held!.status).toBe('held');
    await ctx.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id));
  });
});

describe('a message about a booking this database does not have', () => {
  it('writes nothing, and tells Stripe it arrived so it stops sending it', async () => {
    const event = {
      id: 'evt_from_somebody_elses_backend',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_not_ours', amount: 19500, metadata: { kind: 'rental', bookingId: '00000000-0000-4000-8000-000000000001' } } },
    };
    const before = (await ctx.db.select().from(ledgerEntries)).length;
    const res = await sendWebhook(event);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, handled: false });
    expect((await ctx.db.select().from(ledgerEntries)).length).toBe(before);
    const kept = await ctx.db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.id, event.id));
    expect(kept).toHaveLength(0);
  });
});

describe('a message that fails part way', () => {
  it('is not marked handled, so Stripe sending it again records the payment', async () => {
    const booking = await aBooking();
    await post(`/payments/bookings/${booking.id}/intent`);
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;
    const event = ctx.gateway.eventFor('payment_intent.succeeded', paymentId);

    // A database that does all the work and then fails before it is saved.
    const hiccup = new Proxy(ctx.db, {
      get(target, property) {
        if (property === 'transaction') {
          return (work: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              await work(tx);
              throw new Error('the database hiccuped');
            });
        }
        return Reflect.get(target, property);
      },
    }) as Database;
    const failing = createPaymentService({ db: hiccup, gateway: ctx.gateway, logger: { info: () => {}, warn: () => {} } });
    await expect(failing.handleStripeEvent(event)).rejects.toThrow('the database hiccuped');

    expect((await bookingRow(booking.id)).paymentStatus).not.toBe('paid');
    expect(await ctx.db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.id, event.id))).toHaveLength(0);

    // Stripe's retry is not mistaken for a repeat.
    const retry = await sendWebhook(event);
    expect(retry.json().handled).toBe(true);
    expect((await bookingRow(booking.id)).paymentStatus).toBe('paid');
    expect(await chargesFor(booking.id)).toHaveLength(1);
  });
});

describe('a refund', () => {
  it('approved in the admin panel is recorded once, for the amount refunded', async () => {
    const booking = await aBooking();
    await post(`/payments/bookings/${booking.id}/intent`);
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;
    await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', paymentId));
    await post(`/bookings/${booking.id}/cancel`);
    const [request] = await ctx.db.select().from(refundRequests).where(eq(refundRequests.bookingId, booking.id));

    const staff = await createSignedInStaff(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/refunds/${request!.id}/decision`,
      headers: { cookie: staff.cookie, origin: WEB_ORIGIN },
      payload: { approve: true, reason: 'Cancelled well ahead, full refund under the policy.' },
      remoteAddress: uniqueIp(),
    });
    // Stripe confirms: the charge, with how much of it has been refunded in all.
    await sendWebhook(
      ctx.gateway.eventFor('charge.refunded', 'ch_test_1', { payment_intent: paymentId, amount_refunded: request!.amountCents }),
    );

    const refunds = await ctx.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.bookingId, booking.id), eq(ledgerEntries.kind, 'refund')));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amountCents: request!.amountCents, status: 'succeeded' });
  });

  it('made in Stripe itself is recorded for only what is new', async () => {
    const booking = await aBooking();
    await post(`/payments/bookings/${booking.id}/intent`);
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;
    await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', paymentId));

    await sendWebhook(ctx.gateway.eventFor('charge.refunded', 'ch_test_2', { payment_intent: paymentId, amount_refunded: 5000 }));
    await sendWebhook(ctx.gateway.eventFor('charge.refunded', 'ch_test_2', { payment_intent: paymentId, amount_refunded: 8000 }));
    const refunds = await ctx.db
      .select({ amountCents: ledgerEntries.amountCents })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.bookingId, booking.id), eq(ledgerEntries.kind, 'refund')));
    expect(refunds.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([3000, 5000]);
  });
});
