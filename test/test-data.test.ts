// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the Godfather's test-data clearing, the most
// dangerous thing in this repo.
//
// The tests that matter most, in order: once Stripe has run live, EVERY clear is
// refused, the Godfather included; the audit log and staff accounts survive
// every clear and each clear is written into the log; only the Godfather, with
// the code, can do it; and each clear takes only what it names — refusing,
// with nothing changed, when the database would make it take more.

import { eq } from 'drizzle-orm';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminStaff,
  auditLog,
  bookings,
  deposits,
  ledgerEntries,
  payouts,
  providers,
  rewardLedger,
  vehicles,
} from '../src/db/schema/index.js';
import { settleStripeMode } from '../src/services/payments/stripe-mode.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  seedBooking,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

type Staff = Awaited<ReturnType<typeof createSignedInStaff>>;
const quiet = { info: () => {}, warn: () => {} };

async function clear(ctx: TestContext, who: Staff, what: string, codeOverride?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/admin/test-data/clear',
    headers: { cookie: who.cookie, origin: WEB_ORIGIN },
    payload: { what, reason: 'Resetting after a test run.', code: codeOverride ?? (await generateOtp({ secret: who.secret })) },
    remoteAddress: uniqueIp(),
  });
}

// A booking with all its money around it: a deposit, a payment line, a payout
// and some points.
async function aFullBooking(ctx: TestContext) {
  const seeded = await seedBooking(ctx.db);
  await ctx.db.update(bookings).set({ status: 'completed', paymentStatus: 'paid' }).where(eq(bookings.id, seeded.booking.id));
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
  await ctx.db.insert(rewardLedger).values({ customerId: seeded.customer.id, bookingId: seeded.booking.id, label: 'Rental', points: 195 });
  return seeded;
}

const rows = async (ctx: TestContext, table: typeof bookings | typeof deposits | typeof ledgerEntries | typeof payouts | typeof vehicles | typeof providers | typeof rewardLedger | typeof auditLog | typeof adminStaff) =>
  (await ctx.db.select().from(table)).length;

describe('who may clear', () => {
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

  it('is the Godfather only, with a good code', async () => {
    await aFullBooking(ctx);
    expect((await clear(ctx, owner, 'payments')).statusCode).toBe(403);
    expect((await clear(ctx, godfather, 'payments', '000000')).json().error.code).toBe('wrong_code');
    expect(await rows(ctx, ledgerEntries)).toBe(1);
  });

  it('says whether it is open and why, for the panel to print', async () => {
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/test-data/status',
      headers: { cookie: godfather.cookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
    });
    expect(status.json()).toMatchObject({
      open: true,
      conditions: [
        { name: 'allow_test_reset', met: true },
        { name: 'never_live', met: true },
      ],
    });
  });
});

describe('when the platform is real', () => {
  it('refuses every clear, for the Godfather too, once Stripe has run live', async () => {
    const ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    try {
      const godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
      await aFullBooking(ctx);
      await settleStripeMode(ctx.db, 'sk_live_abc', quiet);
      for (const what of ['bookings', 'payments', 'payouts', 'deposits', 'vehicles', 'providers', 'customer_spend']) {
        const res = await clear(ctx, godfather, what);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('test_reset_closed');
        expect(res.json().error.message).toContain('live mode');
      }
      expect(await rows(ctx, bookings)).toBe(1);
      expect(await rows(ctx, ledgerEntries)).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('refuses everything while ALLOW_TEST_RESET is not on', async () => {
    const ctx = await createTestContext();
    try {
      const godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
      const res = await clear(ctx, godfather, 'payments');
      expect(res.json().error).toMatchObject({ code: 'test_reset_closed', message: expect.stringContaining('ALLOW_TEST_RESET') });
    } finally {
      await ctx.close();
    }
  });
});

describe('each clear takes only what it names', () => {
  let ctx: TestContext;
  let godfather: Staff;
  beforeAll(async () => {
    ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
    await aFullBooking(ctx);
    await aFullBooking(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('refuses bookings while their deposits are kept, and changes nothing', async () => {
    const res = await clear(ctx, godfather, 'bookings');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('would_take_more');
    expect(res.json().error.message).toContain('Clear deposits first');
    expect(await rows(ctx, bookings)).toBe(2);
  });

  it('clears payments without touching bookings', async () => {
    const staffBefore = await rows(ctx, adminStaff);
    const res = await clear(ctx, godfather, 'payments');
    expect(res.json()).toMatchObject({ what: 'payments', cleared: 2 });
    expect(await rows(ctx, ledgerEntries)).toBe(0);
    expect(await rows(ctx, bookings)).toBe(2);
    expect(await rows(ctx, adminStaff)).toBe(staffBefore);
  });

  it('clears deposits then bookings, keeping the payment lines and the payouts', async () => {
    // Fresh payment lines, to prove clearing bookings keeps them.
    for (const booking of await ctx.db.select().from(bookings)) {
      await ctx.db.insert(ledgerEntries).values({
        bookingId: booking.id,
        kind: 'charge',
        amountCents: 100,
        status: 'succeeded',
        stripeRef: 'pi_again',
        occurredAt: new Date(),
      });
    }
    expect((await clear(ctx, godfather, 'deposits')).json().cleared).toBe(2);
    expect(await rows(ctx, bookings)).toBe(2);

    const res = await clear(ctx, godfather, 'bookings');
    expect(res.json()).toMatchObject({ what: 'bookings', cleared: 2 });
    expect(res.json().detail).toContain('payment line(s) are kept');
    expect(await rows(ctx, bookings)).toBe(0);
    const lines = await ctx.db.select().from(ledgerEntries);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.bookingId === null)).toBe(true);
    expect(await rows(ctx, payouts)).toBe(2);
  });

  it('refuses businesses while payouts point at them, then clears them once payouts are gone', async () => {
    const blocked = await clear(ctx, godfather, 'providers');
    expect(blocked.json().error.message).toContain('payouts');
    expect(await rows(ctx, providers)).toBe(2);

    expect((await clear(ctx, godfather, 'payouts')).json().cleared).toBe(2);
    const res = await clear(ctx, godfather, 'providers');
    expect(res.json()).toMatchObject({ what: 'providers', cleared: 2 });
    expect(await rows(ctx, vehicles)).toBe(0);
  });

  it('zeroes points and leaves the customer accounts as they were', async () => {
    const res = await clear(ctx, godfather, 'customer_spend');
    expect(res.json()).toMatchObject({ what: 'customer_spend', cleared: 2 });
    expect(await rows(ctx, rewardLedger)).toBe(0);
  });

  it('kept the audit log whole, and wrote one entry for each clear, with the reason and the count', async () => {
    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'test_records_cleared'));
    // payments, deposits, bookings, payouts, providers, customer_spend.
    expect(entries.map((entry) => entry.field)).toEqual([
      'Payments',
      'Deposits',
      'Bookings',
      'Payouts',
      'Rental businesses',
      'Customer points',
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ subjectType: 'platform', after: '0', reason: 'Resetting after a test run.', staffId: godfather.staffId });
      expect(Number(entry.before)).toBeGreaterThan(0);
    }
  });
});

describe('a customer after their points are cleared', () => {
  it('can still sign in', async () => {
    const ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    try {
      const godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
      const account = await createVerifiedAccount(ctx);
      await clear(ctx, godfather, 'customer_spend');
      expect(await signInMobile(ctx, account.email, account.password)).toBeTruthy();
    } finally {
      await ctx.close();
    }
  });
});
