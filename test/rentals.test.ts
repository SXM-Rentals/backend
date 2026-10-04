// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests changing a rental's dates — keeping the car longer,
// bringing it back early, moving a rental that has not started — plus the two
// smaller things that came with it: why a renter cancelled, and what they are
// told about their refund.
//
// The tests that matter most are about money: the renter pays exactly the
// difference when a change costs more, the cancellation policy decides what
// comes back when it costs less, nothing comes back once the car is collected,
// the lines on the booking always add up to what the renter pays, and the
// business always sees gross, commission and net together.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, dateChangeRequests, refundRequests } from '../src/db/schema/index.js';
import { expireUnansweredDateChanges } from '../src/services/date-changes/index.js';
import {
  TEST_SIGNATURE,
  createSignedInStaff,
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
let customerToken: string;
let otherToken: string;
let ownerToken: string;
let rivalToken: string;
let vehicleId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const sendWebhook = (event: object) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': TEST_SIGNATURE },
    payload: JSON.stringify(event),
    remoteAddress: uniqueIp(),
  });

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

// Every booking gets a fortnight of its own, so moving one never runs into the next.
let nextStart = 20;
async function aBooking(options: { startsInDays?: number; days?: number; paid?: boolean } = {}) {
  const startsIn = options.startsInDays ?? (nextStart += 14);
  const days = options.days ?? 3;
  const created = await post(
    '/bookings',
    { vehicleId, startDate: dateIn(startsIn), endDate: dateIn(startsIn + days) },
    auth(customerToken),
  );
  if (created.statusCode !== 201) throw new Error(`Booking failed: ${created.body}`);
  const booking = created.json() as { id: string; startDate: string; endDate: string; totalDueToday: number };
  if (options.paid) {
    await ctx.db.update(bookings).set({ paymentStatus: 'paid' }).where(eq(bookings.id, booking.id));
  }
  return booking;
}

const cents = (amount: number) => Math.round(amount * 100);
const requestRow = async (id: string) =>
  (await ctx.db.select().from(dateChangeRequests).where(eq(dateChangeRequests.id, id)))[0]!;
const refundsFor = (bookingId: string) =>
  ctx.db.select().from(refundRequests).where(eq(refundRequests.bookingId, bookingId));

beforeAll(async () => {
  ctx = await createTestContext({
    env: { FEATURES: 'dateChanges,refunds,payments', STRIPE_SECRET_KEY: 'sk_test_x' },
  });

  const owner = await createVerifiedAccount(ctx);
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  const providerId = (await post('/providers/apply', application('Date Change Cars'), auth(ownerToken))).json()
    .providerId as string;
  vehicleId = (await seedVehicle(ctx.db, providerId, { maximumDays: 20 })).id;

  const rival = await createVerifiedAccount(ctx);
  rivalToken = await signInMobile(ctx, rival.email, rival.password);
  await post('/providers/apply', application('Rival Rentals'), auth(rivalToken));

  const customer = await createVerifiedAccount(ctx);
  customerToken = await signInMobile(ctx, customer.email, customer.password);
  const other = await createVerifiedAccount(ctx);
  otherToken = await signInMobile(ctx, other.email, other.password);
});
afterAll(async () => {
  await ctx.close();
});

describe('keeping the car longer', () => {
  it('is priced before asking, and asking changes nothing until the business accepts', async () => {
    const booking = await aBooking({ paid: true });
    const newEnd = dateIn(nextStart + 5);

    const quote = await post(
      `/bookings/${booking.id}/date-changes/quote`,
      { startDate: booking.startDate, endDate: newEnd },
      auth(customerToken),
    );
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ days: 5, refund: 0, available: true, explanation: null });
    expect(quote.json().difference).toBeGreaterThan(0);
    expect(cents(quote.json().total) - cents(booking.totalDueToday)).toBe(cents(quote.json().difference));
    // A quote is only a price: nothing is asked of anybody.
    expect(await ctx.db.select().from(dateChangeRequests).where(eq(dateChangeRequests.bookingId, booking.id))).toHaveLength(0);

    const asked = await post(
      `/bookings/${booking.id}/date-changes`,
      { startDate: booking.startDate, endDate: newEnd },
      auth(customerToken),
    );
    expect(asked.statusCode).toBe(201);
    expect(asked.json()).toMatchObject({ status: 'pending', endDate: newEnd, fromEndDate: booking.endDate });

    // The booking keeps its dates while it waits, and shows the request.
    const mine = (await get(`/bookings/${booking.id}`, auth(customerToken))).json();
    expect(mine.endDate).toBe(booking.endDate);
    expect(mine.dateChange).toMatchObject({ id: asked.json().id, status: 'pending' });
    // The renter never sees what the business earns.
    expect(mine.dateChange).not.toHaveProperty('commission');

    // One open request per booking.
    const twice = await post(
      `/bookings/${booking.id}/date-changes`,
      { startDate: booking.startDate, endDate: dateIn(nextStart + 6) },
      auth(customerToken),
    );
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('change_pending');
  });

  it('shows the business gross, commission and net for the whole booking at the new dates', async () => {
    const booking = await aBooking({ paid: true });
    const asked = await post(
      `/bookings/${booking.id}/date-changes`,
      { startDate: booking.startDate, endDate: dateIn(nextStart + 4) },
      auth(customerToken),
    );

    const theirs = (await get(`/providers/me/bookings/${booking.id}`, auth(ownerToken))).json();
    const change = theirs.dateChange;
    expect(change).toMatchObject({ id: asked.json().id, status: 'pending' });
    expect(cents(change.grossAmount)).toBe(cents(change.commission) + cents(change.netAmount));
    expect(change.grossAmount).toBe(asked.json().total);
  });

  it('once accepted moves the booking, and the difference is paid through Stripe', async () => {
    const booking = await aBooking({ paid: true });
    const newEnd = dateIn(nextStart + 6);
    const asked = (
      await post(`/bookings/${booking.id}/date-changes`, { startDate: booking.startDate, endDate: newEnd }, auth(customerToken))
    ).json();

    const accepted = await post(`/providers/me/bookings/${booking.id}/date-changes/${asked.id}/accept`, {}, auth(ownerToken));
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ endDate: newEnd, dateChange: { status: 'accepted' } });

    const mine = (await get(`/bookings/${booking.id}`, auth(customerToken))).json();
    expect(mine.endDate).toBe(newEnd);
    expect(mine.totalDueToday).toBe(asked.total);
    expect(mine.dateChange).toMatchObject({ status: 'accepted', paymentStatus: 'unpaid' });
    // The lines on the booking add up to what the renter now pays.
    const lineTotal = mine.lines.reduce((sum: number, line: { amount: number }) => sum + cents(line.amount), 0);
    expect(lineTotal).toBe(cents(mine.totalDueToday));

    // Paying the difference — exactly the difference, not the whole rental again.
    const intent = await post(`/payments/bookings/${booking.id}/date-changes/${asked.id}/intent`, {}, auth(customerToken));
    expect(intent.statusCode).toBe(200);
    expect(intent.json().amount).toBe(asked.difference);
    const row = await requestRow(asked.id);
    expect(ctx.gateway.created.get(row.stripePaymentIntentId!)).toMatchObject({
      kind: 'date_change',
      amountCents: cents(asked.difference),
    });

    // Paid only when Stripe says so.
    expect((await sendWebhook(ctx.gateway.eventFor('payment_intent.succeeded', row.stripePaymentIntentId!))).statusCode).toBe(200);
    expect((await requestRow(asked.id)).paymentStatus).toBe('paid');
    const again = await post(`/payments/bookings/${booking.id}/date-changes/${asked.id}/intent`, {}, auth(customerToken));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_paid');
  });

  it('records the extra days as paid when Stripe has the money but its message never came', async () => {
    const booking = await aBooking({ paid: true });
    const asked = (
      await post(
        `/bookings/${booking.id}/date-changes`,
        { startDate: booking.startDate, endDate: dateIn(nextStart + 5) },
        auth(customerToken),
      )
    ).json();
    await post(`/providers/me/bookings/${booking.id}/date-changes/${asked.id}/accept`, {}, auth(ownerToken));
    await post(`/payments/bookings/${booking.id}/date-changes/${asked.id}/intent`, {}, auth(customerToken));

    ctx.gateway.setStatus((await requestRow(asked.id)).stripePaymentIntentId!, 'succeeded');
    const again = await post(`/payments/bookings/${booking.id}/date-changes/${asked.id}/intent`, {}, auth(customerToken));
    expect(again.json().error.code).toBe('already_paid');
    expect((await requestRow(asked.id)).paymentStatus).toBe('paid');
  });
});

describe('a shorter rental, and the cancellation policy', () => {
  it('gives all the difference back with more than 48 hours to go', async () => {
    const booking = await aBooking({ paid: true, days: 5 });
    const asked = (
      await post(
        `/bookings/${booking.id}/date-changes`,
        { startDate: booking.startDate, endDate: dateIn(nextStart + 2) },
        auth(customerToken),
      )
    ).json();
    expect(asked.difference).toBeLessThan(0);
    expect(asked.refund).toBe(-asked.difference);
    expect(asked.explanation).toContain('all of the difference');

    await post(`/providers/me/bookings/${booking.id}/date-changes/${asked.id}/accept`, {}, auth(ownerToken));
    // Into the refunds queue, like a cancellation: a person still approves it.
    const [refund] = await refundsFor(booking.id);
    expect(refund).toMatchObject({ amountCents: cents(asked.refund), status: 'pending' });

    const mine = (await get(`/bookings/${booking.id}`, auth(customerToken))).json();
    expect(mine.totalDueToday).toBe(asked.total);
    expect(mine.refund).toMatchObject({ amount: asked.refund, status: 'pending', note: null });
  });

  it('gives half back inside 48 hours, and keeps the rest on the booking as its own line', async () => {
    const booking = await aBooking({ startsInDays: 1, days: 5, paid: true });
    const asked = (
      await post(`/bookings/${booking.id}/date-changes`, { startDate: booking.startDate, endDate: dateIn(3) }, auth(customerToken))
    ).json();
    // Half, rounded to the cent the way the cancellation policy rounds it.
    expect(cents(asked.refund)).toBe(Math.round(cents(-asked.difference) / 2));
    expect(asked.explanation).toContain('half');

    await post(`/providers/me/bookings/${booking.id}/date-changes/${asked.id}/accept`, {}, auth(ownerToken));
    const mine = (await get(`/bookings/${booking.id}`, auth(customerToken))).json();
    // What the renter ends up paying: the old price less what comes back.
    expect(cents(mine.totalDueToday)).toBe(cents(booking.totalDueToday) - cents(asked.refund));
    expect(mine.lines.map((line: { label: string }) => line.label)).toContain('Kept under the cancellation policy');
    const lineTotal = mine.lines.reduce((sum: number, line: { amount: number }) => sum + cents(line.amount), 0);
    expect(lineTotal).toBe(cents(mine.totalDueToday));

    // The business is paid on what the renter actually pays.
    const theirs = (await get(`/providers/me/bookings/${booking.id}`, auth(ownerToken))).json();
    expect(theirs.grossAmount).toBe(mine.totalDueToday);
    expect(cents(theirs.grossAmount)).toBe(cents(theirs.commission) + cents(theirs.netAmount));

    // Cleared away, so the next booking can use these days.
    await ctx.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id));
  });

  it('gives nothing back once the rental has started, and only the return date can move', async () => {
    const booking = await aBooking({ days: 4, paid: true });
    // The car was collected yesterday.
    await ctx.db
      .update(bookings)
      .set({ status: 'active', startDate: dateIn(-1), endDate: dateIn(3) })
      .where(eq(bookings.id, booking.id));

    const moved = await post(
      `/bookings/${booking.id}/date-changes/quote`,
      { startDate: dateIn(0), endDate: dateIn(3) },
      auth(customerToken),
    );
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.code).toBe('already_started');

    const early = await post(
      `/bookings/${booking.id}/date-changes/quote`,
      { startDate: dateIn(-1), endDate: dateIn(1) },
      auth(customerToken),
    );
    expect(early.statusCode).toBe(200);
    expect(early.json().difference).toBeLessThan(0);
    expect(early.json().refund).toBe(0);
    expect(early.json().explanation).toContain('not refunded');

    await ctx.db.update(bookings).set({ status: 'completed' }).where(eq(bookings.id, booking.id));
  });
});

describe('what a request can and cannot be', () => {
  it('refuses dates that are no change, in the past, or too short', async () => {
    const booking = await aBooking();
    const quote = (dates: { startDate: string; endDate: string }) =>
      post(`/bookings/${booking.id}/date-changes/quote`, dates, auth(customerToken));

    const same = await quote({ startDate: booking.startDate, endDate: booking.endDate });
    expect(same.json().error.code).toBe('no_change');
    const past = await quote({ startDate: dateIn(-3), endDate: dateIn(2) });
    expect(past.json().error.code).toBe('invalid_dates');
    const backwards = await quote({ startDate: booking.endDate, endDate: booking.startDate });
    expect(backwards.json().error.code).toBe('invalid_dates');
    const tooLong = await quote({ startDate: booking.startDate, endDate: dateIn(nextStart + 25) });
    expect(tooLong.json().error.code).toBe('above_maximum_days');
  });

  it('says so when the car is taken on the new days, and refuses to accept if it was taken since', async () => {
    const first = await aBooking();
    const second = await aBooking();
    // Stretching the first into the second is not possible.
    const blocked = await post(
      `/bookings/${first.id}/date-changes/quote`,
      { startDate: first.startDate, endDate: second.endDate },
      auth(customerToken),
    );
    expect(blocked.json().available).toBe(false);
    const refused = await post(
      `/bookings/${first.id}/date-changes`,
      { startDate: first.startDate, endDate: second.endDate },
      auth(customerToken),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('unavailable');

    // The days are not held while the business decides: somebody else books
    // them, and accepting is then refused.
    const asked = (
      await post(
        `/bookings/${second.id}/date-changes`,
        { startDate: second.startDate, endDate: dateIn(nextStart + 6) },
        auth(customerToken),
      )
    ).json();
    const taken = await post(
      '/bookings',
      { vehicleId, startDate: dateIn(nextStart + 4), endDate: dateIn(nextStart + 6) },
      auth(otherToken),
    );
    expect(taken.statusCode).toBe(201);
    const accept = await post(`/providers/me/bookings/${second.id}/date-changes/${asked.id}/accept`, {}, auth(ownerToken));
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('unavailable');
    expect((await requestRow(asked.id)).status).toBe('pending');
  });

  it('can be taken back by the renter, and then cannot be answered', async () => {
    const booking = await aBooking();
    const asked = (
      await post(
        `/bookings/${booking.id}/date-changes`,
        { startDate: booking.startDate, endDate: dateIn(nextStart + 4) },
        auth(customerToken),
      )
    ).json();

    const withdrawn = await post(`/bookings/${booking.id}/date-changes/${asked.id}/withdraw`, {}, auth(customerToken));
    expect(withdrawn.json().status).toBe('withdrawn');
    const again = await post(`/bookings/${booking.id}/date-changes/${asked.id}/withdraw`, {}, auth(customerToken));
    expect(again.json().error.code).toBe('change_decided');
    const accept = await post(`/providers/me/bookings/${booking.id}/date-changes/${asked.id}/accept`, {}, auth(ownerToken));
    expect(accept.json().error.code).toBe('change_decided');
  });

  it('when declined keeps the old dates and shows the business note as written', async () => {
    const booking = await aBooking();
    const asked = (
      await post(
        `/bookings/${booking.id}/date-changes`,
        { startDate: booking.startDate, endDate: dateIn(nextStart + 4) },
        auth(customerToken),
      )
    ).json();

    const declined = await post(
      `/providers/me/bookings/${booking.id}/date-changes/${asked.id}/decline`,
      { note: 'The car is booked for a wedding that week.' },
      auth(ownerToken),
    );
    expect(declined.statusCode).toBe(200);
    const mine = (await get(`/bookings/${booking.id}`, auth(customerToken))).json();
    expect(mine.endDate).toBe(booking.endDate);
    expect(mine.dateChange).toMatchObject({ status: 'declined', note: 'The car is booked for a wedding that week.' });
  });

  it('expires unanswered once pickup comes', async () => {
    const booking = await aBooking();
    const asked = (
      await post(
        `/bookings/${booking.id}/date-changes`,
        { startDate: booking.startDate, endDate: dateIn(nextStart + 4) },
        auth(customerToken),
      )
    ).json();
    // Pickup has come and gone with nobody answering.
    await ctx.db
      .update(bookings)
      .set({ startDate: dateIn(-1), endDate: dateIn(2) })
      .where(eq(bookings.id, booking.id));

    expect(await expireUnansweredDateChanges(ctx.db)).toBeGreaterThanOrEqual(1);
    expect((await requestRow(asked.id)).status).toBe('expired');
    await ctx.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, booking.id));
  });

  it('belongs to the renter and to the business on the booking, nobody else', async () => {
    const booking = await aBooking();
    const dates = { startDate: booking.startDate, endDate: dateIn(nextStart + 4) };
    expect((await post(`/bookings/${booking.id}/date-changes/quote`, dates, auth(otherToken))).statusCode).toBe(404);

    const asked = (await post(`/bookings/${booking.id}/date-changes`, dates, auth(customerToken))).json();
    const rival = await post(`/providers/me/bookings/${booking.id}/date-changes/${asked.id}/accept`, {}, auth(rivalToken));
    expect(rival.statusCode).toBe(404);
    expect((await requestRow(asked.id)).status).toBe('pending');
  });

  it('answers feature_off while switched off', async () => {
    const off = await createTestContext();
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const res = await off.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/00000000-0000-4000-8000-000000000000/date-changes/quote`,
        payload: { startDate: dateIn(30), endDate: dateIn(33) },
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('feature_off');
      const capabilities = await off.app.inject({ method: 'GET', url: '/api/v1/capabilities', remoteAddress: uniqueIp() });
      expect(capabilities.json().dateChanges).toBe(false);
    } finally {
      await off.close();
    }
  });
});

describe('cancelling, from both sides', () => {
  it('tells the business why the renter cancelled, from a fixed list', async () => {
    const booking = await aBooking();
    const wrong = await post(`/bookings/${booking.id}/cancel`, { reason: 'the business was rude' }, auth(customerToken));
    expect(wrong.statusCode).toBe(400);

    const cancelled = await post(`/bookings/${booking.id}/cancel`, { reason: 'flight_changed' }, auth(customerToken));
    expect(cancelled.statusCode).toBe(200);
    const theirs = (await get(`/providers/me/bookings/${booking.id}`, auth(ownerToken))).json();
    expect(theirs).toMatchObject({ status: 'cancelled', cancellationReason: 'flight_changed' });
  });

  it('shows the renter where the refund is, and only the words written for them', async () => {
    const booking = await aBooking({ paid: true });
    await post(`/bookings/${booking.id}/cancel`, {}, auth(customerToken));
    const [refund] = await refundsFor(booking.id);

    const staff = await createSignedInStaff(ctx);
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/refunds/${refund!.id}/decision`,
      headers: { cookie: staff.cookie, origin: WEB_ORIGIN },
      payload: {
        approve: false,
        reason: 'Customer already refunded by the business in cash, see ticket 41.',
        customerNote: 'The business has already given this back to you directly.',
      },
      remoteAddress: uniqueIp(),
    });
    expect(denied.statusCode).toBe(204);

    const mine = (await get(`/bookings/${booking.id}`, auth(customerToken))).json();
    expect(mine.refund).toMatchObject({
      status: 'denied',
      note: 'The business has already given this back to you directly.',
    });
    // Staff reason stays with staff.
    expect(JSON.stringify(mine)).not.toContain('ticket 41');
  });
});
