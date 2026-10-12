// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests staff deleting a rental business for good, rather
// than closing it — one rule for an Owner, another for the Godfather.
//
// The tests that matter most: the GODFATHER deletes a business immediately — an
// empty body, no code, whatever its history, no test-reset window, no audit row,
// nothing sent to Stripe, all or nothing — while an OWNER is exactly as
// restricted as before: a reason and the code, a business that has traded is
// refused, the deletion is logged, and anybody below Owner is refused.

import { eq, sql } from 'drizzle-orm';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  bookings,
  chatThreads,
  customers,
  deposits,
  disputes,
  fleetRequests,
  ledgerEntries,
  payouts,
  providerMembers,
  providers,
  refundRequests,
  vehicles,
} from '../src/db/schema/index.js';
import {
  createSignedInStaff,
  createTestContext,
  seedBooking,
  seedCustomer,
  seedProvider,
  seedVehicle,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

type Staff = Awaited<ReturnType<typeof createSignedInStaff>>;

// An Owner's request: a reason and a code.
async function deleteBusiness(ctx: TestContext, who: Staff, id: string, codeOverride?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/admin/providers/${id}/delete`,
    headers: { cookie: who.cookie, origin: WEB_ORIGIN },
    payload: { reason: 'Signed up twice by mistake.', code: codeOverride ?? (await generateOtp({ secret: who.secret })) },
    remoteAddress: uniqueIp(),
  });
}

// The Godfather's request, as the panel sends it: nothing in the body. With the
// JSON label on it, as a browser helper that always sets one would send it.
async function deleteWithNothing(ctx: TestContext, who: Staff, id: string, labelledJson = true) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/admin/providers/${id}/delete`,
    headers: { cookie: who.cookie, origin: WEB_ORIGIN, ...(labelledJson ? { 'content-type': 'application/json' } : {}) },
    remoteAddress: uniqueIp(),
  });
}

// A business that never traded: two cars, an owner, a conversation and a fleet
// request.
async function anUntradedBusiness(ctx: TestContext, name: string) {
  const provider = await seedProvider(ctx.db, { businessName: name });
  await seedVehicle(ctx.db, provider.id);
  await seedVehicle(ctx.db, provider.id);
  const owner = await seedCustomer(ctx.db);
  await ctx.db.insert(providerMembers).values({ providerId: provider.id, customerId: owner.id, role: 'owner' });
  await ctx.db.insert(chatThreads).values({ customerId: owner.id, providerId: provider.id });
  await ctx.db
    .insert(fleetRequests)
    .values({ providerId: provider.id, requestedBy: owner.id, fleetSize: '2', recordFormat: 'paper', contact: 'Call me.' });
  return { provider, owner };
}

// A business that has traded: a paid booking with a HELD deposit, a payment
// line, a PENDING payout, a refund request and a dispute.
async function aTradedBusiness(ctx: TestContext, name?: string) {
  const seeded = await seedBooking(ctx.db);
  if (name) await ctx.db.update(providers).set({ businessName: name }).where(eq(providers.id, seeded.provider.id));
  await ctx.db.insert(deposits).values({
    bookingId: seeded.booking.id,
    amountCents: 50000,
    status: 'held',
    stripePaymentIntentId: `pi_hold_${seeded.booking.id.slice(0, 8)}`,
  });
  await ctx.db.insert(ledgerEntries).values({
    bookingId: seeded.booking.id,
    kind: 'charge',
    amountCents: seeded.booking.totalDueTodayCents,
    status: 'succeeded',
    stripeRef: `pi_${seeded.booking.id.slice(0, 8)}`,
    occurredAt: new Date(),
  });
  const [payout] = await ctx.db
    .insert(payouts)
    .values({
      reference: `PO-${seeded.booking.id.slice(0, 8)}`,
      providerId: seeded.provider.id,
      amountCents: seeded.booking.payoutCents,
      grossCents: seeded.booking.grossCents,
      commissionCents: seeded.booking.commissionCents,
      bookingCount: 1,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-07',
    })
    .returning();
  await ctx.db.update(bookings).set({ payoutId: payout!.id }).where(eq(bookings.id, seeded.booking.id));
  await ctx.db.insert(refundRequests).values({ bookingId: seeded.booking.id, amountCents: 1000, reasonGiven: 'Testing.' });
  await ctx.db.insert(disputes).values({
    reference: `DSP-${seeded.booking.id.slice(0, 6)}`,
    bookingId: seeded.booking.id,
    openedBy: 'customer',
    subject: 'Scratch',
    detail: 'A scratch on the door.',
  });
  return seeded;
}

type Table = typeof providers | typeof vehicles | typeof bookings | typeof deposits | typeof ledgerEntries | typeof payouts | typeof customers | typeof auditLog | typeof refundRequests | typeof disputes;
const count = async (ctx: TestContext, table: Table) => (await ctx.db.select().from(table)).length;
const counts = (ctx: TestContext, tables: Table[]) => Promise.all(tables.map((table) => count(ctx, table)));
const EVERYTHING_OF_A_BUSINESS: Table[] = [providers, vehicles, bookings, deposits, ledgerEntries, payouts, refundRequests, disputes];

// What the stand-in Stripe has been asked to do so far.
const stripeSoFar = (ctx: TestContext) =>
  JSON.stringify([ctx.gateway.captured, ctx.gateway.cancelled, ctx.gateway.refunded, ctx.gateway.transfers, ctx.gateway.offSessionHolds, [...ctx.gateway.created.keys()]]);

describe('an Owner deleting a business', () => {
  let ctx: TestContext;
  let godfather: Staff;
  let owner: Staff;
  let administrator: Staff;
  beforeAll(async () => {
    // No ALLOW_TEST_RESET: this is how the live platform runs.
    ctx = await createTestContext();
    godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
    owner = await createSignedInStaff(ctx, 'Olivia Owner', 'owner');
    administrator = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('is Owner and above, with a good code', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Not Yet Rentals');
    expect((await deleteBusiness(ctx, administrator, provider.id)).statusCode).toBe(403);
    expect((await deleteBusiness(ctx, owner, provider.id, '000000')).json().error.code).toBe('wrong_code');
    expect(await ctx.db.select().from(providers).where(eq(providers.id, provider.id))).toHaveLength(1);
  });

  it('is told "not allowed" below Owner before anything is said about the body', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Still Not Rentals');
    for (const labelledJson of [true, false]) {
      const res = await deleteWithNothing(ctx, administrator, provider.id, labelledJson);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_allowed');
    }
    expect(await ctx.db.select().from(providers).where(eq(providers.id, provider.id))).toHaveLength(1);
  });

  it('still needs a reason and a code: an empty body is a 400, labelled JSON or not', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Empty Body Rentals');
    for (const labelledJson of [true, false]) {
      const res = await deleteWithNothing(ctx, owner, provider.id, labelledJson);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_input');
    }
    expect(await ctx.db.select().from(providers).where(eq(providers.id, provider.id))).toHaveLength(1);
  });

  it('removes a business that never traded, with its cars, and keeps the people who ran it', async () => {
    const { provider, owner: personWhoRanIt } = await anUntradedBusiness(ctx, 'Twice Rentals');
    const res = await deleteBusiness(ctx, owner, provider.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: provider.id,
      businessName: 'Twice Rentals',
      deleted: true,
      removed: { vehicles: 2, bookings: 0, payouts: 0 },
    });
    expect(res.json().detail).toContain('keep their own accounts');

    expect(await ctx.db.select().from(providers).where(eq(providers.id, provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(vehicles).where(eq(vehicles.providerId, provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(providerMembers).where(eq(providerMembers.providerId, provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(chatThreads).where(eq(chatThreads.providerId, provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(fleetRequests).where(eq(fleetRequests.providerId, provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(customers).where(eq(customers.id, personWhoRanIt.id))).toHaveLength(1);

    // An Owner's delete is still logged, with the reason.
    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'business_deleted'));
    expect(entry).toMatchObject({
      staffId: owner.staffId,
      subjectType: 'provider',
      subjectId: provider.id,
      subjectLabel: 'Business · Twice Rentals',
      before: 'Open',
      after: 'Deleted, with 2 car(s)',
      reason: 'Signed up twice by mistake.',
    });

    const gone = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/providers/${provider.id}`,
      headers: { cookie: owner.cookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('deletes a closed business too, and says it was closed', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Shut Rentals');
    await ctx.db.update(providers).set({ deletedAt: new Date() }).where(eq(providers.id, provider.id));
    expect((await deleteBusiness(ctx, owner, provider.id)).statusCode).toBe(200);
    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, provider.id));
    expect(entries[0]!.before).toBe('Closed');
  });

  it('refuses a business that has traded, and changes nothing', async () => {
    const seeded = await aTradedBusiness(ctx);
    const before = await counts(ctx, EVERYTHING_OF_A_BUSINESS);
    const res = await deleteBusiness(ctx, owner, seeded.provider.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('has_history');
    expect(res.json().error.message).toContain('1 booking(s) and 1 payout(s)');
    expect(res.json().error.message).toContain('Close it instead');
    expect(res.json().error.message).toContain('Nothing was changed.');
    expect(await counts(ctx, EVERYTHING_OF_A_BUSINESS)).toEqual(before);
  });

  it('is refused the same way with test-data clearing open: the window gives an Owner nothing', async () => {
    const open = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    try {
      const someOwner = await createSignedInStaff(open, 'Olivia Owner', 'owner');
      const seeded = await aTradedBusiness(open);
      const res = await deleteBusiness(open, someOwner, seeded.provider.id);
      expect(res.json().error.code).toBe('has_history');
      expect(await count(open, bookings)).toBe(1);
    } finally {
      await open.close();
    }
  });

  it('is not changed by the Godfather being able to do more: the Godfather path writes no business_deleted row', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Godfather Rentals');
    const before = await count(ctx, auditLog);
    expect((await deleteWithNothing(ctx, godfather, provider.id)).statusCode).toBe(200);
    expect(await count(ctx, auditLog)).toBe(before);
  });
});

describe('the Godfather deleting a business', () => {
  let ctx: TestContext;
  let godfather: Staff;
  beforeAll(async () => {
    // No ALLOW_TEST_RESET and no clearing window: it works regardless.
    ctx = await createTestContext();
    godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('deletes at once with an empty body, whatever its history, and leaves every other business alone', async () => {
    const doomed = await aTradedBusiness(ctx, 'Doomed Rentals');
    const other = await aTradedBusiness(ctx, 'Other Rentals');
    const stripeBefore = stripeSoFar(ctx);
    const auditBefore = await count(ctx, auditLog);

    const res = await deleteWithNothing(ctx, godfather, doomed.provider.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: doomed.provider.id,
      businessName: 'Doomed Rentals',
      deleted: true,
      removed: { deposits: 1, refundRequests: 1, disputes: 1, paymentLines: 1, bookings: 1, payouts: 1, vehicles: 1 },
    });
    // The owner's only confirmation, in plain English.
    const detail = res.json().detail as string;
    expect(detail).toContain('Doomed Rentals is deleted, with 1 car, 1 booking, 1 deposit record, 1 payment line, 1 payout, 1 refund request and 1 dispute');
    expect(detail).toContain('Nothing was sent to Stripe');

    // The held deposit, the booking, the pending payout… all gone.
    expect(await ctx.db.select().from(providers).where(eq(providers.id, doomed.provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(bookings).where(eq(bookings.providerId, doomed.provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(deposits).where(eq(deposits.bookingId, doomed.booking.id))).toHaveLength(0);
    expect(await ctx.db.select().from(payouts).where(eq(payouts.providerId, doomed.provider.id))).toHaveLength(0);
    expect(await ctx.db.select().from(refundRequests).where(eq(refundRequests.bookingId, doomed.booking.id))).toHaveLength(0);
    expect(await ctx.db.select().from(disputes).where(eq(disputes.bookingId, doomed.booking.id))).toHaveLength(0);
    expect(await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, doomed.booking.id))).toHaveLength(0);

    // The other business is exactly as it was, and both renters are still there.
    expect(await ctx.db.select().from(providers)).toEqual([expect.objectContaining({ id: other.provider.id })]);
    for (const table of [bookings, deposits, ledgerEntries, payouts, vehicles, refundRequests, disputes]) {
      expect(await count(ctx, table)).toBe(1);
    }
    expect(await count(ctx, customers)).toBe(2);

    // Nothing in the log, and nothing sent to Stripe.
    expect(await count(ctx, auditLog)).toBe(auditBefore);
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'business_deleted'))).toHaveLength(0);
    expect(stripeSoFar(ctx)).toBe(stripeBefore);
  });

  it('works without the JSON label, ignores whatever body it is sent, and needs no code', async () => {
    const plain = await anUntradedBusiness(ctx, 'Plain Rentals');
    expect((await deleteWithNothing(ctx, godfather, plain.provider.id, false)).statusCode).toBe(200);

    const chatty = await anUntradedBusiness(ctx, 'Chatty Rentals');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${chatty.provider.id}/delete`,
      headers: { cookie: godfather.cookie, origin: WEB_ORIGIN },
      payload: { reason: 'x', code: '000000', anything: [1, 2, 3] },
      remoteAddress: uniqueIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(await ctx.db.select().from(providers).where(eq(providers.id, chatty.provider.id))).toHaveLength(0);
  });

  it('deletes a closed business too, and answers 404 for one that is not there', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Shut Rentals');
    await ctx.db.update(providers).set({ deletedAt: new Date() }).where(eq(providers.id, provider.id));
    expect((await deleteWithNothing(ctx, godfather, provider.id)).statusCode).toBe(200);
    expect((await deleteWithNothing(ctx, godfather, provider.id)).statusCode).toBe(404);
  });

  it('still refuses broken JSON, as before', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Broken Rentals');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${provider.id}/delete`,
      headers: { cookie: godfather.cookie, origin: WEB_ORIGIN, 'content-type': 'application/json' },
      payload: '{ not json',
      remoteAddress: uniqueIp(),
    });
    expect(res.statusCode).toBe(400);
    expect(await ctx.db.select().from(providers).where(eq(providers.id, provider.id))).toHaveLength(1);
  });

  it('is all or nothing: if the last step fails, none of the earlier ones stick, and the error says which step', async () => {
    const doomed = await aTradedBusiness(ctx, 'Unlucky Rentals');
    const before = await counts(ctx, EVERYTHING_OF_A_BUSINESS);
    await ctx.db.execute(sql`
      create function block_unlucky() returns trigger as $$
      begin
        if old.business_name = 'Unlucky Rentals' then raise exception 'blocked for the test'; end if;
        return old;
      end $$ language plpgsql`);
    await ctx.db.execute(sql`create trigger block_unlucky before delete on providers for each row execute function block_unlucky()`);
    try {
      const res = await deleteWithNothing(ctx, godfather, doomed.provider.id);
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('delete_failed');
      expect(res.json().error.message).toContain('would not let go of the business itself');
      expect(res.json().error.message).toContain('Nothing was deleted.');
    } finally {
      await ctx.db.execute(sql`drop trigger block_unlucky on providers`);
    }
    // The deposit, the booking, the payout, the car: every earlier step was undone.
    expect(await counts(ctx, EVERYTHING_OF_A_BUSINESS)).toEqual(before);
  });

  it('leaves every other action of the Godfather on the record, as before', async () => {
    const { provider } = await anUntradedBusiness(ctx, 'Closing Rentals');
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${provider.id}/close`,
      headers: { cookie: godfather.cookie, origin: WEB_ORIGIN },
      payload: { reason: 'Asked to close.', code: await generateOtp({ secret: godfather.secret }) },
      remoteAddress: uniqueIp(),
    });
    expect(closed.statusCode).toBe(200);
    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'business_closed'));
    expect(entry).toMatchObject({ staffId: godfather.staffId, subjectId: provider.id, reason: 'Asked to close.' });
  });
});
