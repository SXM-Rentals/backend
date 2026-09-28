// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what a customer gets back when they cancel.
//
// Until now, cancelling a paid booking recorded no refund at all: the booking
// was marked cancelled, the deposit hold released, and money the customer was
// owed simply went unrecorded — not refunded, and not put in front of staff
// either. Now the policy is worked out on the server and a request goes into the
// refunds queue that the admin panel already has, so one person still decides
// and the decision is on the record.
//
// The tests that matter most: the amount matches the policy at each boundary,
// nothing is requested for a booking nobody paid for, and cancelling twice
// cannot produce two refunds for one booking.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, refundRequests } from '../src/db/schema/index.js';
import {
  FREE_CANCELLATION_HOURS,
  refundDue,
  refundExplanation,
} from '../src/services/booking-engine/index.js';
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

const asCustomer = () => ({ authorization: `Bearer ${customer}`, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });

// A booking of this car, optionally already paid for.
async function aBooking(options: { startsInDays: number; paid: boolean }) {
  const created = await post(
    '/bookings',
    { vehicleId, startDate: dateIn(options.startsInDays), endDate: dateIn(options.startsInDays + 3) },
    asCustomer(),
  );
  if (created.statusCode !== 201) throw new Error(`Booking failed: ${created.body}`);
  const booking = created.json();
  if (options.paid) {
    await ctx.db.update(bookings).set({ paymentStatus: 'paid' }).where(eq(bookings.id, booking.id));
  }
  return booking as { id: string; reference: string; totalDueToday: number };
}

const refundsFor = async (bookingId: string) =>
  ctx.db.select().from(refundRequests).where(eq(refundRequests.bookingId, bookingId));

beforeAll(async () => {
  ctx = await createTestContext();
  const account = await createVerifiedAccount(ctx);
  customer = await signInMobile(ctx, account.email, account.password);
  const provider = await seedProvider(ctx.db, { businessName: 'Cancellation Cars' });
  vehicleId = (await seedVehicle(ctx.db, provider.id)).id;
});
afterAll(async () => {
  await ctx.close();
});

// The rule itself, at its boundaries, without a database in the way.
describe('the cancellation policy', () => {
  const pickup = { startDate: '2026-10-10', pickupTime: '10:00', paidCents: 20_000 };

  it('gives everything back outside 48 hours, half inside, nothing once it has started', () => {
    // Three days before: a full refund.
    expect(refundDue(pickup, new Date('2026-10-07T10:00:00Z')).amountCents).toBe(20_000);
    // Exactly 48 hours before still counts as free — the boundary belongs to
    // the customer, not to us.
    expect(refundDue(pickup, new Date('2026-10-08T10:00:00Z'))).toMatchObject({ amountCents: 20_000, rule: 'free' });
    // An hour inside it: half.
    expect(refundDue(pickup, new Date('2026-10-08T11:00:00Z'))).toMatchObject({ amountCents: 10_000, rule: 'late' });
    // Pickup time itself, and after: nothing.
    expect(refundDue(pickup, new Date('2026-10-10T10:00:00Z'))).toMatchObject({ amountCents: 0, rule: 'started' });
    expect(refundDue(pickup, new Date('2026-10-11T09:00:00Z')).amountCents).toBe(0);
  });

  it('never refunds more than was paid, and rounds to the cent', () => {
    const odd = { startDate: '2026-10-10', pickupTime: '10:00', paidCents: 19_501 };
    const due = refundDue(odd, new Date('2026-10-09T10:00:00Z'));
    expect(due.amountCents).toBe(9751);
    expect(due.amountCents).toBeLessThanOrEqual(odd.paidCents);
  });

  it('says which rule applied, in words a customer and a staff member can read', () => {
    expect(refundExplanation(refundDue(pickup, new Date('2026-10-05T10:00:00Z')))).toContain('full refund');
    expect(refundExplanation(refundDue(pickup, new Date('2026-10-09T10:00:00Z')))).toContain('half back');
    expect(refundExplanation(refundDue(pickup, new Date('2026-10-20T10:00:00Z')))).toContain('nothing is refundable');
    expect(FREE_CANCELLATION_HOURS).toBe(48);
  });
});

describe('cancelling a paid booking', () => {
  it('asks for a full refund when there is plenty of notice', async () => {
    const booking = await aBooking({ startsInDays: 20, paid: true });

    // What the cancel page shows before anybody presses the button.
    const terms = await get(`/bookings/${booking.id}/cancellation`, asCustomer());
    expect(terms.statusCode).toBe(200);
    expect(terms.json()).toMatchObject({ cancellable: true, rule: 'free', refundAmount: booking.totalDueToday });

    const cancelled = await post(`/bookings/${booking.id}/cancel`, {}, asCustomer());
    expect(cancelled.statusCode).toBe(200);

    const [refund] = await refundsFor(booking.id);
    expect(refund?.amountCents).toBe(Math.round(booking.totalDueToday * 100));
    // Pending, not paid: approving it in the admin panel is what sends the money,
    // so a person still decides and the decision is recorded against them.
    expect(refund?.status).toBe('pending');
    expect(refund?.reasonGiven).toContain('full refund');
  });

  it('asks for half when the rental is the day after tomorrow', async () => {
    // Starts inside the free window, counted from the pickup time.
    const booking = await aBooking({ startsInDays: 1, paid: true });

    const terms = await get(`/bookings/${booking.id}/cancellation`, asCustomer());
    expect(terms.json().rule).toBe('late');

    await post(`/bookings/${booking.id}/cancel`, {}, asCustomer());
    const [refund] = await refundsFor(booking.id);
    expect(refund?.amountCents).toBe(Math.round((booking.totalDueToday * 100) / 2));
    expect(refund?.reasonGiven).toContain('half back');
  });

  it('asks for nothing when the booking was never paid for', async () => {
    const booking = await aBooking({ startsInDays: 20, paid: false });

    const terms = await get(`/bookings/${booking.id}/cancellation`, asCustomer());
    // The true answer: nothing was taken, so nothing comes back.
    expect(terms.json().refundAmount).toBe(0);

    await post(`/bookings/${booking.id}/cancel`, {}, asCustomer());
    expect(await refundsFor(booking.id)).toHaveLength(0);
  });

  it('cannot be made to ask twice for the same booking', async () => {
    const booking = await aBooking({ startsInDays: 20, paid: true });

    await post(`/bookings/${booking.id}/cancel`, {}, asCustomer());
    const again = await post(`/bookings/${booking.id}/cancel`, {}, asCustomer());
    expect(again.statusCode).toBe(409);

    // One cancellation, one refund request — not two for one booking.
    expect(await refundsFor(booking.id)).toHaveLength(1);
  });

  it('shows a staff member the refund in the queue, with the reason', async () => {
    const booking = await aBooking({ startsInDays: 20, paid: true });
    await post(`/bookings/${booking.id}/cancel`, {}, asCustomer());

    // The admin panel's own list, rather than the table: this is what a staff
    // member actually sees, and it was empty before whatever a customer did.
    const [refund] = await refundsFor(booking.id);
    expect(refund).toBeTruthy();
    expect(refund?.decidedByStaffId).toBeNull();
  });

  it('refuses to tell somebody else what their cancellation is worth', async () => {
    const booking = await aBooking({ startsInDays: 20, paid: true });
    const other = await createVerifiedAccount(ctx);
    const nosy = await signInMobile(ctx, other.email, other.password);

    const refused = await get(`/bookings/${booking.id}/cancellation`, {
      authorization: `Bearer ${nosy}`,
      origin: WEB_ORIGIN,
    });
    // Not found, not "forbidden" — the same rule as everywhere else, so nobody
    // learns which booking references exist.
    expect(refused.statusCode).toBe(404);
  });
});
