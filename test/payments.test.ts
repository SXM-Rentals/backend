// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests everything to do with money, against a stand-in
// Stripe so it runs with no account and no keys: paying for a rental, holding a
// security deposit, giving that hold back, keeping part of it after a written
// claim, and dealing with the messages Stripe sends afterwards.
//
// The most important tests in here are the ones proving a deposit never becomes
// revenue, that a booking is only ever marked paid because Stripe said so, and
// that an unsigned message — which anybody on the internet could send — changes
// nothing at all.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, deposits, ledgerEntries } from '../src/db/schema/index.js';
import { createUnconfiguredGateway } from '../src/lib/stripe.js';
import { createPaymentService } from '../src/services/payments/index.js';
import {
  TEST_SIGNATURE,
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
let vehicleId: string;
let token: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = await seedProvider(ctx.db);
  const vehicle = await seedVehicle(ctx.db, provider.id, { dailyRateCents: 6500, depositAmountCents: 50000 });
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

// Sends a message the way Stripe would, signature and all. Pass null to send
// one with no signature at all — note that passing `undefined` would silently
// fall back to the valid signature, which is not the same test.
const sendWebhook = (event: object, signature: string | null = TEST_SIGNATURE) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) },
    payload: JSON.stringify(event),
    remoteAddress: uniqueIp(),
  });

// A fresh booking to work with, and the id of the payment started for it.
// Each one takes a different week: there is only one car here, and booking it
// twice for the same days is refused — correctly.
let weekOffset = 20;
async function bookAndStartPayment() {
  weekOffset += 7;
  const created = await post(
    '/bookings',
    { vehicleId, startDate: dateIn(weekOffset), endDate: dateIn(weekOffset + 3) },
    asCustomer(),
  );
  // Fail here, loudly, rather than further down with something unreadable.
  if (created.statusCode !== 201) throw new Error(`Could not set up a booking: ${created.body}`);
  const booking = created.json();

  const intent = await post(`/payments/bookings/${booking.id}/intent`, {}, asCustomer());
  const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
  return { booking, intent, paymentId: row!.stripePaymentIntentId! };
}

describe('paying for a rental', () => {
  it('hands the app a one-time secret, and never marks the booking paid on its own', async () => {
    const { booking, intent, paymentId } = await bookAndStartPayment();

    expect(intent.statusCode).toBe(200);
    expect(intent.json()).toMatchObject({ amount: 204.75, status: 'requires_payment_method' });
    expect(intent.json().clientSecret).toMatch(/_secret$/);
    // The card number never comes near this server — only the secret does.
    expect(intent.body).not.toMatch(/card|number|cvc/i);

    // Being handed a secret is not payment. Stripe has said nothing yet.
    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.paymentStatus).toBe('authorized');
    expect(paymentId).toBeTruthy();
  });

  it('resumes the same payment instead of starting a second one', async () => {
    const { booking, paymentId } = await bookAndStartPayment();
    const before = ctx.gateway.created.size;

    const again = await post(`/payments/bookings/${booking.id}/intent`, {}, asCustomer());
    expect(again.statusCode).toBe(200);
    expect(ctx.gateway.created.size).toBe(before);
    expect(again.json().clientSecret).toBe(`${paymentId}_secret`);
  });

  it('marks the booking paid only when Stripe says the money arrived', async () => {
    const { booking, paymentId } = await bookAndStartPayment();

    const res = await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', paymentId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, handled: true });

    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.paymentStatus).toBe('paid');

    // The movement of money is recorded as its own ledger line.
    const ledger = await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, booking.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'charge', amountCents: 20475, status: 'succeeded' });
  });

  it('ignores the same message sent twice, so nothing is recorded twice', async () => {
    const { booking, paymentId } = await bookAndStartPayment();
    const event = ctx.gateway.eventFor('payment_intent.succeeded', paymentId);

    expect((await sendWebhook(event)).json().handled).toBe(true);
    const repeat = await sendWebhook(event);
    // Stripe is told we have it, so it stops resending — but nothing happens again.
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().handled).toBe(false);

    const ledger = await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, booking.id));
    expect(ledger).toHaveLength(1);
  });

  it('refuses a message that is not properly signed, and changes nothing', async () => {
    const { booking, paymentId } = await bookAndStartPayment();
    const event = ctx.gateway.eventFor('payment_intent.succeeded', paymentId);

    const forged = await sendWebhook(event, 'not-the-real-signature');
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe('invalid_signature');

    // No signature header at all — what a stranger's request would look like.
    const unsigned = await sendWebhook(event, null);
    expect(unsigned.statusCode).toBe(400);
    expect(unsigned.json().error.code).toBe('invalid_signature');

    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.paymentStatus).toBe('authorized');
  });

  it('records a declined card as failed', async () => {
    const { booking, paymentId } = await bookAndStartPayment();
    await sendWebhook(ctx.gateway.eventFor('payment_intent.payment_failed', paymentId));

    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.paymentStatus).toBe('failed');
  });
});

describe('the security deposit', () => {
  it('is held on the card, not charged — and never counted as revenue', async () => {
    const { booking } = await bookAndStartPayment();

    const hold = await post(`/deposits/bookings/${booking.id}/authorize`, {}, asCustomer());
    expect(hold.statusCode).toBe(200);
    expect(hold.json().amount).toBe(500);

    const [depositRow] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));
    const depositPaymentId = depositRow!.stripePaymentIntentId!;
    // A separate payment from the rental's, set to authorise only.
    expect(ctx.gateway.created.get(depositPaymentId)?.kind).toBe('deposit');
    expect(depositRow!.status).toBe('not_taken');

    // Stripe confirms the hold is in place.
    await sendWebhook(ctx.gateway.eventFor('payment_intent.amount_capturable_updated', depositPaymentId));
    const [held] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));
    expect(held!.status).toBe('held');
    expect(held!.authorizedAt).toBeTruthy();

    // THE RULE: holding it changed no money anywhere. The booking's total, the
    // commission and the payout are untouched, and there is no charge line.
    const [bookingRow] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(bookingRow!.totalDueTodayCents).toBe(20475);
    expect(bookingRow!.grossCents).toBe(20475);
    expect(bookingRow!.payoutCents + bookingRow!.commissionCents).toBe(bookingRow!.grossCents);
    const ledger = await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, booking.id));
    expect(ledger.filter((line) => line.stripeRef === depositPaymentId)).toEqual([]);

    // What the customer sees.
    const view = await get(`/deposits/bookings/${booking.id}`, asCustomer());
    expect(view.json()).toMatchObject({ amount: 500, status: 'held' });
  });

  it('is given back in full when the car comes back', async () => {
    const { booking } = await bookAndStartPayment();
    await post(`/deposits/bookings/${booking.id}/authorize`, {}, asCustomer());
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));
    await sendWebhook(ctx.gateway.eventFor('payment_intent.amount_capturable_updated', deposit!.stripePaymentIntentId!));

    // Releasing is a staff decision, so it happens through the service.
    const payments = createPaymentService({
      db: ctx.db,
      gateway: ctx.gateway,
      logger: { info: () => {}, warn: () => {} },
    });
    await payments.releaseDeposit(deposit!.id);

    expect(ctx.gateway.cancelled).toContain(deposit!.stripePaymentIntentId);
    const [released] = await ctx.db.select().from(deposits).where(eq(deposits.id, deposit!.id));
    expect(released!.status).toBe('released');
    expect(released!.releasedAt).toBeTruthy();
  });

  it('can only be kept in part, with a written reason, and never more than was held', async () => {
    const { booking } = await bookAndStartPayment();
    await post(`/deposits/bookings/${booking.id}/authorize`, {}, asCustomer());
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));
    await sendWebhook(ctx.gateway.eventFor('payment_intent.amount_capturable_updated', deposit!.stripePaymentIntentId!));

    const payments = createPaymentService({
      db: ctx.db,
      gateway: ctx.gateway,
      logger: { info: () => {}, warn: () => {} },
    });

    // No reason, and more than was held: both refused.
    await expect(payments.claimDeposit(deposit!.id, { reason: '   ', amountCents: 10000 })).rejects.toMatchObject({
      code: 'reason_required',
    });
    await expect(
      payments.claimDeposit(deposit!.id, { reason: 'Wing mirror broken off', amountCents: 999999 }),
    ).rejects.toMatchObject({ code: 'invalid_amount' });

    await payments.claimDeposit(deposit!.id, { reason: 'Wing mirror broken off', amountCents: 12500 });

    // Only the claimed part is taken; the rest goes back to the customer.
    expect(ctx.gateway.captured).toContainEqual({
      paymentId: deposit!.stripePaymentIntentId,
      amountCents: 12500,
    });
    const [claimed] = await ctx.db.select().from(deposits).where(eq(deposits.id, deposit!.id));
    expect(claimed).toMatchObject({
      status: 'claimed',
      claimedAmountCents: 12500,
      claimReason: 'Wing mirror broken off',
    });

    // Even now it is not revenue: the booking's money is exactly as it was.
    const [bookingRow] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(bookingRow!.grossCents).toBe(20475);
    expect(bookingRow!.payoutCents + bookingRow!.commissionCents).toBe(bookingRow!.grossCents);
  });

  it('will not let a customer or a stranger release or keep a deposit', async () => {
    const { booking } = await bookAndStartPayment();
    await post(`/deposits/bookings/${booking.id}/authorize`, {}, asCustomer());
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));

    const byCustomer = await post(`/deposits/${deposit!.id}/release`, {}, asCustomer());
    const byStranger = await post(`/deposits/${deposit!.id}/release`, {});
    const claimAttempt = await post(
      `/deposits/${deposit!.id}/claim`,
      { reason: 'I would like to keep this money', amount: 100 },
      asCustomer(),
    );

    expect(byCustomer.statusCode).toBe(403);
    expect(byStranger.statusCode).toBe(403);
    expect(claimAttempt.statusCode).toBe(403);

    const [untouched] = await ctx.db.select().from(deposits).where(eq(deposits.id, deposit!.id));
    expect(untouched!.status).toBe('not_taken');
  });
});

describe('whose booking it is', () => {
  it("will not start a payment or a hold on somebody else's booking", async () => {
    const { booking } = await bookAndStartPayment();
    const other = await createVerifiedAccount(ctx);
    const otherToken = await signInMobile(ctx, other.email, other.password);

    expect((await post(`/payments/bookings/${booking.id}/intent`, {}, asCustomer(otherToken))).statusCode).toBe(404);
    expect((await post(`/deposits/bookings/${booking.id}/authorize`, {}, asCustomer(otherToken))).statusCode).toBe(404);
    expect((await get(`/deposits/bookings/${booking.id}`, asCustomer(otherToken))).statusCode).toBe(404);
  });

  it('needs you to be signed in at all', async () => {
    const { booking } = await bookAndStartPayment();
    expect((await post(`/payments/bookings/${booking.id}/intent`, {})).statusCode).toBe(401);
    expect((await post(`/deposits/bookings/${booking.id}/authorize`, {})).statusCode).toBe(401);
  });
});

describe('before Stripe is connected', () => {
  it('refuses clearly instead of pretending to take money', async () => {
    const gateway = createUnconfiguredGateway();
    await expect(
      gateway.createRentalPayment({ bookingId: 'b', bookingReference: 'SXM-1', amountCents: 1000 }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'payments_unavailable' });
    expect(() => gateway.verifyWebhook(Buffer.from('{}'), 'whatever')).toThrow(/not switched on/i);
  });
});
