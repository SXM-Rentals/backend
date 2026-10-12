// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Lets the Godfather see when every member of staff —
// owners, administrators and viewers — signed in and out, and how long each
// session lasted.
//
// NOTHING NEW IS RECORDED. Every staff sign-in already leaves a row in
// admin_sessions (when it began, when it was last used, when it was ended, from
// which address and device) and no row is ever deleted, so this only reads what is
// there. A sign-in counts once the authenticator code has been given; a session
// that stopped at the password step is not a sign-in.
//
// HOW A SESSION ENDED:
//   signed_out  somebody ended it: the member of staff signing out, or an
//               administrator resetting or switching off their account
//   timed_out   half an hour without use, or eight hours since it began
//   active      still open now
//
// Godfather only. Reading this writes nothing, anywhere.

import { and, count, desc, eq, gt, isNull, not } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adminSessions, adminStaff } from '../../db/schema/index.js';
import type { AdminActor } from './auth.js';
import { requireTier, type AdminTier } from './tiers.js';

const PAGE_LIMIT = 200;

export type SignInQuery = {
  staffId?: string | undefined;
  tier?: AdminTier | undefined;
  status?: 'active' | 'ended' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export function createSignInHistory(deps: { db: Database }) {
  const { db } = deps;

  // A session is open when it is not ended and neither clock has run out — the
  // same test the sign-in itself uses (see auth.ts).
  const isActive = (now: Date) =>
    and(isNull(adminSessions.revokedAt), gt(adminSessions.idleExpiresAt, now), gt(adminSessions.absoluteExpiresAt, now));

  return {
    async list(actor: AdminActor, query: SignInQuery) {
      requireTier(actor, 'godfather');
      const now = new Date();
      const where = and(
        eq(adminSessions.mfaPassed, true),
        query.staffId ? eq(adminSessions.staffId, query.staffId) : undefined,
        query.tier ? eq(adminStaff.tier, query.tier) : undefined,
        query.status === 'active' ? isActive(now) : undefined,
        query.status === 'ended' ? not(isActive(now)!) : undefined,
      );

      const [total] = await db
        .select({ value: count() })
        .from(adminSessions)
        .innerJoin(adminStaff, eq(adminStaff.id, adminSessions.staffId))
        .where(where);
      const rows = await db
        .select({ session: adminSessions, staff: adminStaff })
        .from(adminSessions)
        .innerJoin(adminStaff, eq(adminStaff.id, adminSessions.staffId))
        .where(where)
        .orderBy(desc(adminSessions.createdAt), desc(adminSessions.id))
        .limit(Math.min(query.limit ?? 50, PAGE_LIMIT))
        .offset(query.offset ?? 0);

      return {
        total: total?.value ?? 0,
        sessions: rows.map(({ session, staff }) => {
          // The clocks run out at a known moment even if nobody was looking; a
          // session ended by hand before then ended when it was ended.
          const ranOut = new Date(Math.min(session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime()));
          const byHand = session.revokedAt && session.revokedAt.getTime() <= ranOut.getTime() ? session.revokedAt : null;
          const endedAt = byHand ?? (ranOut.getTime() <= now.getTime() ? ranOut : null);
          const status = byHand ? ('signed_out' as const) : endedAt ? ('timed_out' as const) : ('active' as const);
          return {
            id: session.id,
            staff: { id: staff.id, name: staff.name, email: staff.email, tier: staff.tier },
            signedInAt: session.createdAt.toISOString(),
            endedAt: endedAt?.toISOString() ?? null,
            status,
            lastSeenAt: session.lastSeenAt.toISOString(),
            durationSeconds: Math.max(0, Math.floor(((endedAt ?? now).getTime() - session.createdAt.getTime()) / 1000)),
            ipAddress: session.ipAddress,
            device: session.userAgent?.slice(0, 300) ?? null,
          };
        }),
      };
    },
  };
}

export type SignInHistory = ReturnType<typeof createSignInHistory>;
