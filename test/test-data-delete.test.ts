// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the Godfather deleting ONE test record — one
// booking, one payment line, one audit entry — rather than a whole kind.
//
// The tests that matter most: it is the clear's own terms (Godfather only, with
// the code, and refused for everybody once Stripe has run live); it takes exactly
// the one record and never anything else with it, refusing with a sentence and
// changing nothing when the database would make it; and it leaves no trail in the
// audit log, while any audit entry — old clearing notes included — can itself be
// deleted with nothing put in its place.

import { eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminStaff,
  auditLog,
  bookings,
  customers,
  deposits,
  disputes,
  fleetRequests,
  ledgerEntries,
  payouts,
  providerMembers,
  providers,
  refundRequests,
  supportInteractions,
  supportMessages,
  vehicles,
} from '../src/db/schema/index.js';
import { recordAudit } from '../src/services/admin/audit.js';
import { SINGLE_KINDS } from '../src/services/admin/test-data-single.js';
import { settleStripeMode } from '../src/services/payments/stripe-mode.js';
import { CLEARABLE } from '../src/services/admin/test-data.js';
import {
  createSignedInStaff,
  createTestContext,
  seedBooking,
  seedCustomer,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

type Staff = Awaited<ReturnType<typeof createSignedInStaff>>;
const quiet = { info: () => {}, warn: () => {} };
const NOBODY = '00000000-0000-4000-8000-000000000000';

async function deleteOne(ctx: TestContext, who: Staff, what: string, id: string, codeOverride?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/admin/test-data/delete',
    headers: { cookie: who.cookie, origin: WEB_ORIGIN },
    payload: { what, id, reason: 'One test record too many.', code: codeOverride ?? (await generateOtp({ secret: who.secret })) },
    remoteAddress: uniqueIp(),
  });
}

// A booking with all its records around it: a deposit, a payment line, a payout,
// a refund request, a dispute, a support thread, and a fleet request from its
// business.
async function aFullBooking(ctx: TestContext) {
  const seeded = await seedBooking(ctx.db);
  const id = seeded.booking.id;
  await ctx.db.update(bookings).set({ status: 'completed', paymentStatus: 'paid' }).where(eq(bookings.id, id));
  const [deposit] = await ctx.db.insert(deposits).values({ bookingId: id, amountCents: 50000 }).returning();
  const [payment] = await ctx.db
    .insert(ledgerEntries)
    .values({ bookingId: id, kind: 'charge', amountCents: seeded.booking.totalDueTodayCents, status: 'succeeded', stripeRef: `pi_${id.slice(0, 8)}`, occurredAt: new Date() })
    .returning();
  const [payout] = await ctx.db
    .insert(payouts)
    .values({
      reference: `PO-${id.slice(0, 8)}`,
      providerId: seeded.provider.id,
      amountCents: seeded.booking.payoutCents,
      grossCents: seeded.booking.grossCents,
      commissionCents: seeded.booking.commissionCents,
      bookingCount: 1,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-07',
    })
    .returning();
  await ctx.db.update(bookings).set({ payoutId: payout!.id }).where(eq(bookings.id, id));
  const [refund] = await ctx.db.insert(refundRequests).values({ bookingId: id, amountCents: 1000, reasonGiven: 'Testing.' }).returning();
  const [dispute] = await ctx.db
    .insert(disputes)
    .values({ reference: `DSP-${id.slice(0, 6)}`, bookingId: id, openedBy: 'customer', subject: 'Scratch', detail: 'A scratch on the door.' })
    .returning();
  await ctx.db.insert(supportMessages).values({ customerId: seeded.customer.id, fromStaff: false, body: 'Help, please.' });
  await ctx.db.insert(supportInteractions).values({ customerId: seeded.customer.id, fromEmail: 'renter@example.com', customerMessage: 'Help, please.' });
  const [request] = await ctx.db
    .insert(fleetRequests)
    .values({ providerId: seeded.provider.id, fleetSize: '5', recordFormat: 'spreadsheet', contact: 'Call me.' })
    .returning();
  return { ...seeded, deposit: deposit!, payment: payment!, payout: payout!, refund: refund!, dispute: dispute!, request: request! };
}

type Full = Awaited<ReturnType<typeof aFullBooking>>;

// The id of each kind of record in a booking's set, as the panel sends it.
const idsOf = (full: Full): Record<(typeof SINGLE_KINDS)[number], string> => ({
  bookings: full.booking.id,
  payments: full.payment.id,
  payouts: full.payout.id,
  deposits: full.deposit.id,
  refunds: full.refund.id,
  disputes: full.dispute.id,
  vehicles: full.vehicle.id,
  customers: full.customer.id,
  support: full.customer.id,
  fleet_requests: full.request.id,
  audit_log: NOBODY,
});

// How many rows of everything there are, so a test can say exactly what changed.
async function snapshot(ctx: TestContext) {
  const n = async (table: PgTable) => (await ctx.db.select().from(table)).length;
  return {
    bookings: await n(bookings),
    payments: await n(ledgerEntries),
    payouts: await n(payouts),
    deposits: await n(deposits),
    refunds: await n(refundRequests),
    disputes: await n(disputes),
    vehicles: await n(vehicles),
    customers: await n(customers),
    providers: await n(providers),
    supportMessages: await n(supportMessages),
    supportInteractions: await n(supportInteractions),
    fleetRequests: await n(fleetRequests),
    audit: await n(auditLog),
    staff: await n(adminStaff),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
const changes = (before: Snapshot, after: Snapshot) =>
  Object.fromEntries(
    (Object.keys(before) as (keyof Snapshot)[]).filter((key) => before[key] !== after[key]).map((key) => [key, after[key] - before[key]]),
  );

async function someAuditEntries(ctx: TestContext, staffId: string) {
  for (let i = 0; i < 2; i += 1) {
    await recordAudit(ctx.db, {
      staffId,
      action: 'account_updated',
      subjectType: 'customer',
      subjectId: `customer-${i}`,
      subjectLabel: 'Customer · Test',
      field: 'Phone',
      before: 'one',
      after: 'two',
      reason: 'Fixing a typo.',
    });
  }
  // A note from the earlier version, which records a clearing.
  await ctx.db.insert(auditLog).values({
    staffId,
    action: 'test_records_cleared',
    subjectType: 'platform',
    subjectId: 'test-data',
    subjectLabel: 'Test data',
    field: 'Bookings',
    before: '4',
    after: '0',
    reason: 'An old clearing.',
  });
}

describe('who may delete one record', () => {
  let ctx: TestContext;
  let godfather: Staff;
  let owner: Staff;
  let administrator: Staff;
  let full: Full;
  beforeAll(async () => {
    ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
    owner = await createSignedInStaff(ctx, 'Olivia Owner', 'owner');
    administrator = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');
    full = await aFullBooking(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('is the Godfather only, with a good code, and changes nothing otherwise', async () => {
    const before = await snapshot(ctx);
    for (const who of [owner, administrator]) {
      const res = await deleteOne(ctx, who, 'payments', full.payment.id);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_allowed');
    }
    expect((await deleteOne(ctx, godfather, 'payments', full.payment.id, '000000')).json().error.code).toBe('wrong_code');
    expect(changes(before, await snapshot(ctx))).toEqual({});
  });

  it('answers 404 for a record that is not there, or an id that is not an id', async () => {
    for (const what of SINGLE_KINDS) {
      for (const id of [NOBODY, 'not-an-id']) {
        const res = await deleteOne(ctx, godfather, what, id);
        expect(res.statusCode).toBe(404);
      }
    }
  });

  it('accepts only the kinds that can be deleted one at a time', async () => {
    for (const what of ['everything', 'customer_spend', 'providers', 'messages', 'notifications', 'nonsense']) {
      const res = await deleteOne(ctx, godfather, what, full.payment.id);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_input');
    }
  });

  it('says in the status which kinds can, and exactly those', async () => {
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/test-data/status',
      headers: { cookie: godfather.cookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
    });
    const kinds = status.json().kinds as { what: string; label: string; single: boolean }[];
    expect(kinds.map((kind) => kind.what)).toEqual([...CLEARABLE]);
    expect(kinds.filter((kind) => kind.single).map((kind) => kind.what).sort()).toEqual([...SINGLE_KINDS].sort());
    expect(kinds.find((kind) => kind.what === 'everything')!.single).toBe(false);
    expect(kinds.find((kind) => kind.what === 'bookings')).toEqual({ what: 'bookings', label: 'Bookings', single: true });
  });
});

describe('when the window is shut', () => {
  it('refuses every kind, for the Godfather too, once Stripe has run live', async () => {
    const ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    try {
      const godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
      const ids = idsOf(await aFullBooking(ctx));
      await someAuditEntries(ctx, godfather.staffId);
      const [anEntry] = await ctx.db.select().from(auditLog);
      await settleStripeMode(ctx.db, 'sk_live_abc', quiet);
      const before = await snapshot(ctx);
      for (const what of SINGLE_KINDS) {
        const res = await deleteOne(ctx, godfather, what, what === 'audit_log' ? anEntry!.id : ids[what]);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('test_reset_closed');
        expect(res.json().error.message).toContain('live mode');
      }
      expect(changes(before, await snapshot(ctx))).toEqual({});
    } finally {
      await ctx.close();
    }
  });

  it('refuses everything while ALLOW_TEST_RESET is not on', async () => {
    const ctx = await createTestContext();
    try {
      const godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
      const full = await aFullBooking(ctx);
      const res = await deleteOne(ctx, godfather, 'payments', full.payment.id);
      expect(res.json().error).toMatchObject({ code: 'test_reset_closed', message: expect.stringContaining('ALLOW_TEST_RESET') });
      expect(await ctx.db.select().from(ledgerEntries)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });
});

describe('deleting one record takes only that record', () => {
  let ctx: TestContext;
  let godfather: Staff;
  let a: Full;
  let b: Full;
  beforeAll(async () => {
    ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
    a = await aFullBooking(ctx);
    b = await aFullBooking(ctx);
    await someAuditEntries(ctx, godfather.staffId);
  });
  afterAll(async () => {
    await ctx.close();
  });

  // Each step says exactly how many rows of which tables moved, and by how much.
  async function step(what: string, id: string, expected: Record<string, number>, status = 200) {
    const before = await snapshot(ctx);
    const res = await deleteOne(ctx, godfather, what, id);
    expect(res.statusCode).toBe(status);
    expect(changes(before, await snapshot(ctx))).toEqual(expected);
    return res;
  }

  it('refuses a booking while a deposit points at it, in the words the panel prints, and changes nothing', async () => {
    const res = await step('bookings', a.booking.id, {}, 409);
    expect(res.json().error.code).toBe('would_take_more');
    expect(res.json().error.message).toBe('This booking has a deposit held against it. Delete the deposit first. Nothing was changed.');
  });

  it('deletes one deposit, and nothing else', async () => {
    const res = await step('deposits', a.deposit.id, { deposits: -1 });
    expect(res.json()).toMatchObject({ what: 'deposits', id: a.deposit.id, deleted: true });
    expect(res.json().detail).toContain('Any hold still placed at Stripe stays there');
  });

  it('then deletes that one booking, with its own refund request and dispute, keeping its payment line', async () => {
    const res = await step('bookings', a.booking.id, { bookings: -1, refunds: -1, disputes: -1 });
    expect(res.json().detail).toContain('Its 1 payment line is kept on the Payments screen');
    const [kept] = await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.id, a.payment.id));
    expect(kept!.bookingId).toBeNull();
    // The other booking, with its deposit, payment, refund and dispute, is as it was.
    expect(await ctx.db.select().from(bookings).where(eq(bookings.id, b.booking.id))).toHaveLength(1);
    expect(await ctx.db.select().from(deposits).where(eq(deposits.id, b.deposit.id))).toHaveLength(1);
    expect(await ctx.db.select().from(refundRequests).where(eq(refundRequests.id, b.refund.id))).toHaveLength(1);
    expect(await ctx.db.select().from(disputes).where(eq(disputes.id, b.dispute.id))).toHaveLength(1);
  });

  it('deletes one payment line, one refund request and one dispute', async () => {
    await step('payments', a.payment.id, { payments: -1 });
    await step('refunds', b.refund.id, { refunds: -1 });
    await step('disputes', b.dispute.id, { disputes: -1 });
  });

  it('deletes one payout, and the booking it covered counts as owed again', async () => {
    const res = await step('payouts', b.payout.id, { payouts: -1 });
    expect(res.json().detail).toContain('The 1 booking it covered count as owed again');
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, b.booking.id));
    expect(booking!.payoutId).toBeNull();
  });

  it('refuses a car with bookings against it, then deletes one without', async () => {
    const refused = await step('vehicles', b.vehicle.id, {}, 409);
    expect(refused.json().error.message).toBe('This vehicle has 1 booking against it. Delete that booking first. Nothing was changed.');
    await step('vehicles', a.vehicle.id, { vehicles: -1 });
  });

  it('deletes one support conversation, keyed by the customer, and not the other', async () => {
    const res = await step('support', a.customer.id, { supportMessages: -1, supportInteractions: -1 });
    expect(res.json().detail).toContain('1 message and 1 support record');
    expect((await deleteOne(ctx, godfather, 'support', a.customer.id)).statusCode).toBe(404);
    expect(await ctx.db.select().from(supportMessages).where(eq(supportMessages.customerId, b.customer.id))).toHaveLength(1);
  });

  it('refuses a customer with bookings, then deletes one without', async () => {
    const refused = await step('customers', b.customer.id, {}, 409);
    expect(refused.json().error.message).toBe('This person has 1 booking. Delete that booking first. Nothing was changed.');
    await step('customers', a.customer.id, { customers: -1 });
  });

  it('deletes one fleet request', async () => {
    const res = await step('fleet_requests', a.request.id, { fleetRequests: -1 });
    expect(res.json().detail).toContain('Fleet request from Island Wheels deleted');
  });

  it('left the audit log whole through all of that: no entry written, none touched', async () => {
    expect(await ctx.db.select().from(auditLog)).toHaveLength(3);
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'test_records_cleared'))).toHaveLength(1);
  });

  it('deletes any audit entry, an old clearing note included, and puts nothing in its place', async () => {
    const entries = await ctx.db.select().from(auditLog);
    const note = entries.find((entry) => entry.action === 'test_records_cleared')!;
    const ordinary = entries.find((entry) => entry.action === 'account_updated')!;

    const res = await step('audit_log', note.id, { audit: -1 });
    expect(res.json().detail).toContain('Audit entry for Test data (Bookings) deleted');
    await step('audit_log', ordinary.id, { audit: -1 });

    const left = await ctx.db.select().from(auditLog);
    expect(left).toHaveLength(1);
    expect(left.map((entry) => entry.id)).not.toContain(note.id);
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'test_records_cleared'))).toHaveLength(0);
    // And the very last one can go too, leaving the log empty.
    await step('audit_log', left[0]!.id, { audit: -1 });
    expect(await ctx.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('a customer who runs a business', () => {
  it('is refused, naming the business, and nothing is changed', async () => {
    const ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    try {
      const godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
      const full = await aFullBooking(ctx);
      const runsIt = await seedCustomer(ctx.db);
      await ctx.db.insert(providerMembers).values({ providerId: full.provider.id, customerId: runsIt.id, role: 'owner' });
      const before = await snapshot(ctx);

      const res = await deleteOne(ctx, godfather, 'customers', runsIt.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('would_take_more');
      expect(res.json().error.message).toBe('This person runs a rental business (Island Wheels). Delete the business first. Nothing was changed.');
      expect(changes(before, await snapshot(ctx))).toEqual({});
    } finally {
      await ctx.close();
    }
  });
});

describe('a delete that cannot finish', () => {
  it('changes nothing: the part already done is undone, and the error says so', async () => {
    const ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
    try {
      const godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
      const full = await aFullBooking(ctx);
      await ctx.db.delete(deposits);
      await ctx.db.execute(sql`
        create function block_bookings() returns trigger as $$
        begin raise exception 'blocked for the test'; end $$ language plpgsql`);
      await ctx.db.execute(sql`create trigger block_bookings before delete on bookings for each row execute function block_bookings()`);

      const before = await snapshot(ctx);
      const res = await deleteOne(ctx, godfather, 'bookings', full.booking.id);
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('delete_failed');
      expect(res.json().error.message).toContain('Nothing was changed.');
      expect(changes(before, await snapshot(ctx))).toEqual({});
      // Its payment line was detached and its refund request deleted before the
      // failure: both are back.
      const [line] = await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.id, full.payment.id));
      expect(line!.bookingId).toBe(full.booking.id);
      expect(await ctx.db.select().from(refundRequests)).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });
});
