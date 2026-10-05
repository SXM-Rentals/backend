// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests staff stepping in: cancelling a rental themselves,
// and closing a business that still has rentals booked.
//
// The tests that matter most: only Owner and Godfather can do either, with the
// authenticator code; a full refund really goes back to the card and is on the
// audit log; a deposit hold is always released; and an override that cannot
// finish (a car is out with a renter) changes nothing at all.

import { and, eq } from 'drizzle-orm';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, bookings, deposits, notifications, providers, refundRequests } from '../src/db/schema/index.js';
import {
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
let renterToken: string;
let owner: Awaited<ReturnType<typeof createSignedInStaff>>;
let administrator: Awaited<ReturnType<typeof createSignedInStaff>>;

const code = (who: typeof owner) => generateOtp({ secret: who.secret });
const asStaff = (who: typeof owner, url: string, body: object) =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1/admin${url}`,
    headers: { cookie: who.cookie, origin: WEB_ORIGIN },
    payload: body,
    remoteAddress: uniqueIp(),
  });

// A paid booking of a car of this business, with its deposit held.
let nextStart = 20;
async function aPaidBooking(providerId: string, options: { held?: boolean } = {}) {
  const vehicleId = (await seedVehicle(ctx.db, providerId)).id;
  nextStart += 5;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/bookings',
    headers: { authorization: `Bearer ${renterToken}`, origin: WEB_ORIGIN },
    payload: { vehicleId, startDate: dateIn(nextStart), endDate: dateIn(nextStart + 2) },
    remoteAddress: uniqueIp(),
  });
  const booking = created.json() as { id: string; reference: string; totalDueToday: number };
  await ctx.db
    .update(bookings)
    .set({ paymentStatus: 'paid', stripePaymentIntentId: `pi_paid_${booking.id.slice(0, 8)}` })
    .where(eq(bookings.id, booking.id));
  if (options.held) {
    await ctx.db
      .update(deposits)
      .set({ status: 'held', stripePaymentIntentId: `pi_hold_${booking.id.slice(0, 8)}`, authorizedAt: new Date() })
      .where(eq(deposits.bookingId, booking.id));
  }
  return booking;
}
const bookingRow = async (id: string) => (await ctx.db.select().from(bookings).where(eq(bookings.id, id)))[0]!;

beforeAll(async () => {
  ctx = await createTestContext();
  const renter = await createVerifiedAccount(ctx);
  renterToken = await signInMobile(ctx, renter.email, renter.password);
  owner = await createSignedInStaff(ctx, 'Olivia Owner', 'owner');
  administrator = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');
});
afterAll(async () => {
  await ctx.close();
});

describe('staff cancelling a rental', () => {
  it('is for Owner and above, with the authenticator code', async () => {
    const provider = await seedProvider(ctx.db);
    const booking = await aPaidBooking(provider.id);
    const body = { reason: 'The business asked us to.', refund: 'full' };

    const notOwner = await asStaff(administrator, `/bookings/${booking.id}/cancel`, { ...body, code: await code(administrator) });
    expect(notOwner.statusCode).toBe(403);
    const wrongCode = await asStaff(owner, `/bookings/${booking.id}/cancel`, { ...body, code: '000000' });
    expect(wrongCode.json().error.code).toBe('wrong_code');
    expect((await bookingRow(booking.id)).status).toBe('upcoming');
  });

  it('cancels with a full refund back to the card, releases the deposit, tells the renter, and logs it all', async () => {
    const provider = await seedProvider(ctx.db);
    const booking = await aPaidBooking(provider.id, { held: true });

    const res = await asStaff(owner, `/bookings/${booking.id}/cancel`, {
      reason: 'The car was written off yesterday.',
      refund: 'full',
      code: await code(owner),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', cancelledBy: 'staff' });

    const row = await bookingRow(booking.id);
    expect(ctx.gateway.refunded).toContainEqual({ paymentId: row.stripePaymentIntentId, amountCents: row.totalDueTodayCents });
    const [refund] = await ctx.db.select().from(refundRequests).where(eq(refundRequests.bookingId, booking.id));
    expect(refund).toMatchObject({ status: 'approved', amountCents: row.totalDueTodayCents, decidedByStaffId: owner.staffId });

    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.id));
    expect(deposit!.status).toBe('released');
    expect(ctx.gateway.cancelled).toContain(deposit!.stripePaymentIntentId);

    const logged = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, booking.id));
    expect(logged.map((entry) => entry.action)).toContain('booking_cancelled');
    const told = await ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.bookingId, booking.id), eq(notifications.kind, 'cancellation')));
    expect(told).toHaveLength(1);
  });

  it('can cancel with no refund, and refuses a rental that is already over', async () => {
    const provider = await seedProvider(ctx.db);
    const booking = await aPaidBooking(provider.id);
    const before = ctx.gateway.refunded.length;
    const none = await asStaff(owner, `/bookings/${booking.id}/cancel`, {
      reason: 'Paid with a stolen card.',
      refund: 'none',
      code: await code(owner),
    });
    expect(none.json().status).toBe('cancelled');
    expect(ctx.gateway.refunded.length).toBe(before);

    const finished = await aPaidBooking(provider.id);
    await ctx.db.update(bookings).set({ status: 'completed' }).where(eq(bookings.id, finished.id));
    const again = await asStaff(owner, `/bookings/${finished.id}/cancel`, { reason: 'Too late.', refund: 'full', code: await code(owner) });
    expect(again.json().error.code).toBe('not_cancellable');
  });
});

describe('closing a business that still has rentals booked', () => {
  it('refuses without the override, as before', async () => {
    const provider = await seedProvider(ctx.db);
    await aPaidBooking(provider.id);
    const res = await asStaff(owner, `/providers/${provider.id}/close`, { reason: 'Owner retired.', code: await code(owner) });
    expect(res.json().error.code).toBe('has_live_rental');
  });

  it('with the override, cancels and refunds every upcoming rental and closes — Owner and above only', async () => {
    const provider = await seedProvider(ctx.db);
    const first = await aPaidBooking(provider.id, { held: true });
    const second = await aPaidBooking(provider.id);

    const notOwner = await asStaff(administrator, `/providers/${provider.id}/close`, {
      reason: 'Owner retired.',
      override: true,
      code: await code(administrator),
    });
    expect(notOwner.statusCode).toBe(403);

    const closed = await asStaff(owner, `/providers/${provider.id}/close`, {
      reason: 'Owner retired.',
      override: true,
      code: await code(owner),
    });
    expect(closed.statusCode).toBe(200);
    expect((await ctx.db.select().from(providers).where(eq(providers.id, provider.id)))[0]!.deletedAt).not.toBeNull();
    for (const booking of [first, second]) {
      const row = await bookingRow(booking.id);
      expect(row).toMatchObject({ status: 'cancelled', cancelledBy: 'staff' });
      expect(ctx.gateway.refunded.some((refund) => refund.paymentId === row.stripePaymentIntentId)).toBe(true);
    }
  });

  it('with the override, still refuses while a car is out with a renter — and changes nothing', async () => {
    const provider = await seedProvider(ctx.db);
    const upcoming = await aPaidBooking(provider.id);
    const underWay = await aPaidBooking(provider.id);
    await ctx.db.update(bookings).set({ status: 'active' }).where(eq(bookings.id, underWay.id));

    const res = await asStaff(owner, `/providers/${provider.id}/close`, {
      reason: 'Owner retired.',
      override: true,
      code: await code(owner),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain(underWay.reference);
    expect(res.json().error.message).toContain('Nothing was changed');
    expect((await bookingRow(upcoming.id)).status).toBe('upcoming');
    expect((await ctx.db.select().from(providers).where(eq(providers.id, provider.id)))[0]!.deletedAt).toBeNull();
  });
});
