// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the Godfather's view of when staff signed in and
// out, and how long each session lasted.
//
// The tests that matter most: only the Godfather can see it; every tier shows up
// with the right start, end and length; a session that never got past the
// password is not a sign-in; the three ways a session stands (still open, signed
// out, timed out) are told apart; and looking records nothing anywhere.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSessions, auditLog } from '../src/db/schema/index.js';
import { createSignedInStaff, createTestContext, uniqueIp, WEB_ORIGIN, type TestContext } from './helpers.js';

type Staff = Awaited<ReturnType<typeof createSignedInStaff>>;

let ctx: TestContext;
let godfather: Staff;
let owner: Staff;
let administrator: Staff;
let viewer: Staff;

const see = (who: Staff, query = '') =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/v1/admin/sessions${query}`,
    headers: { cookie: who.cookie, origin: WEB_ORIGIN },
    remoteAddress: uniqueIp(),
  });

type Listed = {
  id: string;
  staff: { id: string; name: string; email: string; tier: string };
  signedInAt: string;
  endedAt: string | null;
  status: 'active' | 'signed_out' | 'timed_out';
  lastSeenAt: string;
  durationSeconds: number;
  ipAddress: string | null;
  device: string | null;
};
const listed = async (query = '') => ((await see(godfather, query)).json() as { total: number; sessions: Listed[] });
const sessionOf = async (who: Staff) => (await ctx.db.select().from(adminSessions).where(eq(adminSessions.staffId, who.staffId)))[0]!;

beforeAll(async () => {
  ctx = await createTestContext();
  godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');
  owner = await createSignedInStaff(ctx, 'Olivia Owner', 'owner');
  administrator = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');
  viewer = await createSignedInStaff(ctx, 'Vera Viewer', 'viewer');
});
afterAll(async () => {
  await ctx.close();
});

describe('who may look', () => {
  it('is the Godfather only', async () => {
    for (const who of [owner, administrator, viewer]) {
      const res = await see(who);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('not_allowed');
    }
    expect((await see(godfather)).statusCode).toBe(200);
  });
});

describe('what it shows', () => {
  it('has every tier, each still signed in, with who and when', async () => {
    const { total, sessions } = await listed();
    expect(total).toBe(4);
    expect(sessions.map((session) => session.staff.tier).sort()).toEqual(['administrator', 'godfather', 'owner', 'viewer']);
    for (const session of sessions) {
      expect(session.status).toBe('active');
      expect(session.endedAt).toBeNull();
      expect(session.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(session.signedInAt))).toBe(false);
      expect(Number.isNaN(Date.parse(session.lastSeenAt))).toBe(false);
    }
    expect(sessions.find((session) => session.staff.tier === 'owner')!.staff).toMatchObject({
      name: 'Olivia Owner',
      email: owner.email,
    });
  });

  it('keeps a sign-in when the person signs out, and says when they did and how long it lasted', async () => {
    const before = await sessionOf(owner);
    // Backdate the start so the length is something to check.
    await ctx.db
      .update(adminSessions)
      .set({ createdAt: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(adminSessions.id, before.id));

    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/logout',
      headers: { cookie: owner.cookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
    });
    expect(out.statusCode).toBeLessThan(300);

    const mine = (await listed(`?staffId=${owner.staffId}`)).sessions;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'signed_out' });
    expect(mine[0]!.endedAt).not.toBeNull();
    // About twenty minutes: began twenty minutes ago, ended just now.
    expect(mine[0]!.durationSeconds).toBeGreaterThanOrEqual(20 * 60);
    expect(mine[0]!.durationSeconds).toBeLessThan(21 * 60);
  });

  it('tells a timed-out session from a signed-out one, and ends it when the clock ran out', async () => {
    const session = await sessionOf(administrator);
    const ranOutAt = new Date(Date.now() - 10 * 60 * 1000);
    await ctx.db
      .update(adminSessions)
      .set({ createdAt: new Date(ranOutAt.getTime() - 45 * 60 * 1000), idleExpiresAt: ranOutAt })
      .where(eq(adminSessions.id, session.id));

    const [shown] = (await listed(`?staffId=${administrator.staffId}`)).sessions;
    expect(shown).toMatchObject({ status: 'timed_out', endedAt: ranOutAt.toISOString(), durationSeconds: 45 * 60 });
  });

  it('ends a session at the earlier of signing out and the clock running out', async () => {
    // Ran out ten minutes ago, then somebody ended it today: it ended when it ran out.
    const session = await sessionOf(administrator);
    await ctx.db.update(adminSessions).set({ revokedAt: new Date() }).where(eq(adminSessions.id, session.id));
    const [shown] = (await listed(`?staffId=${administrator.staffId}`)).sessions;
    expect(shown!.status).toBe('timed_out');
  });

  it('does not count a session that stopped at the password', async () => {
    const before = (await listed()).total;
    await ctx.db.insert(adminSessions).values({
      staffId: viewer.staffId,
      tokenHash: 'half-finished-sign-in',
      mfaPassed: false,
      idleExpiresAt: new Date(Date.now() + 600_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await listed()).total).toBe(before);
  });

  it('works out a length from a stored start and end', async () => {
    const now = Date.now();
    await ctx.db.insert(adminSessions).values({
      staffId: viewer.staffId,
      tokenHash: 'long-ago',
      mfaPassed: true,
      createdAt: new Date(now - 2 * 3600_000),
      lastSeenAt: new Date(now - 40 * 60_000),
      revokedAt: new Date(now - 30 * 60_000),
      idleExpiresAt: new Date(now + 3600_000),
      absoluteExpiresAt: new Date(now + 6 * 3600_000),
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (test)',
    });
    const found = (await listed(`?staffId=${viewer.staffId}`)).sessions.find((session) => session.ipAddress === '203.0.113.9')!;
    expect(found).toMatchObject({ status: 'signed_out', durationSeconds: 90 * 60, device: 'Mozilla/5.0 (test)' });
  });
});

describe('finding things', () => {
  it('filters by person, by tier and by whether it is still open', async () => {
    expect((await listed(`?tier=viewer`)).sessions.every((session) => session.staff.tier === 'viewer')).toBe(true);
    expect((await listed(`?staffId=${godfather.staffId}`)).total).toBe(1);

    const open = (await listed('?status=active')).sessions;
    const ended = (await listed('?status=ended')).sessions;
    expect(open.every((session) => session.status === 'active')).toBe(true);
    expect(ended.every((session) => session.status !== 'active')).toBe(true);
    expect(open.length + ended.length).toBe((await listed()).total);
    expect(ended.length).toBeGreaterThanOrEqual(3);
  });

  it('puts the newest first and pages', async () => {
    const all = (await listed()).sessions;
    const times = all.map((session) => Date.parse(session.signedInAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const page = await listed('?limit=2&offset=1');
    expect(page.total).toBe(all.length);
    expect(page.sessions.map((session) => session.id)).toEqual(all.slice(1, 3).map((session) => session.id));
  });

  it('refuses nonsense in the query', async () => {
    for (const query of ['?tier=boss', '?status=maybe', '?staffId=nobody', '?limit=0', '?limit=500']) {
      expect((await see(godfather, query)).statusCode).toBe(400);
    }
  });
});

describe('looking records nothing', () => {
  it('writes no audit entry', async () => {
    const before = (await ctx.db.select().from(auditLog)).length;
    await see(godfather);
    await see(godfather, `?staffId=${owner.staffId}`);
    expect((await ctx.db.select().from(auditLog)).length).toBe(before);
  });
});
