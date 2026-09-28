// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests handing the Godfather role to an existing account —
// the work behind `npm run admin:godfather`.
//
// The Godfather is the one account nobody else can disable, reset or demote, so
// the panel cannot move it; only somebody with access to the server can. The
// tests that matter: there is never a moment with two Godfathers (the database
// would refuse it), the previous one becomes an Owner rather than losing
// everything, and a switched-off account cannot be made the account nobody can
// switch off.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminStaff } from '../src/db/schema/index.js';
import { createAdminAuthService } from '../src/services/admin/auth.js';
import { makeGodfather } from '../src/services/admin/godfather.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let counter = 0;

async function anAccount(tier: 'godfather' | 'owner' | 'administrator' | 'viewer', name: string) {
  counter += 1;
  const auth = createAdminAuthService({ db: ctx.db, config: ctx.config, logger: { warn: () => {} } });
  return auth.createStaff({
    name,
    email: `godfather-test-${counter}@sxmrentals.test`,
    password: 'a long staff passphrase',
    tier,
  });
}

const tierOf = async (id: string) =>
  (await ctx.db.select({ tier: adminStaff.tier }).from(adminStaff).where(eq(adminStaff.id, id)))[0]?.tier;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('handing over the Godfather role', () => {
  it('makes the named account Godfather when there is none yet', async () => {
    const first = await anAccount('administrator', 'First Person');

    const result = await makeGodfather(ctx.db, first.email);
    expect(result).toMatchObject({ changed: true, previous: null });
    expect(await tierOf(first.id)).toBe('godfather');
  });

  it('makes the previous Godfather an Owner, in the same step', async () => {
    const [current] = await ctx.db.select().from(adminStaff).where(eq(adminStaff.tier, 'godfather'));
    const next = await anAccount('owner', 'Next Person');

    const result = await makeGodfather(ctx.db, next.email);
    expect(result.changed).toBe(true);
    expect(result.previous?.email).toBe(current!.email);

    // One Godfather, and the previous one keeps real authority rather than
    // falling to nothing.
    expect(await tierOf(next.id)).toBe('godfather');
    expect(await tierOf(current!.id)).toBe('owner');
    const godfathers = await ctx.db.select().from(adminStaff).where(eq(adminStaff.tier, 'godfather'));
    expect(godfathers).toHaveLength(1);
  });

  it('changes nothing when the account already is the Godfather', async () => {
    const [current] = await ctx.db.select().from(adminStaff).where(eq(adminStaff.tier, 'godfather'));
    const result = await makeGodfather(ctx.db, current!.email);
    expect(result.changed).toBe(false);
  });

  it('finds the account however the address is typed', async () => {
    const person = await anAccount('viewer', 'Mixed Case');
    const result = await makeGodfather(ctx.db, `  ${person.email.toUpperCase()}  `);
    expect(result.changed).toBe(true);
    expect(await tierOf(person.id)).toBe('godfather');
  });

  it('refuses a switched-off account, which would be an account nobody could use or remove', async () => {
    const off = await anAccount('administrator', 'Switched Off');
    await ctx.db.update(adminStaff).set({ disabledAt: new Date() }).where(eq(adminStaff.id, off.id));

    await expect(makeGodfather(ctx.db, off.email)).rejects.toThrow(/switched off/);
    expect(await tierOf(off.id)).toBe('administrator');
  });

  it('says plainly when there is no such account', async () => {
    await expect(makeGodfather(ctx.db, 'nobody@sxmrentals.test')).rejects.toThrow(/no staff account/);
  });
});
