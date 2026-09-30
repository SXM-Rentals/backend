// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests identity checks — through Stripe Identity, or by
// staff — and the one rule that makes them mean something.
//
// The tests that matter most:
//
//   - with identity checks switched on, BOOKING REFUSES a customer who is not
//     approved. The phone checks too, but only this check cannot be skipped;
//   - nothing the customer sends can approve them: only Stripe's own signed
//     message, or a member of staff with a reason on the record;
//   - a message about an old, abandoned check cannot overwrite a newer outcome.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, customers } from '../src/db/schema/index.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedProvider,
  seedVehicle,
  signInMobile,
  TEST_SIGNATURE,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let vehicleId: string;

const as = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const post = (context: TestContext, url: string, payload: object, bearer?: string) =>
  context.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload,
    headers: bearer ? as(bearer) : { origin: WEB_ORIGIN },
    remoteAddress: uniqueIp(),
  });
const get = (context: TestContext, url: string, bearer: string) =>
  context.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as(bearer), remoteAddress: uniqueIp() });

// Stripe telling us, signed, that a check has moved on.
const stripeSays = (context: TestContext, event: object) =>
  context.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': TEST_SIGNATURE },
    payload: JSON.stringify(event),
    remoteAddress: uniqueIp(),
  });

async function aCustomer(context: TestContext) {
  const account = await createVerifiedAccount(context);
  const token = await signInMobile(context, account.email, account.password);
  const [row] = await context.db.select().from(customers).where(eq(customers.email, account.email.toLowerCase()));
  return { token, id: row!.id };
}

let offset = 40;
const book = (context: TestContext, token: string) => {
  offset += 5;
  return post(context, '/bookings', { vehicleId, startDate: dateIn(offset), endDate: dateIn(offset + 2) }, token);
};

beforeAll(async () => {
  // Switched on, and checked through Stripe Identity — with keys, as it would live.
  ctx = await createTestContext({
    env: {
      FEATURES: 'identity',
      IDENTITY_METHOD: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
    },
  });
  const provider = await seedProvider(ctx.db, { isVerified: true });
  vehicleId = (await seedVehicle(ctx.db, provider.id)).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('the rule that makes the check mean something', () => {
  it('refuses to book for somebody not yet approved', async () => {
    const person = await aCustomer(ctx);
    const refused = await book(ctx, person.token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('identity_required');
  });

  it('does not ask while identity checks are switched off', async () => {
    const off = await createTestContext();
    try {
      const provider = await seedProvider(off.db, { isVerified: true });
      const car = await seedVehicle(off.db, provider.id);
      const person = await aCustomer(off);
      const booked = await post(off, '/bookings', { vehicleId: car.id, startDate: dateIn(10), endDate: dateIn(12) }, person.token);
      expect(booked.statusCode).toBe(201);
    } finally {
      await off.close();
    }
  });
});

describe('a check through Stripe Identity', () => {
  it('hands back the address of Stripe page, and the same one if asked again', async () => {
    const person = await aCustomer(ctx);
    const first = await post(ctx, '/verification/sessions', {}, person.token);
    expect(first.statusCode).toBe(200);
    expect(first.json().url).toMatch(/^https:\/\/verify\.stripe/);

    const again = await post(ctx, '/verification/sessions', {}, person.token);
    expect(again.json().url).toBe(first.json().url);
  });

  it('follows what Stripe says, and then lets them book', async () => {
    const person = await aCustomer(ctx);
    await post(ctx, '/verification/sessions', {}, person.token);
    const [row] = await ctx.db.select().from(customers).where(eq(customers.id, person.id));
    const sessionId = row!.identitySessionId!;

    await stripeSays(ctx, ctx.gateway.identityEventFor(sessionId, 'identity.verification_session.processing'));
    expect((await get(ctx, '/customers/me', person.token)).json().verification.status).toBe('pending');

    await stripeSays(ctx, ctx.gateway.identityEventFor(sessionId, 'identity.verification_session.verified'));
    expect((await get(ctx, '/customers/me', person.token)).json().verification.status).toBe('approved');

    expect((await book(ctx, person.token)).statusCode).toBe(201);

    // And asking to start another check is refused, politely.
    const another = await post(ctx, '/verification/sessions', {}, person.token);
    expect(another.statusCode).toBe(409);
    expect(another.json().error.code).toBe('already_verified');
  });

  it('passes on Stripe own reason when it wants the person to try again', async () => {
    const person = await aCustomer(ctx);
    await post(ctx, '/verification/sessions', {}, person.token);
    const [row] = await ctx.db.select().from(customers).where(eq(customers.id, person.id));

    await stripeSays(
      ctx,
      ctx.gateway.identityEventFor(row!.identitySessionId!, 'identity.verification_session.requires_input', 'The photo of the document was too blurry.'),
    );
    const me = (await get(ctx, '/customers/me', person.token)).json();
    expect(me.verification).toMatchObject({ status: 'resubmit', reason: 'The photo of the document was too blurry.' });
  });

  it('ignores a message about a check that is no longer the current one', async () => {
    const person = await aCustomer(ctx);
    await post(ctx, '/verification/sessions', {}, person.token);
    const [before] = await ctx.db.select().from(customers).where(eq(customers.id, person.id));
    const oldSession = before!.identitySessionId!;
    // A newer check replaces it.
    await ctx.db.update(customers).set({ identitySessionId: 'vs_newer' }).where(eq(customers.id, person.id));

    await stripeSays(ctx, ctx.gateway.identityEventFor(oldSession, 'identity.verification_session.verified'));
    const [after] = await ctx.db.select().from(customers).where(eq(customers.id, person.id));
    expect(after!.verificationStatus).not.toBe('approved');
  });

  it('cannot be approved by anything the customer sends', async () => {
    const person = await aCustomer(ctx);
    await post(ctx, '/verification/sessions', {}, person.token);
    // An unsigned "it was verified" is refused before anything reads it.
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_x', type: 'identity.verification_session.verified', data: { object: {} } }),
      remoteAddress: uniqueIp(),
    });
    expect(forged.statusCode).toBe(400);
    expect((await get(ctx, '/customers/me', person.token)).json().verification.status).not.toBe('approved');
  });

  it('sends the person back to the app from a fixed address', async () => {
    const back = await ctx.app.inject({ method: 'GET', url: '/api/v1/verification/return', remoteAddress: uniqueIp() });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('sxmrentals://verify-status');
  });
});

describe('a check by staff', () => {
  it('answers feature_off to the app, so it says staff will do it', async () => {
    const staffWay = await createTestContext({ env: { FEATURES: 'identity', IDENTITY_METHOD: 'staff' } });
    try {
      const person = await aCustomer(staffWay);
      const refused = await post(staffWay, '/verification/sessions', {}, person.token);
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error.code).toBe('feature_off');
    } finally {
      await staffWay.close();
    }
  });

  it('is decided from the admin panel, with the reason on the record', async () => {
    const staff = await createSignedInStaff(ctx);
    const person = await aCustomer(ctx);

    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${person.id}/verification`,
      headers: { cookie: staff.cookie, origin: WEB_ORIGIN },
      payload: { decision: 'rejected', reason: 'Licence photo did not match the name.', customerMessage: 'The name on your licence does not match your account. Please contact us.' },
      remoteAddress: uniqueIp(),
    });
    expect(decided.statusCode).toBe(200);

    // The person sees the message written for them — not the note for staff.
    const me = (await get(ctx, '/customers/me', person.token)).json();
    expect(me.verification.status).toBe('rejected');
    expect(me.verification.reason).toContain('does not match your account');
    expect(JSON.stringify(me)).not.toContain('did not match the name');

    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, person.id));
    expect(entry).toMatchObject({ action: 'verification_rejected', field: 'Identity', after: 'Not approved' });
  });
});
