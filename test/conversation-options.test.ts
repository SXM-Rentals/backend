// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the options on a conversation — mark as unread, pin
// to the top, mute — for customers and rental businesses alike.
//
// The rule that matters most: the options belong to the PERSON, not the
// conversation. A business pinning or muting a conversation changes nothing for
// the renter, and one member of a business muting it still lets the others hear.
// And a muted conversation still delivers every message — it only stops the push.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customers, providerMembers } from '../src/db/schema/index.js';
import type { PushMessage, PushSender, PushTicket } from '../src/lib/push.js';
import { createTestContext, createVerifiedAccount, signInMobile, uniqueIp, WEB_ORIGIN, type TestContext } from './helpers.js';

// A stand-in for Expo that remembers every push it was handed.
function fakeExpo() {
  const sent: PushMessage[] = [];
  let counter = 0;
  const sender: PushSender & { sent: PushMessage[] } = {
    live: true,
    sent,
    async send(messages) {
      return messages.map((message): PushTicket => {
        sent.push(message);
        counter += 1;
        return { status: 'ok', id: `ticket-${counter}` };
      });
    },
    async receipts() {
      return {};
    },
  };
  return sender;
}

let ctx: TestContext;
let expo: ReturnType<typeof fakeExpo>;
let phoneCounter = 0;

const as = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST' | 'PATCH', url: string, bearer: string, payload?: object) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: as(bearer), remoteAddress: uniqueIp(), ...(payload ? { payload } : {}) });

async function aPerson() {
  const account = await createVerifiedAccount(ctx);
  const token = await signInMobile(ctx, account.email, account.password);
  const phone = `ExponentPushToken[options${++phoneCounter}]`;
  await send('POST', '/devices', token, { token: phone, platform: 'ios' });
  return { ...account, token, phone };
}
const pushesTo = (phone: string) => expo.sent.filter((message) => message.to === phone).length;

// A business, a renter who has written to it, and the business's answer.
async function aConversation(name: string) {
  const owner = await aPerson();
  const applied = await send('POST', '/providers/apply', owner.token, {
    businessName: name,
    legalName: `${name} N.V.`,
    contactEmail: `hello@${name.toLowerCase().replace(/\W/g, '')}.sx`,
    ownerName: 'Marie Richardson',
    ownerPhone: '+1 721 555 0188',
    town: 'Simpson Bay',
    side: 'dutch',
    operatingSide: 'dutch',
  });
  const providerId = applied.json().providerId as string;
  const renter = await aPerson();
  const thread = await send('POST', '/messages/threads', renter.token, { providerId, body: 'Is the car automatic?' });
  const threadId = thread.json().id as string;
  await send('POST', `/providers/me/messages/${threadId}/messages`, owner.token, { body: 'Yes, it is.' });
  return { owner, renter, providerId, threadId };
}

beforeAll(async () => {
  expo = fakeExpo();
  ctx = await createTestContext({
    env: { FEATURES: 'messageOptions,push', EXPO_ACCESS_TOKEN: 'expo-test' },
    pushSender: expo,
  });
});
afterAll(async () => {
  await ctx.close();
});

describe('every conversation says whether it is pinned or muted', () => {
  it('starts with both false, on both sides', async () => {
    const { owner, renter, threadId } = await aConversation('Plain Rentals');
    const mine = (await send('GET', `/messages/threads/${threadId}`, renter.token)).json();
    expect(mine).toMatchObject({ pinned: false, muted: false });
    const [theirs] = (await send('GET', '/providers/me/messages', owner.token)).json();
    expect(theirs).toMatchObject({ id: threadId, pinned: false, muted: false });
  });
});

describe('mark as unread', () => {
  it('counts at least one unread until the conversation is read again', async () => {
    const { renter, threadId } = await aConversation('Unread Rentals');
    await send('POST', `/messages/threads/${threadId}/read`, renter.token);
    expect((await send('GET', `/messages/threads/${threadId}`, renter.token)).json().unreadCount).toBe(0);

    const marked = await send('PATCH', `/messages/threads/${threadId}`, renter.token, { unread: true });
    expect(marked.statusCode).toBe(200);
    // Answered with the conversation, as GET gives it.
    expect(marked.json()).toMatchObject({ id: threadId, unreadCount: 1 });
    const [listed] = (await send('GET', '/messages/threads', renter.token)).json();
    expect(listed.unreadCount).toBe(1);

    await send('POST', `/messages/threads/${threadId}/read`, renter.token);
    expect((await send('GET', `/messages/threads/${threadId}`, renter.token)).json().unreadCount).toBe(0);
  });

  it('never takes the read tick away from the other side', async () => {
    const { owner, renter, threadId } = await aConversation('Tick Rentals');
    await send('POST', `/providers/me/messages/${threadId}/read`, owner.token);
    await send('PATCH', `/providers/me/messages/${threadId}`, owner.token, { unread: true });

    const theirs = (await send('GET', `/providers/me/messages/${threadId}`, owner.token)).json();
    expect(theirs.unreadCount).toBe(1);
    // The renter still sees that the business read their message.
    const mine = (await send('GET', `/messages/threads/${threadId}`, renter.token)).json();
    expect(mine.messages.find((message: { from: string }) => message.from === 'customer').read).toBe(true);
  });

  it('can only be switched on here; reading is what switches it off', async () => {
    const { renter, threadId } = await aConversation('Strict Rentals');
    expect((await send('PATCH', `/messages/threads/${threadId}`, renter.token, { unread: false })).statusCode).toBe(400);
    expect((await send('PATCH', `/messages/threads/${threadId}`, renter.token, {})).statusCode).toBe(400);
  });
});

describe('pin to the top', () => {
  it('puts a pinned conversation first, and only for the person who pinned it', async () => {
    const renter = await aPerson();
    const first = await aConversation('Older Rentals');
    const second = await aConversation('Newer Rentals');
    // The same renter writes to both; the newer one would normally come first.
    await send('POST', '/messages/threads', renter.token, { providerId: first.providerId, body: 'Hello there' });
    await send('POST', '/messages/threads', renter.token, { providerId: second.providerId, body: 'Hello again' });
    const before = (await send('GET', '/messages/threads', renter.token)).json();
    expect(before.map((thread: { providerId: string }) => thread.providerId)).toEqual([second.providerId, first.providerId]);

    const olderThread = before[1].id as string;
    const pinned = await send('PATCH', `/messages/threads/${olderThread}`, renter.token, { pinned: true });
    expect(pinned.json().pinned).toBe(true);
    const after = (await send('GET', '/messages/threads', renter.token)).json();
    expect(after[0]).toMatchObject({ id: olderThread, pinned: true });

    // The business copy of the same conversation is not pinned.
    const businessCopy = (await send('GET', `/providers/me/messages/${olderThread}`, first.owner.token)).json();
    expect(businessCopy.pinned).toBe(false);

    // And unpinning puts it back where it was.
    await send('PATCH', `/messages/threads/${olderThread}`, renter.token, { pinned: false });
    expect((await send('GET', '/messages/threads', renter.token)).json()[0].id).not.toBe(olderThread);
  });
});

describe('mute', () => {
  it('stops the push to the renter, but the message still arrives and counts', async () => {
    const { owner, renter, threadId } = await aConversation('Quiet Rentals');
    await send('POST', `/messages/threads/${threadId}/read`, renter.token);
    const muted = await send('PATCH', `/messages/threads/${threadId}`, renter.token, { muted: true });
    expect(muted.json().muted).toBe(true);

    const before = pushesTo(renter.phone);
    await send('POST', `/providers/me/messages/${threadId}/messages`, owner.token, { body: 'Your car is ready.' });
    expect(pushesTo(renter.phone)).toBe(before);
    const mine = (await send('GET', `/messages/threads/${threadId}`, renter.token)).json();
    expect(mine.unreadCount).toBe(1);
    expect(mine.messages.at(-1).body).toBe('Your car is ready.');

    // Unmuted, pushes come again.
    await send('PATCH', `/messages/threads/${threadId}`, renter.token, { muted: false });
    await send('POST', `/providers/me/messages/${threadId}/messages`, owner.token, { body: 'See you at ten.' });
    expect(pushesTo(renter.phone)).toBe(before + 1);
  });

  it('mutes it for one member of a business, not the others', async () => {
    const { owner, renter, providerId, threadId } = await aConversation('Team Rentals');
    const colleague = await aPerson();
    const [person] = await ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.email, colleague.email));
    await ctx.db.insert(providerMembers).values({ providerId, customerId: person!.id, role: 'staff' });

    await send('PATCH', `/providers/me/messages/${threadId}`, owner.token, { muted: true });
    const ownerBefore = pushesTo(owner.phone);
    const colleagueBefore = pushesTo(colleague.phone);
    await send('POST', `/messages/threads/${threadId}/messages`, renter.token, { body: 'Running ten minutes late.' });

    expect(pushesTo(owner.phone)).toBe(ownerBefore);
    expect(pushesTo(colleague.phone)).toBe(colleagueBefore + 1);
    // The colleague sees it unmuted.
    expect((await send('GET', `/providers/me/messages/${threadId}`, colleague.token)).json().muted).toBe(false);
  });
});

describe('whose conversation it is', () => {
  it('answers 404 for somebody else’s conversation, on both sides', async () => {
    const { threadId } = await aConversation('Private Rentals');
    const stranger = await aPerson();
    expect((await send('PATCH', `/messages/threads/${threadId}`, stranger.token, { pinned: true })).statusCode).toBe(404);

    const rival = await aConversation('Rival Rentals');
    const res = await send('PATCH', `/providers/me/messages/${threadId}`, rival.owner.token, { pinned: true });
    expect(res.statusCode).toBe(404);
  });

  it('answers feature_off while the switch is off', async () => {
    const off = await createTestContext();
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const res = await off.app.inject({
        method: 'PATCH',
        url: '/api/v1/messages/threads/00000000-0000-4000-8000-000000000000',
        payload: { pinned: true },
        headers: as(token),
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('feature_off');
    } finally {
      await off.close();
    }
  });
});
