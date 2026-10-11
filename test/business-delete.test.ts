// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests staff deleting a rental business for good, rather
// than closing it.
//
// The tests that matter most: only Owner and Godfather can do it, with the
// authenticator code; a business that never traded goes with everything that
// was only its own, while the people who ran it keep their accounts; and a
// business with bookings or payouts on record is refused with nothing changed —
// except test data before launch, which the Godfather may delete whole, taking
// only that business's records and nobody else's.

import { eq } from 'drizzle-orm';
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

async function deleteBusiness(ctx: TestContext, who: Staff, id: string, codeOverride?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/admin/providers/${id}/delete`,
    headers: { cookie: who.cookie, origin: WEB_ORIGIN },
    payload: { reason: 'Signed up twice by mistake.', code: codeOverride ?? (await generateOtp({ secret: who.secret })) },
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

// A business that has traded: a paid booking with a deposit, a payment line, a
// payout, a refund request and a dispute.
async function aTradedBusiness(ctx: TestContext) {
  const seeded = await seedBooking(ctx.db);
  await ctx.db.insert(deposits).values({ bookingId: seeded.booking.id, amountCents: 50000 });
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

const count = async (ctx: TestContext, table: typeof providers | typeof vehicles | typeof bookings | typeof deposits | typeof ledgerEntries | typeof payouts | typeof customers) =>
  (await ctx.db.select().from(table)).length;

describe('deleting a business on the live platform', () => {
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
    expect((await ctx.db.select().from(providers).where(eq(providers.id, provider.id))).length).toBe(1);
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
    expect((await deleteBusiness(ctx, godfather, provider.id)).statusCode).toBe(200);
    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, provider.id));
    expect(entries[0]!.before).toBe('Closed');
  });

  it('refuses a business that has traded, for the Godfather too, and changes nothing', async () => {
    const seeded = await aTradedBusiness(ctx);
    const before = await Promise.all([providers, vehicles, bookings, deposits, ledgerEntries, payouts].map((table) => count(ctx, table)));
    for (const who of [owner, godfather]) {
      const res = await deleteBusiness(ctx, who, seeded.provider.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('has_history');
      expect(res.json().error.message).toContain('1 booking(s) and 1 payout(s)');
      expect(res.json().error.message).toContain('Close it instead');
      expect(res.json().error.message).toContain('Nothing was changed.');
    }
    const after = await Promise.all([providers, vehicles, bookings, deposits, ledgerEntries, payouts].map((table) => count(ctx, table)));
    expect(after).toEqual(before);
  });
});

describe('deleting a business before launch, with test-data clearing open', () => {
  let ctx: TestContext;
  let godfather: Staff;
  let owner: Staff;
  beforeAll(async () => {
    ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
    owner = await createSignedInStaff(ctx, 'Olivia Owner', 'owner');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('lets the Godfather alone delete a traded business with its test history, and only that business', async () => {
    const doomed = await aTradedBusiness(ctx);
    const other = await aTradedBusiness(ctx);

    expect((await deleteBusiness(ctx, owner, doomed.provider.id)).json().error.code).toBe('has_history');

    const res = await deleteBusiness(ctx, godfather, doomed.provider.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toEqual({
      deposits: 1,
      refundRequests: 1,
      disputes: 1,
      paymentLines: 1,
      bookings: 1,
      payouts: 1,
      vehicles: 1,
    });
    expect(res.json().detail).toContain('Its test history went with it');

    // The other business, and both renters, are exactly as they were.
    expect(await ctx.db.select().from(providers)).toEqual([expect.objectContaining({ id: other.provider.id })]);
    expect(await ctx.db.select().from(bookings)).toEqual([expect.objectContaining({ id: other.booking.id })]);
    for (const table of [deposits, ledgerEntries, payouts, vehicles]) {
      expect(await count(ctx, table)).toBe(1);
    }
    expect(await count(ctx, customers)).toBe(2);

    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'business_deleted'));
    expect(entry!.after).toBe('Deleted, with 1 car(s), 1 booking(s) and 1 payout(s) (test data)');
  });
});
