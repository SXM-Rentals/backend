// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Looks after sign-in sessions — the thing that keeps
// somebody signed in on a device after they type their password once. It
// starts a session, recognises a returning one, lists a person's signed-in
// devices, and ends one or all of them.
//
// How it stays safe:
//   - each session is a long random code; only its fingerprint is stored;
//   - a session ends after 7 days without use, and after 30 days regardless;
//   - ending a session takes effect on the very next request, because every
//     request is checked against the database rather than trusted on sight;
//   - a closed account's sessions stop working immediately.

import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { customers, sessions } from '../../db/schema/index.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import type { Actor } from '../../lib/ownership.js';

// ---- HOW LONG A SESSION LASTS ----
const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * DAY_MS;
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
// "Last seen" is refreshed at most this often, so reading a page does not
// write to the database on every single request.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type ClientInfo = { userAgent?: string | undefined; ipAddress?: string | undefined };
export type NewSession = { id: string; token: string; expiresAt: Date };

// ---- STARTING A SESSION ----
// Always a brand-new code — never a reused one — so a code someone may have
// seen before signing in is worthless afterwards.
export async function createSession(db: Database, customerId: string, client: ClientInfo): Promise<NewSession> {
  const token = generateToken();
  const now = Date.now();
  const [row] = await db
    .insert(sessions)
    .values({
      customerId,
      tokenHash: hashToken(token),
      idleExpiresAt: new Date(now + SESSION_IDLE_MS),
      absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_MS),
      userAgent: client.userAgent?.slice(0, 512),
      ipAddress: client.ipAddress,
    })
    .returning({ id: sessions.id, expiresAt: sessions.absoluteExpiresAt });
  if (!row) throw new Error('Session was not created');
  return { id: row.id, token, expiresAt: row.expiresAt };
}

// ---- RECOGNISING A RETURNING SESSION ----
// Returns who the code belongs to, or null if it is unknown, ended, expired,
// or belongs to a closed account.
export async function authenticateSession(
  db: Database,
  token: string,
  authMethod: Actor['authMethod'],
): Promise<Actor | null> {
  // Our codes are 43 characters; anything wildly different is not one.
  if (token.length < 32 || token.length > 128) return null;

  const now = new Date();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      customerId: sessions.customerId,
      lastSeenAt: sessions.lastSeenAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
    })
    .from(sessions)
    .innerJoin(customers, eq(customers.id, sessions.customerId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.idleExpiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  // Still in use: push the idle deadline back (never past the absolute one).
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({
        lastSeenAt: now,
        idleExpiresAt: new Date(Math.min(now.getTime() + SESSION_IDLE_MS, row.absoluteExpiresAt.getTime())),
      })
      .where(eq(sessions.id, row.sessionId));
  }

  return { customerId: row.customerId, sessionId: row.sessionId, authMethod };
}

// ---- ENDING SESSIONS ----

// Ends one session. Only ends it if it belongs to `customerId`, and reports
// whether anything was actually ended.
export async function revokeSession(db: Database, customerId: string, sessionId: string): Promise<boolean> {
  const ended = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.customerId, customerId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return ended.length > 0;
}

// Ends every session a person has — optionally keeping one (the current device).
export async function revokeAllSessions(db: Database, customerId: string, exceptSessionId?: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.customerId, customerId),
        isNull(sessions.revokedAt),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
      ),
    );
}

// ---- "WHERE AM I SIGNED IN?" ----
export async function listActiveSessions(db: Database, customerId: string) {
  const now = new Date();
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.customerId, customerId),
        isNull(sessions.revokedAt),
        gt(sessions.idleExpiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt));
}
