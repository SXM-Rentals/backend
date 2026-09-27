// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests managing staff accounts from the admin panel —
// adding somebody, giving somebody locked out a fresh start, switching an
// account off and back on, and changing your own password.
//
// These tests exist because this feature reverses a deliberate decision: staff
// accounts used to be made only from the server. The guards are the point, so
// most of what is checked here is what the panel CANNOT do — act without a
// fresh authenticator code, act without a written reason, let a brand-new
// account do anything before it sets its own password, or let anybody disable
// or reset themselves and lock the business out of its own panel.

import { eq } from 'drizzle-orm';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminStaff, auditLog } from '../src/db/schema/index.js';
import {
  ADMIN_COOKIE,
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
// The staff member doing the managing.
let boss: Awaited<ReturnType<typeof createSignedInStaff>>;

const TEMP = 'a temporary staff passphrase';
const OWN = 'my own long passphrase';

const asStaff = (cookie: string) => ({ cookie, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });

// The actor's own authenticator code, as the panel would send it.
const code = () => generateOtp({ secret: boss.secret });

let added = 0;
async function addStaff(overrides: Record<string, unknown> = {}) {
  added += 1;
  return post(
    '/admin/staff',
    {
      name: `New Person ${added}`,
      email: `new${added}@sxmrentals.test`,
      password: TEMP,
      reason: 'Joining the support team on Monday.',
      code: await code(),
      ...overrides,
    },
    asStaff(boss.cookie),
  );
}

// Signs in as a staff member who knows their password, and gets as far as the
// authenticator step. Returns the cookie and, when they had to set one up, the
// secret behind their new authenticator app.
async function signInAsStaff(email: string, password: string, existingSecret?: string) {
  const login = await post('/admin/auth/login', { email, password });
  if (login.statusCode !== 200) throw new Error(`sign-in failed: ${login.body}`);
  const cookie = `${ADMIN_COOKIE}=${login.cookies.find((c) => c.name === ADMIN_COOKIE)!.value}`;

  let secret = existingSecret;
  if (login.json().next === 'enroll') {
    const enrolled = await post('/admin/auth/mfa/enroll', {}, asStaff(cookie));
    secret = enrolled.json().secret as string;
  }
  const verified = await post('/admin/auth/mfa/verify', { code: await generateOtp({ secret: secret! }) }, asStaff(cookie));
  if (verified.statusCode !== 200) throw new Error(`code refused: ${verified.body}`);
  return { cookie, secret: secret!, mustChangePassword: verified.json().mustChangePassword as boolean };
}

beforeAll(async () => {
  ctx = await createTestContext();
  boss = await createSignedInStaff(ctx, 'Gio Owner');
});
afterAll(async () => {
  await ctx.close();
});

describe('adding a staff member', () => {
  it('refuses without a code, with a wrong code, or without a reason — and adds nobody', async () => {
    const before = (await get('/admin/staff', asStaff(boss.cookie))).json().length;

    const noCode = await addStaff({ code: undefined });
    const noReason = await addStaff({ reason: undefined });
    const wrongCode = await addStaff({ code: '000000' });

    expect(noCode.statusCode).toBe(400);
    expect(noCode.json().error.code).toBe('invalid_input');
    expect(noReason.statusCode).toBe(400);
    // A wrong code is a typo inside a signed-in session, not an ended session.
    expect(wrongCode.statusCode).toBe(400);
    expect(wrongCode.json().error.code).toBe('wrong_code');

    expect((await get('/admin/staff', asStaff(boss.cookie))).json()).toHaveLength(before);
  });

  it('adds somebody with a temporary password and no authenticator app', async () => {
    const created = await addStaff();
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: expect.any(String),
      mfaEnrolled: false,
      mustChangePassword: true,
      disabledAt: null,
      lastSignInAt: null,
    });
    // Never the password, the hash or the two-factor secret.
    expect(created.body).not.toContain(TEMP);
    expect(created.body).not.toMatch(/hash|secret/i);

    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, created.json().id));
    expect(entries[0]).toMatchObject({ action: 'staff_created', subjectType: 'staff', after: 'Created' });
    expect(entries[0]!.reason).toContain('support team');
    // The audit log never records a password or a code.
    expect(JSON.stringify(entries)).not.toContain(TEMP);
  });

  it('refuses the same email twice', async () => {
    const first = await addStaff({ email: 'twice@sxmrentals.test' });
    expect(first.statusCode).toBe(201);
    const again = await addStaff({ email: 'twice@sxmrentals.test' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('staff_exists');
  });
});

describe('a brand-new account', () => {
  it('can do nothing until it sets its own password', async () => {
    const created = (await addStaff({ email: 'newbie@sxmrentals.test' })).json();
    const session = await signInAsStaff('newbie@sxmrentals.test', TEMP);
    expect(session.mustChangePassword).toBe(true);

    // Everything is refused, in a way the panel can act on...
    for (const address of ['/admin/summary', '/admin/users', '/admin/staff', '/admin/queue']) {
      const res = await get(address, asStaff(session.cookie));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('password_change_required');
    }
    // ...except the three it needs to fix that.
    const me = await get('/admin/me', asStaff(session.cookie));
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: created.id, mustChangePassword: true });

    // A wrong current password is a typo, NOT an ended session.
    const wrong = await post(
      '/admin/auth/password',
      { currentPassword: 'not the temporary one', newPassword: OWN },
      asStaff(session.cookie),
    );
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('wrong_current_password');

    // Reusing the temporary password is refused too.
    const same = await post(
      '/admin/auth/password',
      { currentPassword: TEMP, newPassword: TEMP },
      asStaff(session.cookie),
    );
    expect(same.statusCode).toBe(400);
    expect(same.json().error.code).toBe('same_password');

    // Setting their own password opens everything, on this same session.
    const changed = await post(
      '/admin/auth/password',
      { currentPassword: TEMP, newPassword: OWN },
      asStaff(session.cookie),
    );
    expect(changed.statusCode).toBe(204);
    expect((await get('/admin/summary', asStaff(session.cookie))).statusCode).toBe(200);
    expect((await get('/admin/me', asStaff(session.cookie))).json().mustChangePassword).toBe(false);

    // The temporary password no longer works.
    const oldPassword = await post('/admin/auth/login', { email: 'newbie@sxmrentals.test', password: TEMP });
    expect(oldPassword.statusCode).toBe(401);
  });

  it('signs their other devices out when they set their password, but not this one', async () => {
    await addStaff({ email: 'twodevices@sxmrentals.test' });
    const phone = await signInAsStaff('twodevices@sxmrentals.test', TEMP);
    const laptop = await signInAsStaff('twodevices@sxmrentals.test', TEMP, phone.secret);

    await post('/admin/auth/password', { currentPassword: TEMP, newPassword: OWN }, asStaff(laptop.cookie));

    expect((await get('/admin/me', asStaff(laptop.cookie))).statusCode).toBe(200);
    expect((await get('/admin/me', asStaff(phone.cookie))).statusCode).toBe(401);
  });
});

describe('a fresh start for somebody locked out', () => {
  it('issues a temporary password, signs them out everywhere, and is recorded', async () => {
    const person = (await addStaff({ email: 'forgetful@sxmrentals.test' })).json();
    const session = await signInAsStaff('forgetful@sxmrentals.test', TEMP);
    await post('/admin/auth/password', { currentPassword: TEMP, newPassword: OWN }, asStaff(session.cookie));

    const reset = await post(
      `/admin/staff/${person.id}/reset`,
      { password: 'another temporary passphrase', reason: 'They forgot it and asked at the desk.', code: await code() },
      asStaff(boss.cookie),
    );
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ mustChangePassword: true, mfaEnrolled: true });

    // Their session is gone, and their old password no longer works.
    expect((await get('/admin/me', asStaff(session.cookie))).statusCode).toBe(401);
    expect((await post('/admin/auth/login', { email: 'forgetful@sxmrentals.test', password: OWN })).statusCode).toBe(401);

    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, person.id));
    expect(entries.some((e) => e.action === 'staff_reset' && e.after === 'Temporary password issued')).toBe(true);
  });

  it('can also forget a lost phone, so they set up an authenticator again', async () => {
    const person = (await addStaff({ email: 'lostphone@sxmrentals.test' })).json();
    await signInAsStaff('lostphone@sxmrentals.test', TEMP);

    const reset = await post(
      `/admin/staff/${person.id}/reset`,
      {
        password: 'replacement passphrase here',
        resetAuthenticator: true,
        reason: 'Phone lost; setting them up again.',
        code: await code(),
      },
      asStaff(boss.cookie),
    );
    expect(reset.statusCode).toBe(200);
    expect(reset.json().mfaEnrolled).toBe(false);

    // Signing in now starts at "set up an authenticator app" again.
    const login = await post('/admin/auth/login', {
      email: 'lostphone@sxmrentals.test',
      password: 'replacement passphrase here',
    });
    expect(login.json().next).toBe('enroll');
  });

  it('will not let anybody reset their own account', async () => {
    const me = (await get('/admin/me', asStaff(boss.cookie))).json();
    const res = await post(
      `/admin/staff/${me.id}/reset`,
      { password: 'trying to reset myself', reason: 'Testing the guard.', code: await code() },
      asStaff(boss.cookie),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('cannot_reset_self');
  });
});

describe('switching an account off and on', () => {
  it('signs them out, stops them signing in, and lets them back later', async () => {
    const person = (await addStaff({ email: 'leaving@sxmrentals.test' })).json();
    const session = await signInAsStaff('leaving@sxmrentals.test', TEMP);

    const disabled = await post(
      `/admin/staff/${person.id}/disable`,
      { reason: 'Left the company today.', code: await code() },
      asStaff(boss.cookie),
    );
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().disabledAt).toBeTruthy();

    expect((await get('/admin/me', asStaff(session.cookie))).statusCode).toBe(401);
    expect((await post('/admin/auth/login', { email: 'leaving@sxmrentals.test', password: TEMP })).statusCode).toBe(401);

    // Off the default list, but findable.
    const active = (await get('/admin/staff', asStaff(boss.cookie))).json();
    expect(active.some((s: { id: string }) => s.id === person.id)).toBe(false);
    const off = (await get('/admin/staff?status=disabled', asStaff(boss.cookie))).json();
    expect(off.some((s: { id: string }) => s.id === person.id)).toBe(true);

    expect(
      (await post(`/admin/staff/${person.id}/disable`, { reason: 'Again.', code: await code() }, asStaff(boss.cookie)))
        .statusCode,
    ).toBe(409);

    const enabled = await post(
      `/admin/staff/${person.id}/enable`,
      { reason: 'Came back part time.', code: await code() },
      asStaff(boss.cookie),
    );
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().disabledAt).toBeNull();
    expect((await post('/admin/auth/login', { email: 'leaving@sxmrentals.test', password: TEMP })).statusCode).toBe(200);
  });

  it('will not let anybody switch off their own account', async () => {
    const me = (await get('/admin/me', asStaff(boss.cookie))).json();
    const res = await post(
      `/admin/staff/${me.id}/disable`,
      { reason: 'Testing the guard.', code: await code() },
      asStaff(boss.cookie),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('cannot_disable_self');
  });
});

describe('the walls around all of this', () => {
  it('is closed to a customer and to a stranger', async () => {
    const account = await createVerifiedAccount(ctx);
    const customer = await signInMobile(ctx, account.email, account.password);
    const asCustomer = { authorization: `Bearer ${customer}`, origin: WEB_ORIGIN };

    expect((await get('/admin/staff', asCustomer)).statusCode).toBe(401);
    expect((await post('/admin/staff', { name: 'X', email: 'x@y.test', password: TEMP, reason: 'no', code: '000000' }, asCustomer)).statusCode).toBe(401);
    expect((await get('/admin/staff')).statusCode).toBe(401);
  });

  it('counts wrong codes towards the same lockout as wrong passwords', async () => {
    const victim = await createSignedInStaff(ctx, 'Lockout Tester');
    // Five wrong codes in a row.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await post(
        '/admin/staff',
        { name: 'Nope', email: `nope${attempt}@sxmrentals.test`, password: TEMP, reason: 'Testing lockout.', code: '000000' },
        asStaff(victim.cookie),
      );
      expect(res.statusCode).toBe(400);
    }
    // The sixth is refused as a lockout, with a wait.
    const locked = await post(
      '/admin/staff',
      { name: 'Nope', email: 'nope-final@sxmrentals.test', password: TEMP, reason: 'Testing lockout.', code: '000000' },
      asStaff(victim.cookie),
    );
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });
});
