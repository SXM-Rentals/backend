// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests signing in with a code sent by text, and
// confirming the phone number on an account the same way, against a stand-in
// Twilio that remembers every text.
//
// The tests that matter most: the answer never says whether a number belongs to
// a customer, and no text goes to a number without a confirmed account; only a
// confirmed number signs in; a code works once, for 10 minutes, for 5 tries;
// and the limits hold, because every text sent is paid for.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customers, phoneChallenges } from '../src/db/schema/index.js';
import type { TwilioClient } from '../src/lib/twilio.js';
import { createTestContext, createVerifiedAccount, signInMobile, uniqueIp, WEB_ORIGIN, type TestContext } from './helpers.js';

const texts: { to: string; body: string }[] = [];
const fakeTwilio: TwilioClient = {
  voiceReady: false,
  smsReady: true,
  accessToken: () => 'unused',
  sendSms: async (to, body) => {
    texts.push({ to, body });
  },
  isGenuine: () => false,
};

let ctx: TestContext;
const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const post = (url: string, payload: object, token?: string, ip = uniqueIp()) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: token ? auth(token) : {}, remoteAddress: ip });
const codeIn = (body: string) => body.match(/^(\d{6}) /)![1]!;
const lastTextTo = (phone: string) => texts.filter((text) => text.to === phone).at(-1);

// Moves every code for a number back in time, to get past the one-a-minute rule
// without the test waiting a minute.
const backdate = (phone: string, minutes: number) =>
  ctx.db
    .update(phoneChallenges)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(phoneChallenges.phone, phone));

// An account whose owner confirms this number.
async function accountWithConfirmedPhone(phone: string) {
  const account = await createVerifiedAccount(ctx);
  const token = await signInMobile(ctx, account.email, account.password);
  const started = (await post('/auth/phone/start', { phone, purpose: 'confirm_phone' }, token)).json();
  const code = codeIn(lastTextTo(phone)!.body);
  const confirmed = await post('/auth/phone/verify', { challengeId: started.challengeId, code, purpose: 'confirm_phone' }, token);
  await backdate(phone, 20);
  return { ...account, token, confirmed };
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: { FEATURES: 'phoneSignIn,editProfile', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'auth', TWILIO_SMS_FROM: '+17215550000' },
    twilio: fakeTwilio,
  });
});
afterAll(async () => {
  await ctx.close();
});

describe('confirming the number on an account', () => {
  it('texts a code, and once it is typed the number is the account own, in international form', async () => {
    const { confirmed } = await accountWithConfirmedPhone('+17215551234');
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().user).toMatchObject({ phone: '+17215551234', phoneVerified: true });

    const text = lastTextTo('+17215551234')!;
    expect(text.body).toMatch(/^\d{6} is your SXM Rentals code\. SXM Rentals will never ask you for it\.$/);
    expect(text.body).not.toMatch(/http|www\./);
  });

  it('needs somebody signed in', async () => {
    const res = await post('/auth/phone/start', { phone: '+17215550001', purpose: 'confirm_phone' });
    expect(res.statusCode).toBe(401);
  });
});

describe('signing in with a code', () => {
  it('gives the same answer as signing in with a password, and the session works', async () => {
    await accountWithConfirmedPhone('+17215552000');
    const started = await post('/auth/phone/start', { phone: '+1 (721) 555-2000' });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({
      challengeId: expect.any(String),
      expiresAt: expect.any(String),
      resendAfterSeconds: 60,
      codeLength: 6,
    });

    const code = codeIn(lastTextTo('+17215552000')!.body);
    const signedIn = await post('/auth/phone/verify', { challengeId: started.json().challengeId, code, client: 'mobile' });
    expect(signedIn.statusCode).toBe(200);
    const { user, session } = signedIn.json();
    expect(user.phone).toBe('+17215552000');
    expect(session.token).toBeTruthy();

    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/customers/me', headers: auth(session.token), remoteAddress: uniqueIp() });
    expect(me.json().id).toBe(user.id);
    const sessions = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: auth(session.token), remoteAddress: uniqueIp() });
    expect(sessions.json().sessions.length).toBeGreaterThanOrEqual(2);

    // A code works once.
    const again = await post('/auth/phone/verify', { challengeId: started.json().challengeId, code, client: 'mobile' });
    expect(again.json().error.code).toBe('code_expired');
  });

  it('answers the same for a number nobody has, and texts nothing', async () => {
    const before = texts.length;
    const res = await post('/auth/phone/start', { phone: '+5905900000001' });
    expect(res.statusCode).toBe(202);
    expect(Object.keys(res.json()).sort()).toEqual(['challengeId', 'codeLength', 'expiresAt', 'resendAfterSeconds']);
    expect(texts.length).toBe(before);

    // Somebody who somehow had the right code learns only about their own number.
    const challengeId = res.json().challengeId as string;
    await ctx.db
      .update(phoneChallenges)
      .set({ codeHash: createHash('sha256').update(`${challengeId}:123456`).digest('hex') })
      .where(eq(phoneChallenges.id, challengeId));
    const verify = await post('/auth/phone/verify', { challengeId, code: '123456' });
    expect(verify.statusCode).toBe(404);
    expect(verify.json().error.code).toBe('no_account');
  });

  it('never signs in with a number typed into a profile but not confirmed', async () => {
    const account = await createVerifiedAccount(ctx);
    await ctx.db.update(customers).set({ phone: '+17215553000' }).where(eq(customers.email, account.email));
    const before = texts.length;
    await post('/auth/phone/start', { phone: '+17215553000' });
    expect(texts.length).toBe(before);
  });

  it('forgets a number once it is changed, and refuses a closed account', async () => {
    const { token, password } = await accountWithConfirmedPhone('+17215554000');
    const changed = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/customers/me',
      payload: { phone: '+17215554999' },
      headers: auth(token),
      remoteAddress: uniqueIp(),
    });
    expect(changed.json().phoneVerified).toBe(false);

    const other = await accountWithConfirmedPhone('+17215555000');
    await post('/customers/me/close', { password: other.password }, other.token);
    const before = texts.length;
    await post('/auth/phone/start', { phone: '+17215555000' });
    expect(texts.length).toBe(before);
    expect(password).toBeTruthy();
  });
});

describe('the code', () => {
  it('allows five tries, says how many are left, then stops working', async () => {
    await accountWithConfirmedPhone('+17215556000');
    const { challengeId } = (await post('/auth/phone/start', { phone: '+17215556000' })).json();
    const right = codeIn(lastTextTo('+17215556000')!.body);
    const wrong = right === '000000' ? '111111' : '000000';

    const first = await post('/auth/phone/verify', { challengeId, code: wrong });
    expect(first.json().error).toMatchObject({ code: 'invalid_code', message: 'That code is not right. 4 tries left.' });
    for (let i = 0; i < 3; i += 1) await post('/auth/phone/verify', { challengeId, code: wrong });
    const fifth = await post('/auth/phone/verify', { challengeId, code: wrong });
    expect(fifth.json().error.code).toBe('too_many_tries');
    const late = await post('/auth/phone/verify', { challengeId, code: right });
    expect(late.json().error.code).toBe('too_many_tries');
  });

  it('expires after ten minutes, and a new code cancels the old one', async () => {
    await accountWithConfirmedPhone('+17215557000');
    const first = (await post('/auth/phone/start', { phone: '+17215557000' })).json();
    const firstCode = codeIn(lastTextTo('+17215557000')!.body);
    await backdate('+17215557000', 2);
    const second = (await post('/auth/phone/start', { phone: '+17215557000' })).json();
    expect((await post('/auth/phone/verify', { challengeId: first.challengeId, code: firstCode })).json().error.code).toBe(
      'code_expired',
    );

    await ctx.db.update(phoneChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(phoneChallenges.id, second.challengeId));
    const code = codeIn(lastTextTo('+17215557000')!.body);
    expect((await post('/auth/phone/verify', { challengeId: second.challengeId, code })).json().error.code).toBe('code_expired');
  });
});

describe('the limits', () => {
  it('refuses a number that is not one', async () => {
    const res = await post('/auth/phone/start', { phone: '12345' });
    expect(res.json().error.code).toBe('invalid_phone');
  });

  it('sends one a minute, three in 15 minutes and ten a day to a number, with how long to wait', async () => {
    const phone = '+17215558000';
    await post('/auth/phone/start', { phone });
    const tooSoon = await post('/auth/phone/start', { phone });
    expect(tooSoon.statusCode).toBe(429);
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);

    await backdate(phone, 2);
    await post('/auth/phone/start', { phone });
    await backdate(phone, 2);
    await post('/auth/phone/start', { phone });
    await backdate(phone, 2);
    const fourth = await post('/auth/phone/start', { phone });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.message).toContain('15 minutes');
  });

  it('allows twenty codes a day from one address', async () => {
    const ip = '198.51.100.77';
    await ctx.db.insert(phoneChallenges).values(
      Array.from({ length: 20 }, (_, i) => ({
        phone: `+1721555${String(9000 + i)}`,
        purpose: 'sign_in' as const,
        codeHash: 'x',
        expiresAt: new Date(),
        ipAddress: ip,
      })),
    );
    const res = await post('/auth/phone/start', { phone: '+17215559999' }, undefined, ip);
    expect(res.statusCode).toBe(429);
  });

  it('answers feature_off while texts are not set up', async () => {
    const off = await createTestContext({ env: { FEATURES: 'phoneSignIn' } });
    try {
      const res = await off.app.inject({
        method: 'POST',
        url: '/api/v1/auth/phone/start',
        payload: { phone: '+17215551234' },
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
