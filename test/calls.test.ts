// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests calls inside the app between a renter and a rental
// business, against a stand-in Twilio.
//
// The tests that matter most: only the two sides of a conversation can call
// each other; no phone number goes anywhere, in the push or otherwise; a
// request claiming to be Twilio is ignored unless Twilio signed it; the call
// leaves exactly one line in the conversation; and nobody can ring somebody
// over and over.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calls, chatMessages, customers, providerMembers } from '../src/db/schema/index.js';
import type { PushMessage, PushSender, PushTicket } from '../src/lib/push.js';
import type { TwilioClient } from '../src/lib/twilio.js';
import { identityOf } from '../src/services/calls/index.js';
import { createTestContext, createVerifiedAccount, signInMobile, uniqueIp, WEB_ORIGIN, type TestContext } from './helpers.js';

// Stand-ins: Twilio signs with "good", and a token names who it is for.
const fakeTwilio: TwilioClient = {
  voiceReady: true,
  smsReady: false,
  accessToken: (identity, { platform }) => `token:${identity}:${platform ?? 'any'}`,
  sendSms: async () => {},
  isGenuine: (_url, _params, signature) => signature === 'good',
};
const pushes: PushMessage[] = [];
const expo: PushSender = {
  live: true,
  async send(messages) {
    pushes.push(...messages);
    return messages.map((): PushTicket => ({ status: 'ok', id: 'ticket' }));
  },
  async receipts() {
    return {};
  },
};

let ctx: TestContext;
let renter: { token: string; id: string; phone: string };
let owner: { token: string; id: string; phone: string };
let stranger: { token: string; id: string; phone: string };
let threadId: string;
let providerId: string;
let phoneCount = 0;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (url: string, token: string, payload: object = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: auth(token), remoteAddress: uniqueIp(), payload });
const fromTwilio = (url: string, form: Record<string, string>, signature = 'good') =>
  ctx.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    payload: new URLSearchParams(form).toString(),
    remoteAddress: uniqueIp(),
  });
const linesIn = async () =>
  (await ctx.db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId))).map((message) => message.body);

async function aPerson() {
  const account = await createVerifiedAccount(ctx);
  const token = await signInMobile(ctx, account.email, account.password);
  const [row] = await ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.email, account.email));
  const phone = `ExponentPushToken[call${++phoneCount}]`;
  await send('/devices', token, { token: phone, platform: 'ios' });
  // Real phone numbers on the accounts, so the privacy test has something to look for.
  await ctx.db.update(customers).set({ phone: '+1 721 555 0199' }).where(eq(customers.id, row!.id));
  return { token, id: row!.id, phone };
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      FEATURES: 'calls,push',
      EXPO_ACCESS_TOKEN: 'expo-test',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'auth',
      TWILIO_API_KEY_SID: 'SK123',
      TWILIO_API_KEY_SECRET: 'secret',
      TWILIO_TWIML_APP_SID: 'AP123',
    },
    pushSender: expo,
    twilio: fakeTwilio,
  });
  owner = await aPerson();
  providerId = (
    await send('/providers/apply', owner.token, {
      businessName: 'Calling Cars',
      legalName: 'Calling Cars N.V.',
      contactEmail: 'hello@callingcars.sx',
      ownerName: 'Marie Richardson',
      ownerPhone: '+1 721 555 0188',
      town: 'Simpson Bay',
      side: 'dutch',
      operatingSide: 'dutch',
    })
  ).json().providerId;
  renter = await aPerson();
  await ctx.db.update(customers).set({ firstName: 'Benjamin', lastName: 'Jonesworth' }).where(eq(customers.id, renter.id));
  threadId = (await send('/messages/threads', renter.token, { providerId, body: 'Can I call you?' })).json().id;
  stranger = await aPerson();
});
afterAll(async () => {
  await ctx.close();
});

describe('a renter calling a business', () => {
  it('gives the caller a token, and rings the business with a name and no number', async () => {
    pushes.length = 0;
    const res = await send('/calls', renter.token, { threadId, platform: 'ios' });
    expect(res.statusCode).toBe(201);
    const call = res.json();
    expect(call).toMatchObject({ provider: 'twilio', token: `token:${identityOf(renter.id)}:ios`, serverUrl: null });

    const rang = pushes.filter((push) => push.to === owner.phone);
    expect(rang).toHaveLength(1);
    expect(rang[0]!.data).toEqual({ type: 'call', id: call.callId, callId: call.callId, from: 'Benjamin J.' });
    expect(JSON.stringify(pushes)).not.toMatch(/555|\+1 721/);
  });

  it('tells Twilio to ring the business, only when Twilio signed the request and the caller is who the call says', async () => {
    const { callId } = (await send('/calls', renter.token, { threadId })).json();

    const unsigned = await fromTwilio('/calls/twiml', { callId, From: `client:${identityOf(renter.id)}` }, 'forged');
    expect(unsigned.statusCode).toBe(403);

    const wrongCaller = await fromTwilio('/calls/twiml', { callId, From: `client:${identityOf(stranger.id)}` });
    expect(wrongCaller.body).toContain('<Reject/>');

    const twiml = await fromTwilio('/calls/twiml', { callId, From: `client:${identityOf(renter.id)}` });
    expect(twiml.headers['content-type']).toContain('text/xml');
    expect(twiml.body).toContain(`<Client>${identityOf(owner.id)}</Client>`);
    expect(twiml.body).toContain(`/api/v1/calls/${callId}/dial-status`);
    expect(twiml.body).not.toContain(identityOf(renter.id) + '</Client>');
    await send(`/calls/${callId}/end`, renter.token);
  });

  it('once answered and finished, leaves one line with how long it lasted', async () => {
    const { callId } = (await send('/calls', renter.token, { threadId })).json();
    const answered = await send(`/calls/${callId}/answer`, owner.token, { platform: 'android' });
    expect(answered.json()).toEqual({ token: `token:${identityOf(owner.id)}:android`, serverUrl: null });

    const finished = await fromTwilio(`/calls/${callId}/dial-status`, { DialCallStatus: 'completed', DialCallDuration: '185' });
    expect(finished.statusCode).toBe(200);
    // The phones hang up too; nothing is added twice.
    await send(`/calls/${callId}/end`, owner.token);
    await send(`/calls/${callId}/end`, renter.token);

    const lines = await linesIn();
    expect(lines.filter((line) => line === 'Call, 4 min')).toHaveLength(1);
    const [row] = await ctx.db.select().from(calls).where(eq(calls.id, callId));
    expect(row!.status).toBe('ended');
  });
});

describe('a call nobody takes', () => {
  it('is a missed call when declined, or when Twilio says nobody answered', async () => {
    const before = (await linesIn()).filter((line) => line === 'Missed call').length;

    const first = (await send('/calls', owner.token, { threadId })).json();
    expect((await send(`/calls/${first.callId}/decline`, renter.token)).statusCode).toBe(204);

    const second = (await send('/calls', owner.token, { threadId })).json();
    await fromTwilio(`/calls/${second.callId}/dial-status`, { DialCallStatus: 'no-answer', DialCallDuration: '0' });

    expect((await linesIn()).filter((line) => line === 'Missed call').length).toBe(before + 2);
    const answerLate = await send(`/calls/${second.callId}/answer`, renter.token);
    expect(answerLate.json().error.code).toBe('call_over');
  });
});

describe('who can call whom', () => {
  it('is only the two sides of a conversation', async () => {
    expect((await send('/calls', stranger.token, { threadId })).statusCode).toBe(404);
    const { callId } = (await send('/calls', renter.token, { threadId })).json();
    // The caller cannot answer their own call, and a stranger cannot touch it.
    expect((await send(`/calls/${callId}/answer`, renter.token)).statusCode).toBe(404);
    expect((await send(`/calls/${callId}/end`, stranger.token)).statusCode).toBe(404);
    await send(`/calls/${callId}/end`, renter.token);
  });

  it('rings every member of the business, and only one can pick up', async () => {
    const colleague = await aPerson();
    await ctx.db.insert(providerMembers).values({ providerId, customerId: colleague.id, role: 'staff' });
    const { callId } = (await send('/calls', renter.token, { threadId })).json();
    const twiml = await fromTwilio('/calls/twiml', { callId, From: `client:${identityOf(renter.id)}` });
    expect(twiml.body).toContain(`<Client>${identityOf(colleague.id)}</Client>`);
    expect(twiml.body).toContain(`<Client>${identityOf(owner.id)}</Client>`);

    await send(`/calls/${callId}/answer`, colleague.token);
    const second = await send(`/calls/${callId}/answer`, owner.token);
    expect(second.json().error.code).toBe('answered_elsewhere');
    await send(`/calls/${callId}/end`, colleague.token);
  });

  it('allows a few calls a minute, and then says to wait', async () => {
    const other = await aPerson();
    const otherThread = (await send('/messages/threads', other.token, { providerId, body: 'Hello' })).json().id;
    for (let i = 0; i < 5; i += 1) {
      const { callId } = (await send('/calls', other.token, { threadId: otherThread })).json();
      await send(`/calls/${callId}/end`, other.token);
    }
    const sixth = await send('/calls', other.token, { threadId: otherThread });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  it('answers feature_off while Twilio is not set up', async () => {
    const off = await createTestContext({ env: { FEATURES: 'calls' } });
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const res = await off.app.inject({
        method: 'POST',
        url: '/api/v1/calls',
        payload: { threadId },
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
