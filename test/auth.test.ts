// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests every account and sign-in journey from the outside,
// exactly as the website and phone app would use them: signing up, confirming
// the email, signing in and out on the web and on a phone, resetting and
// changing a password, managing signed-in devices — and, just as importantly,
// that each one refuses what it should (reused links, leaked passwords, other
// people's sessions, repeated wrong passwords).

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authTokens, credentials, customers } from '../src/db/schema/index.js';
import {
  GOOD_PASSWORD,
  SESSION_COOKIE,
  WEB_ORIGIN,
  createTestContext,
  createVerifiedAccount,
  signInMobile,
  signInWeb,
  tokenFromLastEmail,
  uniqueIp,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

// Small shortcuts for calling the API.
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });

describe('signing up and confirming the email', () => {
  it('walks the whole website journey: sign up → confirm → sign in → my account → sign out', async () => {
    const email = 'journey@example.com';

    const signup = await post('/auth/signup', {
      firstName: 'Aria',
      lastName: 'Duncan',
      email: 'Journey@Example.com ',
      password: GOOD_PASSWORD,
      accountType: 'local',
    });
    expect(signup.statusCode).toBe(202);

    // Cannot sign in before confirming the email.
    const early = await post('/auth/login', { email, password: GOOD_PASSWORD }, { origin: WEB_ORIGIN });
    expect(early.statusCode).toBe(403);
    expect(early.json().error.code).toBe('email_not_verified');

    const verify = await post('/auth/verify-email', { token: tokenFromLastEmail(ctx.email) });
    expect(verify.statusCode).toBe(200);

    const login = await post('/auth/login', { email, password: GOOD_PASSWORD }, { origin: WEB_ORIGIN });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    // The website never receives the raw code in the body.
    expect(login.json().session.token).toBeUndefined();

    const me = await get('/customers/me', { cookie: `${SESSION_COOKIE}=${cookie!.value}` });
    expect(me.statusCode).toBe(200);
    const user = me.json();
    expect(user).toMatchObject({
      email,
      firstName: 'Aria',
      accountType: 'local',
      phone: '',
      isIslander: false,
      verification: { status: 'unstarted', selfieDone: false, licenseDone: false, identityDocDone: false },
    });
    expect(JSON.stringify(user)).not.toMatch(/password|hash/i);

    const logout = await post('/auth/logout', {}, { cookie: `${SESSION_COOKIE}=${cookie!.value}`, origin: WEB_ORIGIN });
    expect(logout.statusCode).toBe(204);

    const after = await get('/customers/me', { cookie: `${SESSION_COOKIE}=${cookie!.value}` });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toMatchObject({ code: 'unauthorized' });
    expect(typeof after.json().error.requestId).toBe('string');
  });

  it('stores passwords scrambled with Argon2id, never as typed', async () => {
    const { email } = await createVerifiedAccount(ctx);
    const [row] = await ctx.db
      .select({ hash: credentials.passwordHash })
      .from(credentials)
      .innerJoin(customers, eq(customers.id, credentials.customerId))
      .where(eq(customers.email, email));
    expect(row?.hash.startsWith('$argon2id$')).toBe(true);
    expect(row?.hash).not.toContain(GOOD_PASSWORD);
  });

  it('answers a sign-up for an existing email exactly like a new one, and warns the real owner', async () => {
    const { email } = await createVerifiedAccount(ctx);
    const fresh = await post('/auth/signup', {
      firstName: 'New',
      lastName: 'Person',
      email: 'someone-brand-new@example.com',
      password: GOOD_PASSWORD,
      accountType: 'tourist',
    });
    const repeat = await post('/auth/signup', {
      firstName: 'Imposter',
      lastName: 'Person',
      email,
      password: GOOD_PASSWORD,
      accountType: 'tourist',
    });
    expect(repeat.statusCode).toBe(fresh.statusCode);
    expect(repeat.body).toBe(fresh.body);
    expect(ctx.email.sent.at(-1)?.subject).toMatch(/tried to create/i);
  });

  it('refuses short passwords and passwords known from data breaches', async () => {
    const short = await post('/auth/signup', {
      firstName: 'A',
      lastName: 'B',
      email: 'short@example.com',
      password: 'tooshort',
      accountType: 'tourist',
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('invalid_input');
    expect(short.json().error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'password' })]));

    ctx.breachedPasswords.add('password1234567');
    const breached = await post('/auth/signup', {
      firstName: 'A',
      lastName: 'B',
      email: 'breached@example.com',
      password: 'password1234567',
      accountType: 'tourist',
    });
    expect(breached.statusCode).toBe(400);
    expect(breached.json().error.code).toBe('password_breached');
  });

  it('refuses a verification link that has expired or was already used', async () => {
    await post('/auth/signup', {
      firstName: 'Late',
      lastName: 'Clicker',
      email: 'late@example.com',
      password: GOOD_PASSWORD,
      accountType: 'tourist',
    });
    const token = tokenFromLastEmail(ctx.email);
    await ctx.db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) });

    const expired = await post('/auth/verify-email', { token });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error.code).toBe('invalid_or_expired_link');

    await post('/auth/verify-email/resend', { email: 'late@example.com' });
    const fresh = tokenFromLastEmail(ctx.email);
    expect((await post('/auth/verify-email', { token: fresh })).statusCode).toBe(200);
    expect((await post('/auth/verify-email', { token: fresh })).statusCode).toBe(400);
  });
});

describe('signing in', () => {
  it('gives the phone app a code to send as a Bearer header, and no cookie', async () => {
    const { email, password } = await createVerifiedAccount(ctx);
    const res = await post('/auth/login', { email, password, client: 'mobile' });
    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(0);
    const { token } = res.json().session;

    const me = await get('/customers/me', { authorization: `Bearer ${token}` });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(email);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const { email } = await createVerifiedAccount(ctx);
    const wrong = await post('/auth/login', { email, password: 'not the right password' });
    const unknown = await post('/auth/login', { email: 'nobody-here@example.com', password: 'not the right password' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it('locks the account for a while after 5 wrong passwords in a row — even against the right one', async () => {
    const { email, password } = await createVerifiedAccount(ctx);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await post('/auth/login', { email, password: 'wrong wrong wrong' })).statusCode).toBe(401);
    }
    const locked = await post('/auth/login', { email, password });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('rate_limited');
  });
});

describe('passwords', () => {
  it('answers "forgot password" identically whether or not the account exists', async () => {
    const { email } = await createVerifiedAccount(ctx);
    const real = await post('/auth/password/forgot', { email });
    const fake = await post('/auth/password/forgot', { email: 'ghost@example.com' });
    expect(real.statusCode).toBe(202);
    expect(fake.statusCode).toBe(202);
    expect(real.body).toBe(fake.body);
  });

  it('resets a password once per link, and signs out every device', async () => {
    const { email, password } = await createVerifiedAccount(ctx);
    const phoneToken = await signInMobile(ctx, email, password);

    await post('/auth/password/forgot', { email });
    const token = tokenFromLastEmail(ctx.email);
    const newPassword = 'a brand new long passphrase';

    expect((await post('/auth/password/reset', { token, newPassword })).statusCode).toBe(200);
    // The same link cannot be used twice.
    expect((await post('/auth/password/reset', { token, newPassword: 'yet another passphrase' })).statusCode).toBe(400);

    // The phone was signed out.
    expect((await get('/customers/me', { authorization: `Bearer ${phoneToken}` })).statusCode).toBe(401);
    // Old password no longer works; the new one does.
    expect((await post('/auth/login', { email, password })).statusCode).toBe(401);
    expect((await post('/auth/login', { email, password: newPassword })).statusCode).toBe(200);
  });

  it('changes a password while signed in, signing out other devices but keeping this one', async () => {
    const { email, password } = await createVerifiedAccount(ctx);
    const otherDevice = await signInMobile(ctx, email, password);
    const thisDevice = await signInMobile(ctx, email, password);

    const wrongCurrent = await post(
      '/auth/password/change',
      { currentPassword: 'not it at all', newPassword: 'another long passphrase' },
      { authorization: `Bearer ${thisDevice}` },
    );
    expect(wrongCurrent.statusCode).toBe(400);

    const change = await post(
      '/auth/password/change',
      { currentPassword: password, newPassword: 'another long passphrase' },
      { authorization: `Bearer ${thisDevice}` },
    );
    expect(change.statusCode).toBe(200);
    const replacement = change.json().session.token;

    expect((await get('/customers/me', { authorization: `Bearer ${otherDevice}` })).statusCode).toBe(401);
    expect((await get('/customers/me', { authorization: `Bearer ${thisDevice}` })).statusCode).toBe(401);
    expect((await get('/customers/me', { authorization: `Bearer ${replacement}` })).statusCode).toBe(200);
  });
});

describe('signed-in devices', () => {
  it('lists your own devices and lets you sign one out', async () => {
    const { email, password } = await createVerifiedAccount(ctx);
    const laptop = await signInWeb(ctx, email, password);
    const phone = await signInMobile(ctx, email, password);

    const list = await get('/auth/sessions', { authorization: `Bearer ${phone}` });
    expect(list.statusCode).toBe(200);
    const sessions = list.json().sessions as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    const laptopSession = sessions.find((s) => !s.current)!;

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${laptopSession.id}`,
      headers: { authorization: `Bearer ${phone}` },
      remoteAddress: uniqueIp(),
    });
    expect(revoke.statusCode).toBe(204);
    expect((await get('/customers/me', { cookie: laptop })).statusCode).toBe(401);
  });

  it("answers 'not found' when you try to sign out somebody else's device", async () => {
    const alice = await createVerifiedAccount(ctx);
    const bob = await createVerifiedAccount(ctx);
    const aliceToken = await signInMobile(ctx, alice.email, alice.password);
    const bobToken = await signInMobile(ctx, bob.email, bob.password);

    const bobSessionId = (await get('/auth/sessions', { authorization: `Bearer ${bobToken}` })).json().sessions[0].id;

    const attempt = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${bobSessionId}`,
      headers: { authorization: `Bearer ${aliceToken}` },
      remoteAddress: uniqueIp(),
    });
    expect(attempt.statusCode).toBe(404);
    // Indistinguishable from an ID that does not exist.
    const made_up = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${aliceToken}` },
      remoteAddress: uniqueIp(),
    });
    expect(attempt.json().error.code).toBe(made_up.json().error.code);
    expect(attempt.json().error.message).toBe(made_up.json().error.message);

    // Bob is still signed in.
    expect((await get('/customers/me', { authorization: `Bearer ${bobToken}` })).statusCode).toBe(200);
  });
});
