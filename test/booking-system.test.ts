// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests connecting a business's own rental software: the
// API key, the partner API it opens, and the bookings sent back to the
// business's system.
//
// The tests that matter most are about trust: the full key is shown once and
// never stored; a new key cancels the old one at once; making a key needs the
// owner's password; a webhook can never point inside a private network, even by
// a name that resolves there; every message is signed; and a key only ever
// reaches its own business.

import { createHash, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customers, providerIntegrations, providerMembers, vehicleBlocks } from '../src/db/schema/index.js';
import type { IntegrationService } from '../src/services/integrations/index.js';
import {
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

type Sent = { url: string; headers: Record<string, string>; body: string };
const sent: Sent[] = [];
let answerWith = 200;
// A stand-in for the business's system, and for looking names up.
const fakeSend: typeof fetch = async (input, init) => {
  sent.push({
    url: String(input),
    headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    body: String(init?.body ?? ''),
  });
  return new Response('ok', { status: answerWith });
};
const fakeResolve = async (hostname: string) => {
  if (hostname === 'bookings.example.com') return ['93.184.216.34'];
  if (hostname === 'sneaky.example.com') return ['10.0.0.8'];
  throw new Error('not found');
};

let ctx: TestContext;
let ownerToken: string;
let ownerPassword: string;
let providerId: string;
let customerToken: string;
let rivalToken: string;
let vehicleId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: auth(token), remoteAddress: uniqueIp(), ...(payload ? { payload } : {}) });
const partner = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, key: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/partner/v1${url}`,
    headers: { authorization: `Bearer ${key}` },
    remoteAddress: uniqueIp(),
    ...(payload ? { payload } : {}),
  });
const settled = () => (ctx.app as unknown as { integrations: IntegrationService }).integrations.settled();

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

beforeAll(async () => {
  ctx = await createTestContext({
    env: { FEATURES: 'bookingSystem' },
    partnerSend: fakeSend,
    partnerResolve: fakeResolve,
  });
  const owner = await createVerifiedAccount(ctx);
  ownerPassword = owner.password;
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  providerId = (await send('POST', '/providers/apply', ownerToken, application('Connected Cars'))).json().providerId;
  vehicleId = (await seedVehicle(ctx.db, providerId, { registration: 'CON-1' })).id;

  const rival = await createVerifiedAccount(ctx);
  rivalToken = await signInMobile(ctx, rival.email, rival.password);
  await send('POST', '/providers/apply', rivalToken, application('Rival Connected'));

  const customer = await createVerifiedAccount(ctx);
  customerToken = await signInMobile(ctx, customer.email, customer.password);
});
afterAll(async () => {
  await ctx.close();
});

let apiKey: string;

describe('the API key', () => {
  it('starts not connected, with the partner address and its guide', async () => {
    const res = (await send('GET', '/providers/me/integration', ownerToken)).json();
    expect(res).toMatchObject({ status: 'not_connected', apiKeyLast4: null, bookingsWebhook: null, lastError: null });
    expect(res.pushEndpoint).toMatch(/\/partner\/v1$/);
    expect(res.docsUrl).toMatch(/\/partner\/v1\/docs$/);
    const guide = await ctx.app.inject({ method: 'GET', url: '/partner/v1/docs' });
    expect(guide.body).toContain('X-SXM-Signature');
  });

  it('needs the password, is shown once, and only a hash is kept', async () => {
    const wrong = await send('POST', '/providers/me/integration/key', ownerToken, { password: 'not my password' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('wrong_password');

    const made = await send('POST', '/providers/me/integration/key', ownerToken, { password: ownerPassword });
    expect(made.statusCode).toBe(201);
    apiKey = made.json().apiKey;
    expect(apiKey).toMatch(/^sxm_live_[A-Za-z0-9]{32}$/);

    const [row] = await ctx.db.select().from(providerIntegrations).where(eq(providerIntegrations.providerId, providerId));
    expect(row!.apiKeyHash).toBe(createHash('sha256').update(apiKey).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(apiKey);

    const after = (await send('GET', '/providers/me/integration', ownerToken)).json();
    expect(after).toMatchObject({ status: 'connected', apiKeyLast4: apiKey.slice(-4) });
    expect(JSON.stringify(after)).not.toContain(apiKey);
  });

  it('is the owner to make, not a colleague', async () => {
    const colleague = await createVerifiedAccount(ctx);
    const token = await signInMobile(ctx, colleague.email, colleague.password);
    const [person] = await ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.email, colleague.email));
    await ctx.db.insert(providerMembers).values({ providerId, customerId: person!.id, role: 'staff' });
    const res = await send('POST', '/providers/me/integration/key', token, { password: colleague.password });
    expect(res.json().error.code).toBe('owner_only');
  });
});

describe('the partner API', () => {
  it('refuses a missing or made-up key', async () => {
    expect((await partner('GET', '/vehicles', 'sxm_live_madeup')).statusCode).toBe(401);
    const none = await ctx.app.inject({ method: 'GET', url: '/partner/v1/vehicles', remoteAddress: uniqueIp() });
    expect(none.json().error.code).toBe('invalid_api_key');
  });

  it('reaches only its own cars, changes prices, and reports last synced', async () => {
    const cars = (await partner('GET', '/vehicles', apiKey)).json();
    expect(cars.map((car: { id: string }) => car.id)).toEqual([vehicleId]);
    expect(cars[0].registration).toBe('CON-1');

    const priced = await partner('PATCH', `/vehicles/${vehicleId}`, apiKey, { dailyRate: 72.5, weeklyRate: 450 });
    expect(priced.json()).toMatchObject({ dailyRate: 72.5, weeklyRate: 450 });
    // Only prices: a partner cannot rename the car.
    expect((await partner('PATCH', `/vehicles/${vehicleId}`, apiKey, { make: 'Ferrari' })).statusCode).toBe(400);

    const rivalCar = await seedVehicle(ctx.db, (await send('GET', '/providers/me', rivalToken)).json().providerId);
    expect((await partner('PATCH', `/vehicles/${rivalCar.id}`, apiKey, { dailyRate: 1 })).statusCode).toBe(404);

    expect((await send('GET', '/providers/me/integration', ownerToken)).json().lastSyncedAt).not.toBeNull();
  });

  it('replaces its own unavailable days, leaves the owner blocks alone, and names bookings on them', async () => {
    const booking = (await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(20), endDate: dateIn(23) })).json();
    await ctx.db.insert(vehicleBlocks).values({ vehicleId, startDate: dateIn(40), endDate: dateIn(41), reason: 'servicing' });

    const first = await partner('PUT', `/vehicles/${vehicleId}/unavailable`, apiKey, {
      periods: [
        { startDate: dateIn(22), endDate: dateIn(24) },
        { startDate: dateIn(30), endDate: dateIn(31) },
      ],
    });
    expect(first.json()).toEqual({ periods: 2, alreadyBookedOnSxm: [booking.reference] });

    await partner('PUT', `/vehicles/${vehicleId}/unavailable`, apiKey, { periods: [{ startDate: dateIn(50), endDate: dateIn(50) }] });
    const blocks = await ctx.db.select().from(vehicleBlocks).where(eq(vehicleBlocks.vehicleId, vehicleId));
    expect(blocks.map((block) => [block.source, block.startDate]).sort()).toEqual(
      [
        ['business', dateIn(40)],
        ['partner', dateIn(50)],
      ].sort(),
    );
  });
});

describe('bookings sent to the business system', () => {
  it('refuses a webhook that is not https or points inside a private network', async () => {
    const http = await send('PUT', '/providers/me/integration/webhook', ownerToken, { url: 'http://bookings.example.com/sxm' });
    expect(http.json().error.code).toBe('invalid_url');
    const local = await send('PUT', '/providers/me/integration/webhook', ownerToken, { url: 'https://127.0.0.1/sxm' });
    expect(local.json().error.code).toBe('invalid_url');
    // A public-looking name that resolves to a private address.
    const sneaky = await send('PUT', '/providers/me/integration/webhook', ownerToken, { url: 'https://sneaky.example.com/sxm' });
    expect(sneaky.json().error.code).toBe('invalid_url');

    const good = await send('PUT', '/providers/me/integration/webhook', ownerToken, { url: 'https://bookings.example.com/sxm' });
    expect(good.statusCode).toBe(200);
    expect(good.json().bookingsWebhook).toBe('https://bookings.example.com/sxm');
  });

  it('sends each new booking, signed with the hash of the key, with no contact details', async () => {
    sent.length = 0;
    const booking = (await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(60), endDate: dateIn(62) })).json();
    await settled();

    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.url).toBe('https://bookings.example.com/sxm');
    expect(message.headers['x-sxm-event']).toBe('booking.created');
    const body = JSON.parse(message.body);
    expect(body).toMatchObject({ type: 'booking.created', booking: { id: booking.id, reference: booking.reference } });
    expect(message.body).not.toMatch(/@example\.com|\+1 721/);

    const [, t, v1] = message.headers['x-sxm-signature']!.match(/^t=(\d+),v1=([0-9a-f]+)$/)!;
    const secret = createHash('sha256').update(apiKey).digest('hex');
    expect(createHmac('sha256', secret).update(`${t}.${message.body}`).digest('hex')).toBe(v1);

    sent.length = 0;
    await send('POST', `/bookings/${booking.id}/cancel`, customerToken, {});
    await settled();
    expect(sent.map((item) => item.headers['x-sxm-event'])).toEqual(['booking.cancelled']);
  });

  it('shows failing, with what went wrong, until a message gets through', async () => {
    answerWith = 500;
    await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(70), endDate: dateIn(72) });
    await settled();
    const failing = (await send('GET', '/providers/me/integration', ownerToken)).json();
    expect(failing.status).toBe('failing');
    expect(failing.lastError).toContain('answered 500');

    answerWith = 200;
    await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(80), endDate: dateIn(82) });
    await settled();
    expect((await send('GET', '/providers/me/integration', ownerToken)).json()).toMatchObject({ status: 'connected', lastError: null });
  });
});

describe('a new key, and disconnecting', () => {
  it('cancels the old key at once, and disconnecting cancels everything', async () => {
    const old = apiKey;
    apiKey = (await send('POST', '/providers/me/integration/key', ownerToken, { password: ownerPassword })).json().apiKey;
    expect((await partner('GET', '/vehicles', old)).statusCode).toBe(401);
    expect((await partner('GET', '/vehicles', apiKey)).statusCode).toBe(200);

    const off = await send('POST', '/providers/me/integration/disconnect', ownerToken, { password: ownerPassword });
    expect(off.json()).toMatchObject({ status: 'not_connected', apiKeyLast4: null, bookingsWebhook: null });
    expect((await partner('GET', '/vehicles', apiKey)).statusCode).toBe(401);
  });
});
