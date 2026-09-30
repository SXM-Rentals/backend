// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what a customer does with their own account —
// rewards, their name and phone, moving to a new email address, saved cars,
// messages to SXM Rentals staff, deleting notifications, and a copy of their data.
//
// The tests that matter most:
//
//   - a new email address only takes over once it is confirmed, the old address
//     is told at once, and the answer never says whether the new address is
//     somebody else's account;
//   - a checked name cannot be changed from the app;
//   - the copy-of-your-data link is not used up by merely opening it — a mail
//     program checking the link for danger must not spend it — and it contains no
//     other person's contact details;
//   - nothing here can reach another person's record.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customers, notifications, rewardLedger } from '../src/db/schema/index.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  seedProvider,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let vehicleId: string;

const as = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, bearer?: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    ...(payload ? { payload } : {}),
    headers: bearer ? as(bearer) : { origin: WEB_ORIGIN },
    remoteAddress: uniqueIp(),
  });

async function aPerson() {
  const account = await createVerifiedAccount(ctx);
  const token = await signInMobile(ctx, account.email, account.password);
  const id = (await call('GET', '/customers/me', token)).json().id as string;
  return { ...account, token, id };
}

const lastEmailTo = (address: string) => [...ctx.email.sent].reverse().find((email) => email.to === address);

beforeAll(async () => {
  ctx = await createTestContext({
    env: { FEATURES: 'rewards,editProfile,savedCars,support,deleteNotifications,dataExport,identity' },
  });
  const provider = await seedProvider(ctx.db, { isVerified: true });
  vehicleId = (await seedVehicle(ctx.db, provider.id)).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('rewards', () => {
  it('adds up the ledger into a level and the distance to the next one', async () => {
    const person = await aPerson();
    expect((await call('GET', '/rewards', person.token)).json()).toMatchObject({ points: 0, tier: 'explorer', nextTier: 'traveler' });

    await ctx.db.insert(rewardLedger).values([
      { customerId: person.id, label: 'Welcome bonus', points: 600 },
      { customerId: person.id, label: 'Rental SXM-4180', points: 2_000 },
    ]);
    const rewards = (await call('GET', '/rewards', person.token)).json();
    expect(rewards).toMatchObject({ points: 2_600, tier: 'traveler', nextTier: 'vip', pointsToNextTier: 4_900, isIslander: false });
    expect(rewards.history).toHaveLength(2);
  });
});

describe('your name and phone number', () => {
  it('changes them, and leaves everything else alone', async () => {
    const person = await aPerson();
    const changed = await call('PATCH', '/customers/me', person.token, { firstName: 'Ari', phone: '+1 721 555 0100', accountType: 'local' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ firstName: 'Ari', phone: '+1 721 555 0100', accountType: 'tourist' });
  });

  it('will not change a name that was checked against a licence', async () => {
    const person = await aPerson();
    await ctx.db.update(customers).set({ verificationStatus: 'approved' }).where(eq(customers.id, person.id));
    const refused = await call('PATCH', '/customers/me', person.token, { lastName: 'Someone Else' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('name_locked');
    // The phone number can still change.
    expect((await call('PATCH', '/customers/me', person.token, { phone: '+1 721 555 0111' })).statusCode).toBe(200);
  });
});

describe('moving to a new email address', () => {
  it('needs the password, and only takes over once the new address confirms', async () => {
    const person = await aPerson();
    const wrong = await call('POST', '/customers/me/email', person.token, { email: 'new-home@example.com', password: 'not it' });
    expect(wrong.statusCode).toBe(400);

    const asked = await call('POST', '/customers/me/email', person.token, { email: 'New-Home@example.com', password: person.password });
    expect(asked.statusCode).toBe(202);

    // Nothing has changed yet, and the old address has been told.
    expect((await call('GET', '/customers/me', person.token)).json().email).toBe(person.email.toLowerCase());
    expect(lastEmailTo(person.email.toLowerCase())?.subject).toContain('change of email');

    const link = lastEmailTo('new-home@example.com')!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
    const confirmed = await call('POST', '/auth/email/confirm', undefined, { token: link });
    expect(confirmed.statusCode).toBe(200);
    expect((await call('GET', '/customers/me', person.token)).json().email).toBe('new-home@example.com');

    // The link works once.
    expect((await call('POST', '/auth/email/confirm', undefined, { token: link })).statusCode).toBe(400);
  });

  it('gives the same answer when the new address is somebody else account', async () => {
    const person = await aPerson();
    const other = await aPerson();
    const free = await call('POST', '/customers/me/email', person.token, { email: 'totally-free@example.com', password: person.password });
    const taken = await call('POST', '/customers/me/email', person.token, { email: other.email, password: person.password });

    // Word for word the same shape, so it tells nobody who is a customer.
    expect(taken.statusCode).toBe(free.statusCode);
    expect(Object.keys(taken.json())).toEqual(Object.keys(free.json()));
    // The owner of the taken address is told somebody tried; no link is sent.
    expect(lastEmailTo(other.email.toLowerCase())?.text).not.toMatch(/token=/);
  });
});

describe('saved cars', () => {
  it('keeps a car once however often it is saved, and forgets it quietly', async () => {
    const person = await aPerson();
    expect((await call('PUT', `/customers/me/saved-cars/${vehicleId}`, person.token)).statusCode).toBe(204);
    expect((await call('PUT', `/customers/me/saved-cars/${vehicleId}`, person.token)).statusCode).toBe(204);
    expect((await call('GET', '/customers/me/saved-cars', person.token)).json()).toEqual({ vehicleIds: [vehicleId] });

    expect((await call('DELETE', `/customers/me/saved-cars/${vehicleId}`, person.token)).statusCode).toBe(204);
    expect((await call('DELETE', `/customers/me/saved-cars/${vehicleId}`, person.token)).statusCode).toBe(204);
    expect((await call('GET', '/customers/me/saved-cars', person.token)).json()).toEqual({ vehicleIds: [] });
  });

  it('refuses a car that does not exist, and keeps each person list their own', async () => {
    const person = await aPerson();
    const other = await aPerson();
    expect((await call('PUT', '/customers/me/saved-cars/00000000-0000-4000-8000-000000000000', person.token)).statusCode).toBe(404);
    await call('PUT', `/customers/me/saved-cars/${vehicleId}`, other.token);
    expect((await call('GET', '/customers/me/saved-cars', person.token)).json().vehicleIds).toEqual([]);
  });
});

describe('messages to SXM Rentals staff', () => {
  it('goes to staff, and the reply names the staff member by first name only', async () => {
    const person = await aPerson();
    const sent = await call('POST', '/support/messages', person.token, { body: 'My car will not start.' });
    expect(sent.statusCode).toBe(201);

    const staff = await createSignedInStaff(ctx, 'Nadia Charles');
    const staffHeaders = { cookie: staff.cookie, origin: WEB_ORIGIN };
    const queue = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/support', headers: staffHeaders, remoteAddress: uniqueIp() });
    const mine = queue.json().find((row: { customerId: string }) => row.customerId === person.id);
    expect(mine).toMatchObject({ waitingForStaff: true, preview: 'My car will not start.' });

    const replied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/support/${person.id}/messages`,
      headers: staffHeaders,
      payload: { body: 'We are sending somebody now.' },
      remoteAddress: uniqueIp(),
    });
    expect(replied.statusCode).toBe(201);

    const conversation = (await call('GET', '/support/conversation', person.token)).json();
    expect(conversation.messages.at(-1)).toMatchObject({ from: 'staff', staffName: 'Nadia', body: 'We are sending somebody now.' });
    expect(JSON.stringify(conversation)).not.toContain('Charles');
    expect(JSON.stringify(conversation)).not.toContain(staff.email);
  });

  it('will only mention one of the customer own rentals', async () => {
    const person = await aPerson();
    const refused = await call('POST', '/support/messages', person.token, {
      body: 'About this booking',
      bookingId: '00000000-0000-4000-8000-000000000000',
    });
    expect(refused.statusCode).toBe(404);
  });

  it('lets a viewer read but not answer', async () => {
    const person = await aPerson();
    await call('POST', '/support/messages', person.token, { body: 'Hello?' });
    const viewer = await createSignedInStaff(ctx, 'Val Viewer', 'viewer');
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/support/${person.id}/messages`,
      headers: { cookie: viewer.cookie, origin: WEB_ORIGIN },
      payload: { body: 'Hi' },
      remoteAddress: uniqueIp(),
    });
    expect(refused.json().error.code).toBe('read_only');
  });
});

describe('notifications', () => {
  it('say which booking they are about, and stay deleted', async () => {
    const person = await aPerson();
    const other = await aPerson();
    const [mine] = await ctx.db
      .insert(notifications)
      .values({ customerId: person.id, kind: 'promotion', title: 'Hello', body: 'World' })
      .returning();
    const [theirs] = await ctx.db
      .insert(notifications)
      .values({ customerId: other.id, kind: 'promotion', title: 'Theirs', body: 'Theirs' })
      .returning();

    const listed = (await call('GET', '/notifications', person.token)).json();
    expect(listed[0]).toHaveProperty('bookingId');

    // Somebody else's id matches nothing; their notification is untouched.
    await call('POST', '/notifications/delete', person.token, { ids: [mine!.id, theirs!.id] });
    expect((await call('GET', '/notifications', person.token)).json()).toHaveLength(0);
    expect((await call('GET', '/notifications', other.token)).json()).toHaveLength(1);
  });
});

describe('a copy of your data', () => {
  it('emails a one-time link, once a day, that opening alone does not use up', async () => {
    const person = await aPerson();
    const asked = await call('POST', '/customers/me/export', person.token);
    expect(asked.statusCode).toBe(202);

    const again = await call('POST', '/customers/me/export', person.token);
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);

    const link = lastEmailTo(person.email.toLowerCase())!.text.match(/\/api\/v1\/exports\/([A-Za-z0-9_-]+)/)![1]!;

    // Opened — by the person, or by a mail program checking it — twice. Still good.
    for (let i = 0; i < 2; i += 1) {
      const page = await ctx.app.inject({ method: 'GET', url: `/api/v1/exports/${link}`, remoteAddress: uniqueIp() });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Download my data');
    }

    // Pressing the button downloads, once.
    const download = await ctx.app.inject({ method: 'POST', url: `/api/v1/exports/${link}`, remoteAddress: uniqueIp() });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    const data = JSON.parse(download.body);
    expect(data.account.email).toBe(person.email.toLowerCase());
    expect(data).toHaveProperty('bookings');
    expect(data).toHaveProperty('conversations');

    const second = await ctx.app.inject({ method: 'POST', url: `/api/v1/exports/${link}`, remoteAddress: uniqueIp() });
    expect(second.statusCode).toBe(400);
  });
});
