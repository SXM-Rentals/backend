// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what each kind of staff account is allowed to do.
//
// Until now there was one flat level: every staff account could do everything,
// and the trade behind that was accountability rather than restriction. Tiers add
// restriction on top of that record — the audit log is unchanged for every tier.
//
// The tests that matter most are the ones that stop a tier system being a ladder
// anybody can climb:
//
//   - a VIEWER is refused every change BY METHOD, not by a list of routes. The
//     test asserts that directly, against an address invented inside the test, so
//     it also covers addresses added years from now;
//   - nobody can act on an account at their own level or above — an owner cannot
//     reset another owner, and nobody but the godfather touches the godfather;
//   - nobody can grant a level at or above their own, and godfather cannot be
//     granted through the panel at all;
//   - nobody can change their OWN level, whoever they are. That is the difference
//     between a hierarchy and a ladder.

import { eq } from 'drizzle-orm';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminStaff, auditLog } from '../src/db/schema/index.js';
import { createAdminAuthService } from '../src/services/admin/auth.js';
import {
  createSignedInStaff,
  createTestContext,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
// THE ONE GODFATHER. The database allows exactly one per database, and every test
// file gets its own database, so the tests that need one share this.
let godfather: Awaited<ReturnType<typeof anAccount>>;

type Staff = Awaited<ReturnType<typeof createSignedInStaff>>;

const as = (who: Staff) => ({ cookie: who.cookie, origin: WEB_ORIGIN });
const code = (who: Staff) => generateOtp({ secret: who.secret });

const get = (url: string, who: Staff) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: as(who), remoteAddress: uniqueIp() });
const post = (url: string, payload: object, who: Staff) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: as(who), remoteAddress: uniqueIp() });
const patch = (url: string, payload: object, who: Staff) =>
  ctx.app.inject({ method: 'PATCH', url: `/api/v1${url}`, payload, headers: as(who), remoteAddress: uniqueIp() });

// A staff account at a given tier that is NOT signed in — something to act upon.
let subjectCounter = 0;
async function anAccount(tier: 'godfather' | 'owner' | 'administrator' | 'viewer', name?: string) {
  subjectCounter += 1;
  const auth = createAdminAuthService({ db: ctx.db, config: ctx.config, logger: { warn: () => {} } });
  return auth.createStaff({
    name: name ?? `Subject ${subjectCounter}`,
    email: `subject${subjectCounter}@sxmrentals.test`,
    password: 'a long staff passphrase',
    tier,
  });
}

const newAccount = (tier: 'owner' | 'administrator' | 'viewer', label: string) => ({
  name: `Created ${label}`,
  email: `created-${label.toLowerCase().replace(/\W/g, '')}@sxmrentals.test`,
  password: 'another long staff passphrase',
  tier,
});

beforeAll(async () => {
  ctx = await createTestContext();
  godfather = await anAccount('godfather', 'The Godfather');
});
afterAll(async () => {
  await ctx.close();
});

describe('a viewer', () => {
  it('reads everything and changes nothing, whatever the address', async () => {
    const viewer = await createSignedInStaff(ctx, 'Val Viewer', 'viewer');

    // Reading works, including the things a viewer is there for.
    for (const url of ['/admin/me', '/admin/summary', '/admin/queue', '/admin/audit', '/admin/staff']) {
      const read = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1${url}`,
        headers: as(viewer),
        remoteAddress: uniqueIp(),
      });
      expect(read.statusCode, url).toBe(200);
    }

    // And every kind of change is refused.
    const changes: [string, string, object][] = [
      ['POST', '/admin/staff', { ...newAccount('viewer', 'ByViewer'), reason: 'Trying it on.', code: '000000' }],
      ['PATCH', '/admin/users/00000000-0000-4000-8000-000000000000', { field: 'phone', value: '1', reason: 'Trying it on.' }],
      ['POST', '/admin/providers/00000000-0000-4000-8000-000000000000/close', { reason: 'Trying it on.', code: '000000' }],
      ['DELETE', '/admin/users/00000000-0000-4000-8000-000000000000', { reason: 'Trying it on.' }],
    ];
    for (const [method, url, payload] of changes) {
      const refused = await ctx.app.inject({
        method: method as 'POST',
        url: `/api/v1${url}`,
        payload,
        headers: as(viewer),
        remoteAddress: uniqueIp(),
      });
      expect(refused.statusCode, `${method} ${url}`).toBe(403);
      expect(refused.json().error.code).toBe('read_only');
    }
  });

  // The rule is one hook on the method, not a check written into each handler.
  // This test proves that by going through EVERY non-read admin address the panel
  // has — including the ones with no tier check of their own — and asserting the
  // same refusal from all of them. An address added to routes/admin later is
  // covered by the same hook without anybody remembering to add it.
  it('is refused by the method, not by a list of routes', async () => {
    const viewer = await createSignedInStaff(ctx, 'Val Viewer', 'viewer');
    const nowhere = '00000000-0000-4000-8000-000000000000';

    // Deliberately includes addresses that have NO requireTier of their own: if
    // the rule were written per route, these are the ones that would be missed.
    const everyChange: [string, string][] = [
      ['PATCH', `/admin/users/${nowhere}`],
      ['DELETE', `/admin/users/${nowhere}`],
      ['PATCH', `/admin/users/${nowhere}/points`],
      ['POST', `/admin/providers/${nowhere}/verification`],
      ['PATCH', `/admin/providers/${nowhere}`],
      ['POST', `/admin/providers/${nowhere}/close`],
      ['POST', `/admin/vehicles/${nowhere}/listing`],
      ['POST', `/admin/deposits/${nowhere}/release`],
      ['POST', `/admin/refunds/${nowhere}/decision`],
      ['POST', `/admin/disputes/${nowhere}/assign`],
      ['POST', `/admin/vehicles/documents/${nowhere}/review`],
      ['POST', `/admin/staff/${nowhere}/disable`],
      ['POST', `/admin/staff/${nowhere}/tier`],
    ];

    for (const [method, url] of everyChange) {
      const refused = await ctx.app.inject({
        method: method as 'POST',
        url: `/api/v1${url}`,
        // Whatever the body, the refusal comes before anything reads it.
        payload: { reason: 'Trying it on.', code: '000000', tier: 'viewer', approve: true, value: '1', field: 'phone', points: 1 },
        headers: as(viewer),
        remoteAddress: uniqueIp(),
      });
      expect(refused.statusCode, `${method} ${url}`).toBe(403);
      expect(refused.json().error.code, `${method} ${url}`).toBe('read_only');
    }
  });
});

describe('an administrator', () => {
  it('does the everyday job but cannot manage staff', async () => {
    const admin = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');

    // The everyday job: reading the panel, and the things it decides.
    expect((await get('/admin/summary', admin)).statusCode).toBe(200);
    // Knowing who your colleagues are is not a privilege — the dispute picker
    // needs it.
    expect((await get('/admin/staff', admin)).statusCode).toBe(200);

    // But not adding one, resetting one, or switching one off.
    const subject = await anAccount('administrator');
    const attempts = [
      post('/admin/staff', { ...newAccount('viewer', 'ByAdmin'), reason: 'Trying it on.', code: await code(admin) }, admin),
      post(`/admin/staff/${subject.id}/reset`, { password: 'a long new passphrase', reason: 'Trying it on.', code: await code(admin) }, admin),
      post(`/admin/staff/${subject.id}/disable`, { reason: 'Trying it on.', code: await code(admin) }, admin),
      post(`/admin/staff/${subject.id}/tier`, { tier: 'viewer', reason: 'Trying it on.', code: await code(admin) }, admin),
    ];
    for (const attempt of attempts) {
      const refused = await attempt;
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('not_allowed');
      // It says what would be needed, so the person knows who to ask.
      expect(refused.json().error.message).toContain('Owner');
    }
  });
});

describe('acting on somebody else', () => {
  it('refuses an account at your own level or above', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');
    const anotherOwner = await anAccount('owner', 'Other Owner');

    for (const subject of [anotherOwner, godfather]) {
      const refused = await post(
        `/admin/staff/${subject.id}/disable`,
        { reason: 'Trying it on.', code: await code(owner) },
        owner,
      );
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('not_allowed');
    }

    // Nothing happened to either.
    for (const subject of [anotherOwner, godfather]) {
      const [row] = await ctx.db.select().from(adminStaff).where(eq(adminStaff.id, subject.id));
      expect(row?.disabledAt).toBeNull();
    }
  });

  it('says plainly that the godfather is nobody else to touch', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');

    const refused = await post(
      `/admin/staff/${godfather.id}/reset`,
      { password: 'a long new passphrase', reason: 'Trying it on.', code: await code(owner) },
      owner,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('Godfather');
  });

  it('allows an owner to act on an administrator', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');
    const junior = await anAccount('administrator');

    const disabled = await post(
      `/admin/staff/${junior.id}/disable`,
      { reason: 'They have left the company.', code: await code(owner) },
      owner,
    );
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().disabledAt).toEqual(expect.any(String));
  });
});

describe('granting a level', () => {
  it('refuses one at or above your own', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');

    // An owner cannot make another owner.
    const refused = await post(
      '/admin/staff',
      { ...newAccount('owner', 'AnotherOwner'), reason: 'Trying it on.', code: await code(owner) },
      owner,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('not_allowed');

    // But can make an administrator.
    const created = await post(
      '/admin/staff',
      { ...newAccount('administrator', 'NewAdmin'), reason: 'Starting on Monday.', code: await code(owner) },
      owner,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().tier).toBe('administrator');
  });

  it('will not accept the word godfather at all', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');
    const junior = await anAccount('administrator');

    // Refused at the edge, as a word the panel does not accept from anybody.
    // There is one godfather and it moves by a command on the server.
    const refused = await post(
      `/admin/staff/${junior.id}/tier`,
      { tier: 'godfather', reason: 'Trying it on.', code: await code(owner) },
      owner,
    );
    expect(refused.statusCode).toBe(400);
  });

  it('cannot produce a second godfather, even straight into the database', async () => {
    const auth = createAdminAuthService({ db: ctx.db, config: ctx.config, logger: { warn: () => {} } });
    // One already exists (see beforeAll). THE DATABASE IS WHAT REFUSES THE
    // SECOND, not the code alone: a rule kept only in code holds until somebody
    // writes a script, and this bypasses every line of ours.
    await expect(
      auth.createStaff({
        name: 'Second Godfather',
        email: 'second-godfather@sxmrentals.test',
        password: 'a long staff passphrase',
        tier: 'godfather',
      }),
    ).rejects.toThrow();
  });
});

describe('changing what somebody may do', () => {
  it('records the levels in words, and signs them out', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');
    const junior = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');

    const changed = await post(
      `/admin/staff/${junior.staffId}/tier`,
      { tier: 'viewer', reason: 'Moving to the bookkeeping side.', code: await code(owner) },
      owner,
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.json().tier).toBe('viewer');

    const [entry] = await ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, junior.staffId));
    expect(entry).toMatchObject({
      action: 'staff_tier_changed',
      field: 'Access level',
      // Words, so the log reads as a sentence next year.
      before: 'Administrator',
      after: 'Viewer',
      reason: 'Moving to the bookkeeping side.',
    });

    // THEIR SESSION ENDS. The new level would apply from their next request
    // anyway — it is read fresh every time — but the panel they had open was
    // drawn for the old one, so they sign in again to a panel that matches.
    const afterwards = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/summary',
      headers: as(junior),
      remoteAddress: uniqueIp(),
    });
    expect(afterwards.statusCode).toBe(401);
  });

  it('refuses your own account, whoever you are', async () => {
    // An owner, who outranks the level they are asking for and may change other
    // people's — the only thing stopping this is that it is their own account.
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');

    const refused = await post(
      `/admin/staff/${owner.staffId}/tier`,
      { tier: 'viewer', reason: 'Trying it on.', code: await code(owner) },
      owner,
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('cannot_change_own_tier');
  });

  it('refuses a level somebody already has', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');
    const junior = await anAccount('administrator');

    const refused = await post(
      `/admin/staff/${junior.id}/tier`,
      { tier: 'administrator', reason: 'No change really.', code: await code(owner) },
      owner,
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('already_that_tier');
  });

  it('still needs the authenticator code, like every other staff change', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');
    const junior = await anAccount('administrator');

    const refused = await post(
      `/admin/staff/${junior.id}/tier`,
      { tier: 'viewer', reason: 'Trying it on.', code: '000000' },
      owner,
    );
    // 400, never 401: the panel reads a 401 as "your session ended" and covers
    // the screen with a sign-in. A mistyped code is a typo.
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('wrong_code');
  });
});

describe('what the panel is told', () => {
  it('says the level on your own record and on each colleague', async () => {
    const owner = await createSignedInStaff(ctx, 'Olive Owner', 'owner');

    const me = await get('/admin/me', owner);
    expect(me.json().tier).toBe('owner');

    const list = await get('/admin/staff?status=all', owner);
    expect(list.json().every((person: { tier: string }) => typeof person.tier === 'string')).toBe(true);
  });
});
