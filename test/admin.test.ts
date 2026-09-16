// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the staff admin panel — the locked door, and the
// work behind it.
//
// The tests that matter most: a password alone gets nobody in, a customer's
// sign-in is worthless here, the two-factor secret is never stored in plain
// text, every change is written into the audit log with the reason given, and
// an account cannot be closed while a rental is running or a deposit is held.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate as generateOtp, verify as verifyOtp } from 'otplib';
import { adminStaff, auditLog, bookings, customers, deposits, vehicles } from '../src/db/schema/index.js';
import { decryptSecret } from '../src/lib/crypto.js';
import {
  ADMIN_COOKIE,
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
let staff: Awaited<ReturnType<typeof createSignedInStaff>>;
let customerToken: string;
let providerId: string;
let vehicleId: string;
let bookingId: string;

const asStaff = (cookie = staff.cookie) => ({ cookie, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const patch = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'PATCH', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const del = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'DELETE', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });

beforeAll(async () => {
  ctx = await createTestContext();
  staff = await createSignedInStaff(ctx);

  // A business with a car, and a customer who books it.
  const provider = await seedProvider(ctx.db, { verificationStatus: 'pending', isVerified: false });
  providerId = provider.id;
  const vehicle = await seedVehicle(ctx.db, providerId, { depositAmountCents: 30000 });
  vehicleId = vehicle.id;

  const account = await createVerifiedAccount(ctx);
  customerToken = await signInMobile(ctx, account.email, account.password);
  const booking = await post(
    '/bookings',
    { vehicleId, startDate: dateIn(20), endDate: dateIn(23) },
    { authorization: `Bearer ${customerToken}`, origin: WEB_ORIGIN },
  );
  bookingId = booking.json().id;
});
afterAll(async () => {
  await ctx.close();
});

describe('the locked door', () => {
  it('lets nobody in without signing in', async () => {
    expect((await get('/admin/summary')).statusCode).toBe(401);
    expect((await get('/admin/queue')).statusCode).toBe(401);
    expect((await get('/admin/users')).statusCode).toBe(401);
  });

  it("is not opened by a customer's sign-in", async () => {
    const res = await get('/admin/summary', { authorization: `Bearer ${customerToken}` });
    expect(res.statusCode).toBe(401);
  });

  it('treats a correct password alone as not signed in', async () => {
    const email = 'halfway@sxmrentals.test';
    const password = 'another long staff passphrase';
    const { createAdminAuthService } = await import('../src/services/admin/auth.js');
    await createAdminAuthService({ db: ctx.db, config: ctx.config, logger: { warn: () => {} } }).createStaff({
      name: 'Halfway There',
      email,
      password,
    });

    const login = await post('/admin/auth/login', { email, password });
    expect(login.statusCode).toBe(200);
    // Not signed in: the authenticator app still has to be set up.
    expect(login.json().next).toBe('enroll');

    const cookie = `${ADMIN_COOKIE}=${login.cookies.find((c) => c.name === ADMIN_COOKIE)!.value}`;
    expect((await get('/admin/summary', { cookie })).statusCode).toBe(401);
    expect((await get('/admin/users', { cookie })).statusCode).toBe(401);
  });

  it('refuses a wrong code, and locks the account after five', async () => {
    const email = 'lockme@sxmrentals.test';
    const password = 'yet another long passphrase';
    const { createAdminAuthService } = await import('../src/services/admin/auth.js');
    await createAdminAuthService({ db: ctx.db, config: ctx.config, logger: { warn: () => {} } }).createStaff({
      name: 'Lock Me',
      email,
      password,
    });
    const login = await post('/admin/auth/login', { email, password });
    const cookie = `${ADMIN_COOKIE}=${login.cookies.find((c) => c.name === ADMIN_COOKIE)!.value}`;
    await post('/admin/auth/mfa/enroll', {}, { cookie, origin: WEB_ORIGIN });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await post('/admin/auth/mfa/verify', { code: '000000' }, { cookie, origin: WEB_ORIGIN });
      expect(wrong.statusCode).toBe(401);
    }
    const locked = await post('/admin/auth/mfa/verify', { code: '000000' }, { cookie, origin: WEB_ORIGIN });
    expect(locked.statusCode).toBe(429);
  });

  it('never stores the two-factor secret in plain text', async () => {
    const [row] = await ctx.db.select().from(adminStaff).where(eq(adminStaff.id, staff.staffId));
    expect(row!.mfaSecretEncrypted).toBeTruthy();
    expect(row!.mfaSecretEncrypted).not.toContain(staff.secret);
    // Only the key in the environment can turn it back into a working secret.
    expect(decryptSecret(row!.mfaSecretEncrypted!, ctx.config.encryptionKey)).toBe(staff.secret);
    const token = await generateOtp({ secret: staff.secret });
    expect((await verifyOtp({ secret: staff.secret, token })).valid).toBe(true);
  });

  it('can be shut to addresses that are not ours', async () => {
    const restricted = await createTestContext({ env: { ADMIN_IP_ALLOWLIST: '203.0.113.9' } });
    try {
      const theirStaff = await createSignedInStaff(restricted);
      const fromElsewhere = await restricted.app.inject({
        method: 'GET',
        url: '/api/v1/admin/summary',
        headers: { cookie: theirStaff.cookie },
        remoteAddress: '198.51.100.4',
      });
      expect(fromElsewhere.statusCode).toBe(403);

      const fromTheOffice = await restricted.app.inject({
        method: 'GET',
        url: '/api/v1/admin/summary',
        headers: { cookie: theirStaff.cookie },
        remoteAddress: '203.0.113.9',
      });
      expect(fromTheOffice.statusCode).toBe(200);
    } finally {
      await restricted.close();
    }
  });
});

describe('every change is recorded', () => {
  it('refuses a change with no reason, and writes the reason it is given', async () => {
    const noReason = await post(`/admin/providers/${providerId}/verification`, { approve: true }, asStaff());
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.code).toBe('invalid_input');

    const approved = await post(
      `/admin/providers/${providerId}/verification`,
      { approve: true, reason: 'Chamber of Commerce registration and insurance both checked.' },
      asStaff(),
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().isVerified).toBe(true);

    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, providerId));
    expect(entry).toMatchObject({
      action: 'verification_approved',
      subjectType: 'provider',
      field: 'Verification',
      before: 'pending',
      after: 'approved',
      staffId: staff.staffId,
    });
    expect(entry!.reason).toContain('Chamber of Commerce');

    // And it is readable back, with the name of whoever did it.
    const log = await get('/admin/audit', asStaff());
    expect(log.json()[0]).toMatchObject({ staffName: staff.name, action: 'verification_approved' });
  });

  it('records a points adjustment as a before and an after', async () => {
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const targetId = booking!.customerId;

    const before = (await get(`/admin/users/${targetId}`, asStaff())).json().points;
    const adjusted = await patch(
      `/admin/users/${targetId}/points`,
      { points: 500, reason: 'Goodwill after a late collection.' },
      asStaff(),
    );
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.json().points).toBe(before + 500);

    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, targetId));
    expect(entries.some((entry) => entry.action === 'points_adjusted' && entry.after === '500')).toBe(true);
  });
});

describe('approving what customers can see', () => {
  it('makes a car visible only once staff approve the listing', async () => {
    const [pending] = await ctx.db
      .update(vehicles)
      .set({ listingStatus: 'pending_review', make: 'Daihatsu' })
      .where(eq(vehicles.id, vehicleId))
      .returning();
    expect(pending!.listingStatus).toBe('pending_review');
    expect((await get('/vehicles?search=Daihatsu')).json()).toEqual([]);

    const approved = await post(
      `/admin/vehicles/${vehicleId}/listing`,
      { approve: true, reason: 'Registration and insurance both current.' },
      asStaff(),
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().listingStatus).toBe('live');

    const search = await get('/vehicles?search=Daihatsu');
    expect(search.json()).toHaveLength(1);
  });
});

describe('deposits, from the staff side', () => {
  it('releases one, and records it', async () => {
    // Put a hold on the deposit first.
    await post(
      `/deposits/bookings/${bookingId}/authorize`,
      {},
      { authorization: `Bearer ${customerToken}`, origin: WEB_ORIGIN },
    );
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, bookingId));
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'test-signature' },
      payload: JSON.stringify(
        ctx.gateway.eventFor('payment_intent.amount_capturable_updated', deposit!.stripePaymentIntentId!),
      ),
      remoteAddress: uniqueIp(),
    });

    const released = await post(
      `/admin/deposits/${deposit!.id}/release`,
      { reason: 'Car returned in good order.' },
      asStaff(),
    );
    expect(released.statusCode).toBe(204);

    const [after] = await ctx.db.select().from(deposits).where(eq(deposits.id, deposit!.id));
    expect(after!.status).toBe('released');
    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, deposit!.id));
    expect(entries.some((entry) => entry.action === 'deposit_released')).toBe(true);
  });

  it('will not keep more of a deposit than was held', async () => {
    const account = await createVerifiedAccount(ctx);
    const token = await signInMobile(ctx, account.email, account.password);
    const booking = await post(
      '/bookings',
      { vehicleId, startDate: dateIn(40), endDate: dateIn(43) },
      { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
    );
    await post(
      `/deposits/bookings/${booking.json().id}/authorize`,
      {},
      { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
    );
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking.json().id));
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'test-signature' },
      payload: JSON.stringify(
        ctx.gateway.eventFor('payment_intent.amount_capturable_updated', deposit!.stripePaymentIntentId!),
      ),
      remoteAddress: uniqueIp(),
    });

    const tooMuch = await post(
      `/admin/deposits/${deposit!.id}/claim`,
      { amount: 5000, reason: 'Wing mirror replaced' },
      asStaff(),
    );
    expect(tooMuch.statusCode).toBe(400);

    const kept = await post(
      `/admin/deposits/${deposit!.id}/claim`,
      { amount: 125, reason: 'Wing mirror replaced, invoice on file.' },
      asStaff(),
    );
    expect(kept.statusCode).toBe(204);

    const [claimed] = await ctx.db.select().from(deposits).where(eq(deposits.id, deposit!.id));
    expect(claimed).toMatchObject({ status: 'claimed', claimedAmountCents: 12500 });
    expect(claimed!.claimReason).toContain('Wing mirror');
  });
});

describe('closing a customer account', () => {
  it('is blocked while a rental is still to come', async () => {
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const blocked = await del(
      `/admin/users/${booking!.customerId}`,
      { reason: 'Customer asked us to close it.' },
      asStaff(),
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('has_live_rental');
  });

  it('closes one with nothing outstanding, and records it', async () => {
    const account = await createVerifiedAccount(ctx);
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.email, account.email));

    const closed = await del(
      `/admin/users/${customer!.id}`,
      { reason: 'Customer asked us to close it.' },
      asStaff(),
    );
    expect(closed.statusCode).toBe(204);

    const [after] = await ctx.db.select().from(customers).where(eq(customers.id, customer!.id));
    expect(after!.deletedAt).toBeTruthy();
    // The row stays, so the audit trail still points at something real.
    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, customer!.id));
    expect(entries.some((entry) => entry.action === 'account_deleted')).toBe(true);
  });
});

describe('the headline figures', () => {
  it('always has gross money equal to payouts plus commission, with deposits apart', async () => {
    const summary = (await get('/admin/summary', asStaff())).json();
    expect(summary.gmv).toBeCloseTo(summary.paidOutToProviders + summary.commissionRetained, 5);
    expect(typeof summary.depositsCurrentlyHeld).toBe('number');
    expect(summary.bookingTrend).toHaveLength(6);
  });

  it('lists what is waiting, oldest first', async () => {
    const queue = (await get('/admin/queue', asStaff())).json();
    const dates = queue.map((item: { waitingSince: string }) => item.waitingSince);
    expect([...dates].sort()).toEqual(dates);
    for (const item of queue) {
      expect(['verification', 'dispute', 'refund']).toContain(item.kind);
      expect(['normal', 'aging', 'overdue']).toContain(item.urgency);
    }
  });
});
