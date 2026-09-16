// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests that customers are told what has happened — their
// booking is confirmed, their payment arrived, their deposit was given back,
// their car is due tomorrow — both in the app's list and, where it matters, by
// email.
//
// The tests that matter most: you only ever see your own notifications, the
// same reminder is never sent twice however often the daily command runs, and
// the wording keeps a deposit clearly apart from a payment.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, deposits, notifications } from '../src/db/schema/index.js';
import { createNotificationService } from '../src/services/notifications/index.js';
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
let token: string;
let vehicleId: string;

const asCustomer = (bearer = token) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });

const sendWebhook = (event: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'test-signature' },
    payload: JSON.stringify(event),
    remoteAddress: uniqueIp(),
  });

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = await seedProvider(ctx.db);
  const vehicle = await seedVehicle(ctx.db, provider.id, { make: 'Suzuki', model: 'Jimny', depositAmountCents: 30000 });
  vehicleId = vehicle.id;
  const account = await createVerifiedAccount(ctx);
  token = await signInMobile(ctx, account.email, account.password);
});
afterAll(async () => {
  await ctx.close();
});

describe('when a booking is made', () => {
  it('says so in the app and by email, with the deposit kept apart from the total', async () => {
    const booking = (
      await post('/bookings', { vehicleId, startDate: dateIn(30), endDate: dateIn(33) }, asCustomer())
    ).json();

    const list = await get('/notifications', asCustomer());
    expect(list.statusCode).toBe(200);
    const confirmation = list.json().find((item: { kind: string }) => item.kind === 'booking_confirmed');
    expect(confirmation).toMatchObject({ title: `Booking confirmed — ${booking.reference}`, read: false });
    expect(confirmation.body).toContain('Suzuki Jimny');

    const emailed = ctx.email.sent.at(-1);
    expect(emailed?.subject).toContain(booking.reference);
    // The email says plainly that the deposit is not part of what they paid.
    expect(emailed?.text).toMatch(/not part of the total/i);
  });

  it('needs you to be signed in to read them at all', async () => {
    expect((await get('/notifications')).statusCode).toBe(401);
  });
});

describe('whose notifications they are', () => {
  it("never shows or marks another customer's", async () => {
    const other = await createVerifiedAccount(ctx);
    const otherToken = await signInMobile(ctx, other.email, other.password);

    const mine = (await get('/notifications', asCustomer())).json();
    expect(mine.length).toBeGreaterThan(0);

    const theirs = await get('/notifications', asCustomer(otherToken));
    expect(theirs.json()).toEqual([]);

    const attempt = await post(`/notifications/${mine[0].id}/read`, {}, asCustomer(otherToken));
    expect(attempt.statusCode).toBe(404);

    // Still unread for its actual owner.
    const [row] = await ctx.db.select().from(notifications).where(eq(notifications.id, mine[0].id));
    expect(row!.readAt).toBeNull();
  });

  it('marks one, then all, as read', async () => {
    const [first] = (await get('/notifications', asCustomer())).json();
    expect((await post(`/notifications/${first.id}/read`, {}, asCustomer())).statusCode).toBe(204);
    expect((await get('/notifications', asCustomer())).json().find((n: { id: string }) => n.id === first.id).read).toBe(
      true,
    );

    await post('/bookings', { vehicleId, startDate: dateIn(50), endDate: dateIn(52) }, asCustomer());
    expect((await post('/notifications/read-all', {}, asCustomer())).statusCode).toBe(204);
    expect((await get('/notifications', asCustomer())).json().every((n: { read: boolean }) => n.read)).toBe(true);
  });
});

describe('when money moves', () => {
  it('reports a payment once, however often Stripe repeats itself', async () => {
    const booking = (
      await post('/bookings', { vehicleId, startDate: dateIn(70), endDate: dateIn(73) }, asCustomer())
    ).json();
    await post(`/payments/bookings/${booking.id}/intent`, {}, asCustomer());
    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));

    const event = ctx.gateway.eventFor('payment_intent.succeeded', row!.stripePaymentIntentId!);
    await sendWebhook(event);
    await sendWebhook(event);

    const payments = (await get('/notifications', asCustomer()))
      .json()
      .filter((item: { kind: string; title: string }) => item.title === 'Payment received');
    expect(payments).toHaveLength(1);
    expect(payments[0].body).toContain('$204.75');
  });

  it('says a released deposit was never charged', async () => {
    const booking = (
      await post('/bookings', { vehicleId, startDate: dateIn(90), endDate: dateIn(93) }, asCustomer())
    ).json();
    await post(`/deposits/bookings/${booking.id}/authorize`, {}, asCustomer());
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));
    await sendWebhook(ctx.gateway.eventFor('payment_intent.amount_capturable_updated', deposit!.stripePaymentIntentId!));

    const notifier = createNotificationService({ db: ctx.db, email: ctx.email, logger: { error: () => {} } });
    const payments = await import('../src/services/payments/index.js');
    await payments
      .createPaymentService({ db: ctx.db, gateway: ctx.gateway, logger: { info: () => {}, warn: () => {} }, notifications: notifier })
      .releaseDeposit(deposit!.id);

    const message = (await get('/notifications', asCustomer()))
      .json()
      .find((item: { title: string }) => item.title === 'Your deposit has been released');
    expect(message).toBeTruthy();
    expect(message.body).toMatch(/never charged/i);
    expect(ctx.email.sent.at(-1)?.text).toMatch(/only ever held on your card, never taken/i);
  });

  it('tells the customer when a booking is cancelled', async () => {
    const booking = (
      await post('/bookings', { vehicleId, startDate: dateIn(110), endDate: dateIn(113) }, asCustomer())
    ).json();
    await post(`/bookings/${booking.id}/cancel`, {}, asCustomer());

    const message = (await get('/notifications', asCustomer()))
      .json()
      .find((item: { kind: string; title: string }) => item.kind === 'cancellation');
    expect(message.title).toContain(booking.reference);
    expect(ctx.email.sent.at(-1)?.subject).toMatch(/cancelled/i);
  });
});

describe('reminders the day before', () => {
  it('reminds about tomorrow, and never twice', async () => {
    const notifier = createNotificationService({ db: ctx.db, email: ctx.email, logger: { error: () => {} } });

    // One car to collect tomorrow, one to bring back tomorrow.
    await post('/bookings', { vehicleId, startDate: dateIn(1), endDate: dateIn(4) }, asCustomer());
    const returning = (
      await post('/bookings', { vehicleId, startDate: dateIn(120), endDate: dateIn(123) }, asCustomer())
    ).json();
    await ctx.db
      .update(bookings)
      .set({ status: 'active', startDate: dateIn(-2), endDate: dateIn(1) })
      .where(eq(bookings.id, returning.id));

    const first = await notifier.sendTomorrowsReminders();
    expect(first.pickups).toBe(1);
    expect(first.returns).toBe(1);

    // Running the daily command again sends nothing more.
    await notifier.sendTomorrowsReminders();

    const list = (await get('/notifications', asCustomer())).json();
    expect(list.filter((item: { kind: string }) => item.kind === 'pickup_reminder')).toHaveLength(1);
    expect(list.filter((item: { kind: string }) => item.kind === 'return_reminder')).toHaveLength(1);
    expect(list.find((item: { kind: string }) => item.kind === 'pickup_reminder').body).toContain('Suzuki Jimny');
  });
});
