// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests holding the security deposit automatically on the
// card that paid for the rental, against a stand-in Stripe.
//
// The customer pays once. With their agreement (saveCardForDeposit), the card is
// saved as it pays, and the deposit is held on it two days before pickup — or
// straight away when pickup is sooner — without them there. When the bank wants
// them to approve it, or the card is declined, they are told once and hold it
// themselves, as before.
//
// The tests that matter most: an app that does not send the flag gets exactly
// what it got before; a hold is never placed twice, never before its window and
// never without a saved card AND recorded agreement; a hold that fails is never
// retried on its own; and the deposit stays a hold — it never touches the
// rental's total, the commission, the ledger or a payout.

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, customers, deposits, ledgerEntries, notifications } from '../src/db/schema/index.js';
import { holdWindowOpensAt } from '../src/services/payments/holds.js';
import { placeDueDepositHolds } from '../src/services/payments/index.js';
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
let token: string;
let email: string;
let vehicleId: string;
let providerId: string;
const quiet = { info: () => {}, warn: () => {} };

const asCustomer = () => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const post = (url: string, payload?: object) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    ...(payload ? { payload } : {}),
    headers: asCustomer(),
    remoteAddress: uniqueIp(),
  });
const get = (url: string) => ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: asCustomer(), remoteAddress: uniqueIp() });
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
  const start = startsInDays ?? (nextStart += 5);
  // A pickup tomorrow gets a car of its own, so these tests never clash on the same days.
  const car = startsInDays === undefined ? vehicleId : (await seedVehicle(ctx.db, providerId, { dailyRateCents: 6500, depositAmountCents: 50000 })).id;
  const created = await post('/bookings', { vehicleId: car, startDate: dateIn(start), endDate: dateIn(start + 2) });
  if (created.statusCode !== 201) throw new Error(created.body);
  return created.json() as { id: string; reference: string; startDate: string };
}
const bookingRow = async (id: string) => (await ctx.db.select().from(bookings).where(eq(bookings.id, id)))[0]!;
const depositRow = async (bookingId: string) => (await ctx.db.select().from(deposits).where(eq(deposits.bookingId, bookingId)))[0]!;
const holdsFor = (depositId: string) => ctx.gateway.offSessionHolds.filter((hold) => hold.depositId === depositId);
const placeDue = (now?: Date) =>
  placeDueDepositHolds({ db: ctx.db, gateway: ctx.gateway, logger: quiet }, now ? { now } : {});

// Pays for a booking the way the app does, and has Stripe say it went through.
async function pay(bookingId: string, saveCardForDeposit?: boolean) {
  const intent = await post(`/payments/bookings/${bookingId}/intent`, saveCardForDeposit === undefined ? {} : { saveCardForDeposit });
  const paymentId = (await bookingRow(bookingId)).stripePaymentIntentId!;
  ctx.gateway.setStatus(paymentId, 'succeeded');
  await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', paymentId));
  return { intent: intent.json(), paymentId };
}

beforeAll(async () => {
  // Saved cards switched on, for the test that removes one.
  ctx = await createTestContext({ env: { FEATURES: 'paymentMethods', STRIPE_SECRET_KEY: 'sk_test_x' } });
  const provider = await seedProvider(ctx.db);
  providerId = provider.id;
  vehicleId = (await seedVehicle(ctx.db, provider.id, { dailyRateCents: 6500, depositAmountCents: 50000 })).id;
  const account = await createVerifiedAccount(ctx);
  email = account.email;
  token = await signInMobile(ctx, account.email, account.password);
});
afterAll(async () => {
  await ctx.close();
});

describe('paying without the flag, as every older app does', () => {
  it('saves no card and changes nothing, and the deposit stays for the customer to hold', async () => {
    const booking = await aBooking();
    const intent = await post(`/payments/bookings/${booking.id}/intent`, {});
    expect(intent.statusCode).toBe(200);
    expect(intent.json()).toMatchObject({ amount: expect.any(Number), status: 'requires_payment_method' });
    expect(intent.json().deposit).toEqual({
      amount: 500,
      savesCard: false,
      holdFrom: holdWindowOpensAt(booking.startDate, '10:00').toISOString(),
    });
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;
    expect(ctx.gateway.created.get(paymentId)!.savesCardOn).toBeUndefined();
    expect((await depositRow(booking.id)).holdConsentAt).toBeNull();

    ctx.gateway.setStatus(paymentId, 'succeeded');
    await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', paymentId));
    expect((await get(`/deposits/bookings/${booking.id}`)).json()).toMatchObject({ autoHold: 'off', autoHoldAt: null, autoHoldProblem: null });
  });
});

describe('paying with the card saved for the deposit', () => {
  it('saves the card on the customer Stripe record as it pays, and records their agreement', async () => {
    const booking = await aBooking();
    const intent = await post(`/payments/bookings/${booking.id}/intent`, { saveCardForDeposit: true });
    expect(intent.json().deposit).toMatchObject({ amount: 500, savesCard: true });

    const [me] = await ctx.db.select().from(customers).where(eq(customers.email, email));
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;
    expect(ctx.gateway.created.get(paymentId)!.savesCardOn).toBe(me!.stripeCustomerId);
    expect((await depositRow(booking.id)).holdConsentAt).toBeInstanceOf(Date);

    // Once Stripe says it went through, the card that paid is kept beside that agreement.
    ctx.gateway.setStatus(paymentId, 'succeeded');
    await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', paymentId));
    expect((await depositRow(booking.id)).paymentMethodId).toBe(`pm_card_for_${paymentId}`);
    expect((await get(`/deposits/bookings/${booking.id}`)).json()).toMatchObject({
      status: 'not_taken',
      autoHold: 'scheduled',
      autoHoldAt: holdWindowOpensAt(booking.startDate, '10:00').toISOString(),
      autoHoldProblem: null,
    });
  });

  it('makes a payment started before this save the card, rather than handing back one that will not', async () => {
    const booking = await aBooking();
    const first = (await post(`/payments/bookings/${booking.id}/intent`, {})).json();
    expect(first.deposit.savesCard).toBe(false);

    const again = (await post(`/payments/bookings/${booking.id}/intent`, { saveCardForDeposit: true })).json();
    expect(again.clientSecret).toBe(first.clientSecret);
    expect(again.deposit.savesCard).toBe(true);
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;
    expect(ctx.gateway.created.get(paymentId)!.savesCardOn).toBeTruthy();
  });
});

describe('placing the hold without the customer there', () => {
  it('holds a due deposit once, on the saved card, and never before its window', async () => {
    const booking = await aBooking();
    await pay(booking.id, true);
    const deposit = await depositRow(booking.id);

    // Weeks before pickup: nothing.
    expect((await placeDue()).held).toBe(0);
    expect(holdsFor(deposit.id)).toHaveLength(0);

    // Two days before pickup: held, once.
    const windowOpen = new Date(holdWindowOpensAt(booking.startDate, '10:00').getTime() + 60_000);
    await placeDue(windowOpen);
    await placeDue(windowOpen);
    expect(holdsFor(deposit.id)).toHaveLength(1);
    expect(holdsFor(deposit.id)[0]).toMatchObject({ paymentMethodId: deposit.paymentMethodId, amountCents: 50000 });

    const held = await depositRow(booking.id);
    expect(held).toMatchObject({ status: 'held', autoHoldStatus: 'placed' });
    expect(held.stripePaymentIntentId).toBeTruthy();

    // Stripe's own message about the hold arrives later and changes nothing.
    const late = await sendWebhook(ctx.gateway.eventFor('payment_intent.amount_capturable_updated', held.stripePaymentIntentId!));
    expect(late.statusCode).toBe(200);
    expect((await depositRow(booking.id)).status).toBe('held');
  });

  it('holds nothing without a saved card and a recorded agreement', async () => {
    const booking = await aBooking();
    await pay(booking.id); // no flag
    const deposit = await depositRow(booking.id);
    await placeDue(new Date(holdWindowOpensAt(booking.startDate, '10:00').getTime() + 60_000));
    expect(holdsFor(deposit.id)).toHaveLength(0);
    expect((await depositRow(booking.id)).status).toBe('not_taken');
  });

  it('holds it straight away when the rental is paid less than two days before pickup', async () => {
    const booking = await aBooking(1);
    await pay(booking.id, true);
    const deposit = await depositRow(booking.id);
    expect(holdsFor(deposit.id)).toHaveLength(1);
    expect(deposit.status).toBe('held');
    await ctx.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id));
  });

  it('holds it too when Stripe message about the payment was lost, and the customer asks to pay again', async () => {
    const booking = await aBooking(1);
    await post(`/payments/bookings/${booking.id}/intent`, { saveCardForDeposit: true });
    const paymentId = (await bookingRow(booking.id)).stripePaymentIntentId!;
    ctx.gateway.setStatus(paymentId, 'succeeded'); // paid; no message ever comes

    const again = await post(`/payments/bookings/${booking.id}/intent`, { saveCardForDeposit: true });
    expect(again.json().error.code).toBe('already_paid');
    const deposit = await depositRow(booking.id);
    expect(deposit).toMatchObject({ status: 'held', paymentMethodId: `pm_card_for_${paymentId}` });
    expect(holdsFor(deposit.id)).toHaveLength(1);
  });

  it('forgets the card if the customer removes it, and the deposit is theirs to hold again', async () => {
    const booking = await aBooking();
    await pay(booking.id, true);
    const deposit = await depositRow(booking.id);
    const [me] = await ctx.db.select().from(customers).where(eq(customers.email, email));
    // The stand-in keeps saved cards per customer; put this one there so it can be removed.
    ctx.gateway.stripeCustomers.get(me!.stripeCustomerId!)?.cards.push({
      id: deposit.paymentMethodId!,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      isDefault: false,
    });
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/payments/methods/${deposit.paymentMethodId}`,
      headers: asCustomer(),
      remoteAddress: uniqueIp(),
    });
    expect(removed.statusCode).toBe(204);
    expect((await get(`/deposits/bookings/${booking.id}`)).json().autoHold).toBe('off');
  });
});

describe('when the hold cannot go through', () => {
  for (const [problem, wording] of [
    ['authentication_required', 'Your bank wants you to approve'],
    ['card_declined', 'Your card could not be used'],
  ] as const) {
    it(`(${problem}) tells the customer once, never retries, and leaves the button working`, async () => {
      ctx.gateway.nextOffSessionHold = problem;
      try {
        const booking = await aBooking(1);
        await pay(booking.id, true);
        const deposit = await depositRow(booking.id);

        expect(deposit).toMatchObject({ status: 'not_taken', autoHoldStatus: 'needs_customer', stripePaymentIntentId: null });
        expect(deposit.autoHoldProblem).toContain(wording);
        // The half-made hold was let go.
        const attempt = [...ctx.gateway.created.entries()].find(
          ([, payment]) => payment.metadata.depositId === deposit.id && payment.metadata.placedBy === 'automatic',
        )!;
        expect(ctx.gateway.cancelled).toContain(attempt[0]);

        // Never on a loop: more runs try nothing.
        await placeDue();
        await placeDue(new Date(Date.now() + 2 * 60 * 60 * 1000));
        expect(holdsFor(deposit.id)).toHaveLength(1);

        // Told once: in the app, and by email with the way to fix it.
        const told = await ctx.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.bookingId, booking.id), eq(notifications.kind, 'deposit_hold_needed')));
        expect(told).toHaveLength(1);
        expect(told[0]!.body).toContain(wording);
        const mail = ctx.email.sent.filter((message) => message.to === email && message.subject.includes(booking.reference));
        expect(mail.some((message) => message.html.includes(`/account/rentals/${booking.id}`))).toBe(true);

        const panel = (await get(`/deposits/bookings/${booking.id}`)).json();
        expect(panel).toMatchObject({ autoHold: 'needs_customer', autoHoldAt: null, autoHoldProblem: deposit.autoHoldProblem });

        // The button works as before: a fresh hold the customer confirms.
        const manual = await post(`/deposits/bookings/${booking.id}/authorize`);
        expect(manual.statusCode).toBe(200);
        expect(manual.json().clientSecret).toMatch(/_secret$/);
      } finally {
        ctx.gateway.nextOffSessionHold = 'held';
      }
    });
  }
});

describe('the deposit stays a hold (product rule 1)', () => {
  it('never touches the rental total, the commission, the ledger or a payout', async () => {
    const booking = await aBooking(1);
    const { paymentId } = await pay(booking.id, true);
    const before = await bookingRow(booking.id);
    const deposit = await depositRow(booking.id);
    expect(deposit.status).toBe('held');

    const after = await bookingRow(booking.id);
    expect({ gross: after.grossCents, commission: after.commissionCents, payout: after.payoutCents, total: after.totalDueTodayCents }).toEqual({
      gross: before.grossCents,
      commission: before.commissionCents,
      payout: before.payoutCents,
      total: before.totalDueTodayCents,
    });
    expect(after.payoutId).toBeNull();
    // The ledger has the rental payment and nothing for the hold.
    const lines = await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, booking.id));
    expect(lines.map((line) => line.stripeRef)).toEqual([paymentId]);
    expect(lines.some((line) => line.stripeRef === deposit.stripePaymentIntentId)).toBe(false);
    // And the hold itself is a separate, authorise-only payment.
    expect(ctx.gateway.created.get(deposit.stripePaymentIntentId!)!.kind).toBe('deposit');
    expect(ctx.gateway.captured.some((capture) => capture.paymentId === deposit.stripePaymentIntentId)).toBe(false);
  });
});
