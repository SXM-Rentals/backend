// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests push notifications — registering a phone, honouring
// each person's choices, what a push may say, and a phone being forgotten when
// its sign-in ends. Expo is stood in for, so nothing leaves this machine.
//
// The tests that matter most:
//
//   - SIGNING OUT REMOVES THE PHONE ON THE SERVER. A lost, wiped or stolen phone
//     never unregisters itself, so the server cannot wait for it to;
//   - a push shown on a locked phone never carries the text of a message or an
//     amount of money — somebody else at the table can read it;
//   - a phone that changes hands stops receiving the previous owner's pushes.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, devices, pushTickets } from '../src/db/schema/index.js';
import type { PushMessage, PushReceipt, PushSender, PushTicket } from '../src/lib/push.js';
import { createPushService } from '../src/services/push/index.js';
import {
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedVehicle,
  signInMobile,
  TEST_SIGNATURE,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

// Stands in for Expo: remembers every push, and can be told a phone has gone.
function fakeExpo() {
  const sent: PushMessage[] = [];
  const gone = new Set<string>();
  const receipts: Record<string, PushReceipt> = {};
  let counter = 0;
  const sender: PushSender & { sent: PushMessage[]; gone: Set<string>; receiptsToGive: Record<string, PushReceipt> } = {
    live: true,
    sent,
    gone,
    receiptsToGive: receipts,
    async send(messages) {
      return messages.map((message): PushTicket => {
        sent.push(message);
        if (gone.has(message.to)) return { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } };
        counter += 1;
        return { status: 'ok', id: `ticket-${counter}` };
      });
    },
    async receipts(ids) {
      return Object.fromEntries(ids.filter((id) => receipts[id]).map((id) => [id, receipts[id]!]));
    },
  };
  return sender;
}

let ctx: TestContext;
let expo: ReturnType<typeof fakeExpo>;
let tokenCounter = 0;
const newPhone = () => `ExponentPushToken[phone${++tokenCounter}]`;

const as = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const post = (url: string, payload: object, bearer: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: as(bearer), remoteAddress: uniqueIp() });
const put = (url: string, payload: object, bearer: string) =>
  ctx.app.inject({ method: 'PUT', url: `/api/v1${url}`, payload, headers: as(bearer), remoteAddress: uniqueIp() });
const get = (url: string, bearer: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as(bearer), remoteAddress: uniqueIp() });

async function aPerson() {
  const account = await createVerifiedAccount(ctx);
  const token = await signInMobile(ctx, account.email, account.password);
  return { ...account, token };
}

async function register(bearer: string, phone = newPhone()) {
  const res = await post('/devices', { token: phone, platform: 'ios' }, bearer);
  expect(res.statusCode).toBe(204);
  return phone;
}

const pushesTo = (phone: string) => expo.sent.filter((message) => message.to === phone);

// A business with a car, and a renter who has written to it.
async function aConversation() {
  const owner = await aPerson();
  const applied = await post(
    '/providers/apply',
    {
      businessName: 'Push Test Rentals',
      legalName: 'Push Test Rentals N.V.',
      contactEmail: 'hello@pushtest.sx',
      ownerName: 'Marie Richardson',
      ownerPhone: '+1 721 555 0188',
      town: 'Simpson Bay',
      side: 'dutch',
      operatingSide: 'dutch',
      description: 'Family run.',
      deliversVehicles: false,
    },
    owner.token,
  );
  const providerId = applied.json().providerId as string;
  const renter = await aPerson();
  const thread = await post('/messages/threads', { providerId, body: 'Is the car automatic?' }, renter.token);
  return { owner, renter, providerId, threadId: thread.json().id as string };
}

beforeAll(async () => {
  expo = fakeExpo();
  ctx = await createTestContext({ env: { FEATURES: 'push', EXPO_ACCESS_TOKEN: 'expo-test' }, pushSender: expo });
});
afterAll(async () => {
  await ctx.close();
});

describe('registering a phone', () => {
  it('accepts only an Expo push address', async () => {
    const person = await aPerson();
    const refused = await post('/devices', { token: 'https://evil.example/hook', platform: 'ios' }, person.token);
    expect(refused.statusCode).toBe(400);
  });

  it('moves a phone to its new owner, so the old one stops receiving', async () => {
    const first = await aPerson();
    const second = await aPerson();
    const phone = await register(first.token);
    await register(second.token, phone);

    // One row, belonging to the second person now — not shared by both.
    const rows = await ctx.db.select().from(devices).where(eq(devices.token, phone));
    expect(rows).toHaveLength(1);
    const secondId = (await get('/customers/me', second.token)).json().id;
    expect(rows[0]?.customerId).toBe(secondId);
  });

  it('keeps at most ten phones per person', async () => {
    const person = await aPerson();
    for (let i = 0; i < 11; i += 1) await register(person.token);
    const [one] = await ctx.db.select().from(devices).where(eq(devices.token, `ExponentPushToken[phone${tokenCounter}]`));
    const mine = await ctx.db.select().from(devices).where(eq(devices.customerId, one!.customerId));
    expect(mine).toHaveLength(10);
  });
});

describe('ending a sign-in forgets its phones', () => {
  it('on signing out', async () => {
    const person = await aPerson();
    const phone = await register(person.token);
    expect((await post('/auth/logout', {}, person.token)).statusCode).toBe(204);
    expect(await ctx.db.select().from(devices).where(eq(devices.token, phone))).toHaveLength(0);
  });

  it('on closing the account', async () => {
    const person = await aPerson();
    const phone = await register(person.token);
    await post('/customers/me/close', { password: person.password }, person.token);
    expect(await ctx.db.select().from(devices).where(eq(devices.token, phone))).toHaveLength(0);
  });

  it('on the phone asking to stop — only ever its own', async () => {
    const person = await aPerson();
    const stranger = await aPerson();
    const phone = await register(person.token);

    // Somebody else cannot unregister it.
    await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/devices/current',
      payload: { token: phone },
      headers: as(stranger.token),
      remoteAddress: uniqueIp(),
    });
    expect(await ctx.db.select().from(devices).where(eq(devices.token, phone))).toHaveLength(1);

    await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/devices/current',
      payload: { token: phone },
      headers: as(person.token),
      remoteAddress: uniqueIp(),
    });
    expect(await ctx.db.select().from(devices).where(eq(devices.token, phone))).toHaveLength(0);
  });
});

describe('what a push says', () => {
  it('names the business on a new message, and never the words', async () => {
    const { owner, renter, threadId } = await aConversation();
    const phone = await register(renter.token);

    await post(`/providers/me/messages/${threadId}/messages`, { body: 'Yes — and here is my number, 555 0199.' }, owner.token);

    const [push] = pushesTo(phone);
    expect(push?.title).toBe('New message from Push Test Rentals');
    // Nothing that was written in the message, on a locked screen.
    expect(JSON.stringify(push)).not.toContain('555 0199');
    expect(push?.data).toEqual({ type: 'message', id: threadId });
  });

  it('tells the business when a renter writes, as a business message', async () => {
    const { owner, providerId } = await aConversation();
    const phone = await register(owner.token);
    const renter = await aPerson();
    await post('/messages/threads', { providerId, body: 'Private question' }, renter.token);

    const [push] = pushesTo(phone);
    expect(push?.data.type).toBe('business_message');
    expect(JSON.stringify(push)).not.toContain('Private question');
  });

  it('never shows an amount of money', async () => {
    const { owner, providerId } = await aConversation();
    const car = await seedVehicle(ctx.db, providerId);
    const renter = await aPerson();
    const phone = await register(renter.token);
    const booked = await post('/bookings', { vehicleId: car.id, startDate: dateIn(30), endDate: dateIn(33) }, renter.token);
    const intent = await post(`/payments/bookings/${booked.json().id}/intent`, {}, renter.token);
    expect(intent.statusCode).toBe(200);
    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booked.json().id));

    // Stripe says it was paid: the notification in the app names the amount,
    // the push on the locked screen does not.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': TEST_SIGNATURE },
      payload: JSON.stringify(ctx.gateway.eventFor('payment_intent.succeeded', row!.stripePaymentIntentId!)),
      remoteAddress: uniqueIp(),
    });
    const payment = pushesTo(phone).find((push) => push.title === 'Payment received');
    expect(payment).toBeTruthy();
    expect(payment!.body).not.toContain('$');
    expect(owner.token).toBeTruthy();
  });
});

describe('each person decides what they hear about', () => {
  it('has sensible defaults — nobody gets offers unless they ask', async () => {
    const person = await aPerson();
    expect((await get('/customers/me/notification-preferences', person.token)).json()).toEqual({
      bookings: true,
      pickupReminders: true,
      returnReminders: true,
      deposits: true,
      messages: true,
      offers: false,
    });
  });

  it('stops message pushes when messages are switched off', async () => {
    const { owner, renter, threadId } = await aConversation();
    const phone = await register(renter.token);
    const saved = await put(
      '/customers/me/notification-preferences',
      { bookings: true, pickupReminders: true, returnReminders: true, deposits: true, messages: false, offers: false },
      renter.token,
    );
    expect(saved.json().messages).toBe(false);

    await post(`/providers/me/messages/${threadId}/messages`, { body: 'Hello' }, owner.token);
    expect(pushesTo(phone)).toHaveLength(0);
  });

  it('says so, rather than ignoring it, when booking news cannot be switched off yet', async () => {
    const { providerId } = await aConversation();
    const car = await seedVehicle(ctx.db, providerId);
    const renter = await aPerson();
    const booked = await post('/bookings', { vehicleId: car.id, startDate: dateIn(40), endDate: dateIn(43) }, renter.token);
    await ctx.db.update(bookings).set({ status: 'active' }).where(eq(bookings.id, booked.json().id));

    const saved = await put(
      '/customers/me/notification-preferences',
      { bookings: false, pickupReminders: true, returnReminders: true, deposits: true, messages: true, offers: false },
      renter.token,
    );
    expect(saved.json().bookings).toBe(false);
    expect(saved.json().note).toContain('rental running');
  });
});

describe('phones that have gone', () => {
  it('are removed when Expo says so at once', async () => {
    const { owner, renter, threadId } = await aConversation();
    const phone = await register(renter.token);
    expo.gone.add(phone);
    await post(`/providers/me/messages/${threadId}/messages`, { body: 'Hello' }, owner.token);
    expect(await ctx.db.select().from(devices).where(eq(devices.token, phone))).toHaveLength(0);
  });

  it('are removed when a later receipt says so', async () => {
    const { owner, renter, threadId } = await aConversation();
    const phone = await register(renter.token);
    await post(`/providers/me/messages/${threadId}/messages`, { body: 'Hello' }, owner.token);

    const [device] = await ctx.db.select().from(devices).where(eq(devices.token, phone));
    const [ticket] = await ctx.db.select().from(pushTickets).where(eq(pushTickets.deviceId, device!.id));
    // Old enough for a receipt to exist.
    await ctx.db.update(pushTickets).set({ sentAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(pushTickets.id, ticket!.id));
    expo.receiptsToGive[ticket!.id] = { status: 'error', details: { error: 'DeviceNotRegistered' } };

    const push = createPushService({ db: ctx.db, sender: expo, logger: { info: () => {}, warn: () => {} } });
    const result = await push.checkReceipts();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.select().from(devices).where(eq(devices.token, phone))).toHaveLength(0);
  });
});

describe('while push is switched off', () => {
  it('refuses to register a phone', async () => {
    const off = await createTestContext();
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const refused = await off.app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        payload: { token: 'ExponentPushToken[abc]', platform: 'android' },
        headers: as(token),
        remoteAddress: uniqueIp(),
      });
      expect(refused.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
