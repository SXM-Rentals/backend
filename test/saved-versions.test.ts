// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the Godfather's saved versions — the copy of the
// audit log, bookings, payments and the rest that can be browsed, searched,
// sorted and put back after a clear or a delete.
//
// The tests that matter most: only the Godfather can see or use any of it; a
// version is saved only on request; putting back returns exactly what was deleted
// (a booking with its price lines, signature and review) and NEVER overwrites
// what is there now; a record that cannot go back says why while the rest do; it
// keeps working after Stripe has gone live; and none of it writes to the audit
// log.

import { eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  bookingPriceLines,
  bookings,
  bookingSignatures,
  dataVersionRecords,
  dataVersions,
  deposits,
  disputes,
  ledgerEntries,
  payouts,
  refundRequests,
  reviews,
  vehicles,
} from '../src/db/schema/index.js';
import { recordAudit } from '../src/services/admin/audit.js';
import { settleStripeMode } from '../src/services/payments/stripe-mode.js';
import {
  createSignedInStaff,
  createTestContext,
  seedBooking,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

type Staff = Awaited<ReturnType<typeof createSignedInStaff>>;
const quiet = { info: () => {}, warn: () => {} };

let ctx: TestContext;
let godfather: Staff;
let owner: Staff;
let administrator: Staff;
let viewer: Staff;

const call = (who: Staff, method: 'GET' | 'POST', url: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { cookie: who.cookie, origin: WEB_ORIGIN },
    ...(payload ? { payload } : {}),
    remoteAddress: uniqueIp(),
  });
const withCode = async (who: Staff, extra: object = {}) => ({ code: await generateOtp({ secret: who.secret }), ...extra });
const clear = async (what: string) => (await call(godfather, 'POST', '/test-data/clear', await withCode(godfather, { what, reason: 'Resetting.' }))).json();
const save = async (note?: string) => (await call(godfather, 'POST', '/backups', note ? { note } : undefined)).json();
const restore = async (versionId: string, extra: object = {}) =>
  call(godfather, 'POST', `/backups/${versionId}/restore`, await withCode(godfather, extra));
const count = async (table: PgTable) => (await ctx.db.select().from(table)).length;

// A booking with all its records: a deposit, a payment, a payout, a refund request,
// a dispute — and its own price line, signature and review.
async function aFullBooking() {
  const seeded = await seedBooking(ctx.db);
  const id = seeded.booking.id;
  await ctx.db.update(bookings).set({ status: 'completed', paymentStatus: 'paid' }).where(eq(bookings.id, id));
  await ctx.db.insert(deposits).values({ bookingId: id, amountCents: 50000 });
  await ctx.db.insert(ledgerEntries).values({
    bookingId: id,
    kind: 'charge',
    amountCents: seeded.booking.totalDueTodayCents,
    status: 'succeeded',
    stripeRef: `pi_${id.slice(0, 8)}`,
    occurredAt: new Date(),
  });
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
  await ctx.db.insert(refundRequests).values({ bookingId: id, amountCents: 1000, reasonGiven: 'Testing.' });
  await ctx.db
    .insert(disputes)
    .values({ reference: `DSP-${id.slice(0, 6)}`, bookingId: id, openedBy: 'customer', subject: 'Scratch', detail: 'A scratch.' });
  await ctx.db.insert(bookingPriceLines).values({ bookingId: id, label: 'Rental', amountCents: 19500, position: 0 });
  await ctx.db.insert(bookingSignatures).values({ bookingId: id, width: 300, height: 100, strokes: ['M0 0L10 10'], signedAt: new Date() });
  await ctx.db.insert(reviews).values({ bookingId: id, vehicleId: seeded.vehicle.id, customerId: seeded.customer.id, rating: 5, body: 'Great.' });
  return seeded;
}

type Seeded = Awaited<ReturnType<typeof aFullBooking>>;
let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
  godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
  owner = await createSignedInStaff(ctx, 'Olivia Owner', 'owner');
  administrator = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');
  viewer = await createSignedInStaff(ctx, 'Vera Viewer', 'viewer');
  a = await aFullBooking();
  b = await aFullBooking();
  for (let i = 0; i < 3; i += 1) {
    await recordAudit(ctx.db, {
      staffId: godfather.staffId,
      action: 'account_updated',
      subjectType: 'customer',
      subjectId: `customer-${i}`,
      subjectLabel: `Customer · Test ${i}`,
      field: 'Phone',
      before: 'one',
      after: 'two',
      reason: 'Fixing a typo.',
    });
  }
});
afterAll(async () => {
  await ctx.close();
});

let versionId = '';

describe('who may see and use saved versions', () => {
  it('is the Godfather only — saving, looking, restoring and deleting', async () => {
    for (const who of [owner, administrator, viewer]) {
      for (const [method, url] of [
        ['GET', '/backups'],
        ['POST', '/backups'],
        ['GET', `/backups/${a.booking.id}`],
        ['GET', `/backups/${a.booking.id}/records`],
      ] as const) {
        const res = await call(who, method, url);
        expect(res.statusCode, `${who.name} ${method} ${url}`).toBe(403);
        expect(res.json().error.code).toBe(url === '/backups' && method === 'POST' && who === viewer ? 'read_only' : 'not_allowed');
      }
      expect((await call(who, 'POST', `/backups/${a.booking.id}/restore`, await withCode(who))).statusCode).toBe(403);
      expect((await call(who, 'POST', `/backups/${a.booking.id}/delete`, await withCode(who))).statusCode).toBe(403);
    }
    expect(await count(dataVersions)).toBe(0);
  });

  it('starts with nothing saved: nothing is copied until it is asked for', async () => {
    const res = await call(godfather, 'GET', '/backups');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ limit: 20, versions: [] });
    expect(res.json().kinds.map((kind: { kind: string }) => kind.kind)).toEqual([
      'audit_log',
      'bookings',
      'payments',
      'payouts',
      'deposits',
      'refunds',
      'disputes',
    ]);
  });
});

describe('saving a version', () => {
  it('copies everything, and says what it holds', async () => {
    const res = await call(godfather, 'POST', '/backups', { note: 'Before the big clear-out' });
    expect(res.statusCode).toBe(201);
    const version = res.json();
    versionId = version.id;
    expect(version).toMatchObject({
      note: 'Before the big clear-out',
      createdBy: { id: godfather.staffId, name: 'Gio Godfather' },
      counts: { audit_log: 3, bookings: 2, payments: 2, payouts: 2, deposits: 2, refunds: 2, disputes: 2 },
      missing: { audit_log: 0, bookings: 0, payments: 0, payouts: 0, deposits: 0, refunds: 0, disputes: 0 },
    });
    expect(await count(dataVersionRecords)).toBe(15);
  });

  it('can be saved with no body at all, and without a note', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/backups',
      headers: { cookie: godfather.cookie, origin: WEB_ORIGIN, 'content-type': 'application/json' },
      remoteAddress: uniqueIp(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().note).toBe('');
    await call(godfather, 'POST', `/backups/${res.json().id}/delete`, await withCode(godfather));
  });

  it('keeps at most twenty', async () => {
    const full = await createTestContext();
    try {
      const boss = await createSignedInStaff(full, 'Gio Godfather', 'godfather');
      for (let i = 0; i < 20; i += 1) await full.db.insert(dataVersions).values({ counts: {} });
      const res = await full.app.inject({
        method: 'POST',
        url: '/api/v1/admin/backups',
        headers: { cookie: boss.cookie, origin: WEB_ORIGIN },
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('too_many_versions');
      expect(await full.db.select().from(dataVersions)).toHaveLength(20);
    } finally {
      await full.close();
    }
  });
});

describe('looking inside a version', () => {
  const records = async (query = '') => (await call(godfather, 'GET', `/backups/${versionId}/records${query}`)).json();

  it('lists everything, every record still in the live tables', async () => {
    const all = await records('?limit=200');
    expect(all.total).toBe(15);
    expect(all.records.every((record: { inLive: boolean }) => record.inLive)).toBe(true);
    expect((await records('?show=missing')).total).toBe(0);
  });

  it('filters by kind and searches', async () => {
    expect((await records('?kind=bookings')).total).toBe(2);
    const found = await records(`?q=${a.booking.reference}`);
    expect(found.records.map((record: { kind: string }) => record.kind)).toContain('bookings');
    expect(found.records.every((record: { summary: string }) => record.summary.includes(a.booking.reference))).toBe(true);
    expect((await records('?q=nothing-like-this')).total).toBe(0);
    // A percent sign is a character, not a wildcard.
    expect((await records('?q=%25')).total).toBe(0);
  });

  it('sorts by date, name, amount and kind, either way', async () => {
    const amounts = (await records('?kind=bookings&sort=amount&dir=asc')).records.map((r: { amountCents: number }) => r.amountCents);
    expect(amounts).toEqual([...amounts].sort((x, y) => x - y));
    const names = (await records('?kind=audit_log&sort=summary&dir=asc')).records.map((r: { summary: string }) => r.summary);
    expect(names).toEqual([...names].sort());
    const reversed = (await records('?kind=audit_log&sort=summary&dir=desc')).records.map((r: { summary: string }) => r.summary);
    expect(reversed).toEqual([...names].reverse());
    const kinds = (await records('?sort=kind&dir=asc&limit=200')).records.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual([...kinds].sort());
    expect((await call(godfather, 'GET', `/backups/${versionId}/records?sort=colour`)).statusCode).toBe(400);
  });

  it('pages', async () => {
    const first = await records('?sort=summary&dir=asc&limit=5');
    const second = await records('?sort=summary&dir=asc&limit=5&offset=5');
    expect(first.records).toHaveLength(5);
    expect(second.total).toBe(15);
    expect(first.records.map((r: { id: string }) => r.id)).not.toEqual(second.records.map((r: { id: string }) => r.id));
  });

  it('opens one record in full, a booking with its own records inside', async () => {
    const [row] = (await records(`?kind=bookings&q=${a.booking.reference}`)).records;
    const one = (await call(godfather, 'GET', `/backups/${versionId}/records/${row.id}`)).json();
    expect(one).toMatchObject({ kind: 'bookings', recordId: a.booking.id, inLive: true });
    expect(one.data.row.reference).toBe(a.booking.reference);
    expect(one.data.children.priceLines).toHaveLength(1);
    expect(one.data.children.signature).toHaveLength(1);
    expect(one.data.children.review).toHaveLength(1);
  });

  it('answers 404 for a version or record that is not there', async () => {
    const nobody = '00000000-0000-4000-8000-000000000000';
    for (const url of [`/backups/${nobody}`, `/backups/${nobody}/records`, `/backups/not-an-id`, `/backups/${versionId}/records/${nobody}`, `/backups/${versionId}/records/not-an-id`]) {
      expect((await call(godfather, 'GET', url)).statusCode, url).toBe(404);
    }
  });
});

describe('putting things back', () => {
  it('needs the code: a wrong one changes nothing', async () => {
    await clear('deposits');
    const res = await call(godfather, 'POST', `/backups/${versionId}/restore`, { code: '000000' });
    expect(res.json().error.code).toBe('wrong_code');
    expect(await count(deposits)).toBe(0);
    expect((await call(godfather, 'POST', `/backups/${versionId}/delete`, { code: '000000' })).json().error.code).toBe('wrong_code');
    expect(await count(dataVersions)).toBe(1);
  });

  it('shows what is gone, so the Godfather can see exactly what a restore would bring back', async () => {
    const gone = (await call(godfather, 'GET', `/backups/${versionId}/records?show=missing`)).json();
    expect(gone.total).toBe(2);
    expect(gone.records.every((record: { kind: string; inLive: boolean }) => record.kind === 'deposits' && !record.inLive)).toBe(true);
    expect((await call(godfather, 'GET', `/backups/${versionId}`)).json().missing).toMatchObject({ deposits: 2, bookings: 0 });
  });

  it('puts back just one kind, or just chosen records', async () => {
    const [first] = (await call(godfather, 'GET', `/backups/${versionId}/records?kind=deposits`)).json().records;
    const one = await restore(versionId, { recordIds: [first.id] });
    expect(one.json()).toMatchObject({ restored: 1, alreadyThere: 0, failedCount: 0, byKind: { deposits: { restored: 1 } } });
    expect(await count(deposits)).toBe(1);

    const rest = await restore(versionId, { kind: 'deposits' });
    expect(rest.json()).toMatchObject({ restored: 1, alreadyThere: 1, failedCount: 0 });
    expect(await count(deposits)).toBe(2);
    // The bookings were never touched.
    expect(await count(bookings)).toBe(2);
  });

  it('puts back everything that was cleared, in order, a booking with its price lines, signature and review', async () => {
    // Clear it all, the way the Test Data screen does: deposits, bookings (which
    // takes their refund requests and disputes), payouts, payments, the audit log.
    for (const what of ['deposits', 'bookings', 'payouts', 'payments', 'audit_log']) await clear(what);
    expect(await count(bookings)).toBe(0);
    expect(await count(auditLog)).toBe(0);
    expect(await count(reviews)).toBe(0);
    expect((await call(godfather, 'GET', `/backups/${versionId}`)).json().missing).toMatchObject({
      audit_log: 3,
      bookings: 2,
      payments: 2,
      payouts: 2,
      deposits: 2,
      refunds: 2,
      disputes: 2,
    });

    const res = await restore(versionId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restored: 15, alreadyThere: 0, failedCount: 0, failed: [] });
    expect(res.json().detail).toBe('15 record(s) put back. ');

    for (const table of [bookings, deposits, ledgerEntries, payouts, refundRequests, disputes, bookingPriceLines, bookingSignatures, reviews]) {
      expect(await count(table)).toBe(2);
    }
    expect(await count(auditLog)).toBe(3);

    // Whole again: the booking is linked to its payout, and its payment to it.
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, a.booking.id));
    expect(booking).toMatchObject({ reference: a.booking.reference, status: 'completed', paymentStatus: 'paid' });
    expect(booking!.payoutId).not.toBeNull();
    expect((await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, a.booking.id)))).toHaveLength(1);
    expect((await ctx.db.select().from(reviews).where(eq(reviews.bookingId, a.booking.id)))[0]).toMatchObject({ rating: 5, body: 'Great.' });
    expect((await call(godfather, 'GET', `/backups/${versionId}`)).json().missing).toMatchObject({ bookings: 0, audit_log: 0 });
  });

  it('never overwrites what is there now: an edited booking stays as it was edited', async () => {
    await ctx.db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, a.booking.id));
    const res = await restore(versionId);
    expect(res.json()).toMatchObject({ restored: 0, alreadyThere: 15, failedCount: 0 });
    expect(res.json().detail).toBe('Nothing needed putting back. 15 were already there and left as they are. ');
    expect((await ctx.db.select().from(bookings).where(eq(bookings.id, a.booking.id)))[0]!.status).toBe('cancelled');
    await ctx.db.update(bookings).set({ status: 'completed' }).where(eq(bookings.id, a.booking.id));
  });
});

describe('a record that cannot go back', () => {
  it('says why, and everything else still goes back', async () => {
    // One booking's car is gone for good; the other booking and all else is cleared.
    for (const what of ['deposits', 'bookings', 'payments']) await clear(what);
    await ctx.db.delete(vehicles).where(eq(vehicles.id, a.vehicle.id));

    const res = await restore(versionId);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    const why = Object.fromEntries(body.failed.map((f: { kind: string; why: string }) => [f.kind, f.why]));
    expect(why.bookings).toBe('its car, customer or business has since been deleted');
    expect(why.deposits).toBe('its booking is not there — put the booking back first');
    // The first booking and its deposit could not return; the second's did.
    expect(body.failedCount).toBe(4);
    expect(await count(bookings)).toBe(1);
    expect((await ctx.db.select().from(bookings))[0]!.id).toBe(b.booking.id);
    expect(await count(deposits)).toBe(1);
    // Payment lines go back whatever happened to the booking: its one is detached.
    const lines = await ctx.db.select().from(ledgerEntries);
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.bookingId === null)).toHaveLength(1);
    expect(body.detail).toContain('could not be put back — each says why.');
  });

  it('lets a booking go back without a payout that is gone, owed again', async () => {
    await clear('deposits');
    await clear('bookings');
    await clear('payouts');
    const res = await restore(versionId, { kind: 'bookings' });
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, b.booking.id));
    expect(res.json().restored).toBeGreaterThanOrEqual(1);
    expect(booking!.payoutId).toBeNull();
  });
});

describe('after Stripe has gone live', () => {
  it('still saves, looks, restores and deletes — and the clears are shut', async () => {
    await settleStripeMode(ctx.db, 'sk_live_abc', quiet);
    expect((await call(godfather, 'POST', '/test-data/clear', await withCode(godfather, { what: 'bookings', reason: 'Resetting.' }))).statusCode).toBe(403);

    const fresh = await save('Live');
    expect(fresh.counts.bookings).toBeGreaterThanOrEqual(1);
    expect((await call(godfather, 'GET', '/backups')).statusCode).toBe(200);
    expect((await restore(fresh.id)).statusCode).toBe(200);
    expect((await call(godfather, 'POST', `/backups/${fresh.id}/delete`, await withCode(godfather))).statusCode).toBe(200);
  });
});

describe('what it leaves in the audit log', () => {
  it('nothing: saving, looking, putting back and deleting a version write no entry', async () => {
    await ctx.db.delete(auditLog);
    const made = await save('No trace');
    await call(godfather, 'GET', '/backups');
    await call(godfather, 'GET', `/backups/${made.id}/records`);
    await restore(made.id, { kind: 'bookings' });
    await call(godfather, 'POST', `/backups/${made.id}/delete`, await withCode(godfather));
    expect(await count(auditLog)).toBe(0);
  });

  it('deleting a version removes its records with it', async () => {
    const before = await count(dataVersionRecords);
    const res = await call(godfather, 'POST', `/backups/${versionId}/delete`, await withCode(godfather));
    expect(res.json()).toEqual({ id: versionId, deleted: true });
    expect(await count(dataVersionRecords)).toBeLessThan(before);
    expect((await call(godfather, 'GET', `/backups/${versionId}`)).statusCode).toBe(404);
    expect((await ctx.db.select().from(dataVersionRecords).where(eq(dataVersionRecords.versionId, versionId)))).toHaveLength(0);
  });
});
