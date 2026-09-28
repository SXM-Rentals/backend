// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Hands the Godfather role to an existing staff account. It
// is the work behind `npm run admin:godfather`, and it is deliberately reachable
// from NOWHERE ELSE — no route, no panel button. DO NOT WIRE IT TO ONE.
//
// WHY IT LIVES ONLY ON THE SERVER: the Godfather is the one account nobody else
// can disable, reset or demote. If the panel could hand the role over, then
// whoever held a session in the panel could make themselves untouchable. Moving
// it needs access to the server and the live database address, which is a much
// smaller circle than "whoever is signed in".
//
// There is exactly one Godfather, and the database enforces it (a unique index
// on the tier). So handing it over is two steps in one transaction, in this
// order: the current one becomes an Owner, THEN the new one becomes Godfather.
// The other order would, for a moment, be two Godfathers, and the database would
// refuse it.

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adminSessions, adminStaff } from '../../db/schema/index.js';
import { conflict, notFound } from '../../lib/errors.js';

export type GodfatherHandover = {
  name: string;
  email: string;
  // Who held it before, now an Owner — or null if nobody did.
  previous: { name: string; email: string } | null;
  // False when the account already was the Godfather: nothing was changed.
  changed: boolean;
};

export async function makeGodfather(db: Database, rawEmail: string): Promise<GodfatherHandover> {
  const email = rawEmail.trim().toLowerCase();
  const [target] = await db.select().from(adminStaff).where(eq(adminStaff.email, email)).limit(1);
  if (!target) throw notFound(`There is no staff account for ${email}.`);

  // A switched-off account as the one nobody can switch off would be an account
  // nobody can use or remove. Switch it back on first (npm run admin:reset does).
  if (target.disabledAt) {
    throw conflict(
      'account_disabled',
      `${target.name}'s account is switched off. Switch it back on first — npm run admin:reset does that.`,
    );
  }

  const [current] = await db.select().from(adminStaff).where(eq(adminStaff.tier, 'godfather')).limit(1);
  if (current?.id === target.id) {
    return { name: target.name, email: target.email, previous: null, changed: false };
  }

  await db.transaction(async (tx) => {
    // First down, then up: the database allows exactly one Godfather at a time.
    if (current) {
      await tx.update(adminStaff).set({ tier: 'owner' }).where(eq(adminStaff.id, current.id));
    }
    await tx.update(adminStaff).set({ tier: 'godfather' }).where(eq(adminStaff.id, target.id));

    // Whoever's level changed signs in again, the same rule as a change made in
    // the panel: their level applies from the next request either way, but the
    // panel they had open was drawn for the old one.
    const now = new Date();
    for (const id of [target.id, current?.id].filter((value): value is string => Boolean(value))) {
      await tx.update(adminSessions).set({ revokedAt: now }).where(eq(adminSessions.staffId, id));
    }
  });

  return {
    name: target.name,
    email: target.email,
    previous: current ? { name: current.name, email: current.email } : null,
    changed: true,
  };
}
