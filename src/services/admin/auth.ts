// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Signing staff in to the admin panel. This is the
// highest-value door on the platform — it opens onto every customer's details,
// every booking and every movement of money — so it is deliberately stricter
// than the customer sign-in:
//
//   - It is a completely separate realm. Staff live in their own table with
//     their own sessions, so a customer account can never become a staff one
//     and a customer's session can never be mistaken for a staff session.
//   - A code from an authenticator app is MANDATORY, not optional. A password
//     alone gets a session that can do exactly one thing: finish signing in.
//   - The two-factor secret is encrypted before it is stored, so a copy of the
//     database is not enough to generate valid codes.
//   - Sessions are short: half an hour idle, eight hours at the very most,
//     against the customer app's seven and thirty days.
//   - Wrong passwords or wrong codes both count towards the same lockout.

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { adminSessions, adminStaff } from '../../db/schema/index.js';
import { decryptSecret, encryptSecret, generateToken, hashToken } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, tooManyRequests, unauthorized } from '../../lib/errors.js';
import { getDummyPasswordHash, hashPassword, verifyPassword } from '../../lib/passwords.js';

// ---- HOW LONG A STAFF SESSION LASTS ----
const ADMIN_IDLE_MS = 30 * 60 * 1000; // half an hour without use
const ADMIN_ABSOLUTE_MS = 8 * 60 * 60 * 1000; // one working day
const TOUCH_INTERVAL_MS = 60 * 1000;
const LOCK_AFTER_FAILURES = 5;
const MAX_LOCK_MINUTES = 60;

// What the app shows in an authenticator app.
const MFA_ISSUER = 'SXM Rentals Admin';
// How far out a phone's clock may be and still be accepted, in seconds. Codes
// change every 30 seconds, so this allows the step either side of now — enough
// for a slightly wrong clock, without widening the window for guessing.
const MFA_CLOCK_TOLERANCE_SECONDS = 30;

// Who is making an admin request.
export type AdminActor = {
  staffId: string;
  sessionId: string;
  name: string;
  email: string;
};

type Logger = { warn: (obj: object, msg: string) => void };

export type AdminAuthDeps = { db: Database; config: Config; logger: Logger };

// The same answer for a wrong password, a wrong code and an unknown email.
const invalidCredentials = () =>
  new AppError(401, 'invalid_credentials', 'Those sign-in details are not correct.');

export function createAdminAuthService(deps: AdminAuthDeps) {
  const { db, config, logger } = deps;

  // Counts a failed attempt — password or code, they are the same thing here —
  // and locks the account for longer each time once past the threshold.
  async function recordFailure(staffId: string) {
    const [updated] = await db
      .update(adminStaff)
      .set({ failedLoginCount: sql`${adminStaff.failedLoginCount} + 1` })
      .where(eq(adminStaff.id, staffId))
      .returning({ failedLoginCount: adminStaff.failedLoginCount });
    const failures = updated?.failedLoginCount ?? 0;
    if (failures >= LOCK_AFTER_FAILURES) {
      const minutes = Math.min(MAX_LOCK_MINUTES, 2 ** (failures - LOCK_AFTER_FAILURES));
      await db
        .update(adminStaff)
        .set({ lockedUntil: new Date(Date.now() + minutes * 60_000) })
        .where(eq(adminStaff.id, staffId));
      logger.warn({ staffId, failures }, 'Staff account temporarily locked');
    }
  }

  async function clearFailures(staffId: string) {
    await db
      .update(adminStaff)
      .set({ failedLoginCount: 0, lockedUntil: null, lastSignInAt: new Date() })
      .where(eq(adminStaff.id, staffId));
  }

  // The session row behind a sign-in code, whether or not two-factor is done.
  async function loadSession(token: string) {
    if (token.length < 32 || token.length > 128) return undefined;
    const now = new Date();
    const [row] = await db
      .select({ session: adminSessions, staff: adminStaff })
      .from(adminSessions)
      .innerJoin(adminStaff, eq(adminStaff.id, adminSessions.staffId))
      .where(
        and(
          eq(adminSessions.tokenHash, hashToken(token)),
          isNull(adminSessions.revokedAt),
          gt(adminSessions.idleExpiresAt, now),
          gt(adminSessions.absoluteExpiresAt, now),
          isNull(adminStaff.disabledAt),
        ),
      )
      .limit(1);
    return row;
  }

  return {
    // ---- CREATING A STAFF ACCOUNT ----
    // Used by the command that sets up the first one. There is deliberately no
    // web address for this: a new staff account is made deliberately, from the
    // server, not through the panel.
    async createStaff(input: { name: string; email: string; password: string }) {
      const email = input.email.trim().toLowerCase();
      const [existing] = await db.select().from(adminStaff).where(eq(adminStaff.email, email)).limit(1);
      if (existing) throw conflict('staff_exists', 'A staff account with that email already exists.');

      const initials = input.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');

      const [staff] = await db
        .insert(adminStaff)
        .values({
          name: input.name.trim(),
          email,
          avatarInitials: initials || '??',
          passwordHash: await hashPassword(input.password),
        })
        .returning({ id: adminStaff.id, name: adminStaff.name, email: adminStaff.email });
      return staff!;
    },

    // ---- STEP ONE: THE PASSWORD ----
    // A correct password alone is NOT being signed in. It gives a session that
    // can do nothing but set up or give a two-factor code.
    async signIn(
      input: { email: string; password: string },
      client: { ipAddress?: string | undefined; userAgent?: string | undefined },
    ) {
      const email = input.email.trim().toLowerCase();
      const [staff] = await db
        .select()
        .from(adminStaff)
        .where(and(eq(adminStaff.email, email), isNull(adminStaff.disabledAt)))
        .limit(1);

      // Unknown email: still do the slow check, so the timing gives nothing away.
      if (!staff?.passwordHash) {
        await verifyPassword(await getDummyPasswordHash(), input.password);
        throw invalidCredentials();
      }

      if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
        const seconds = Math.ceil((staff.lockedUntil.getTime() - Date.now()) / 1000);
        throw tooManyRequests(seconds, 'Too many attempts. Please wait before trying again.');
      }

      if (!(await verifyPassword(staff.passwordHash, input.password))) {
        await recordFailure(staff.id);
        throw invalidCredentials();
      }

      const token = generateToken();
      const now = Date.now();
      const [session] = await db
        .insert(adminSessions)
        .values({
          staffId: staff.id,
          tokenHash: hashToken(token),
          // Not signed in yet: the code still has to be given.
          mfaPassed: false,
          idleExpiresAt: new Date(now + ADMIN_IDLE_MS),
          absoluteExpiresAt: new Date(now + ADMIN_ABSOLUTE_MS),
          ipAddress: client.ipAddress,
          userAgent: client.userAgent?.slice(0, 512),
        })
        .returning({ expiresAt: adminSessions.absoluteExpiresAt });

      return {
        token,
        expiresAt: session!.expiresAt,
        // Either they have never set up an authenticator app, or they have.
        next: staff.mfaEnrolledAt ? ('code' as const) : ('enroll' as const),
      };
    },

    // ---- SETTING UP THE AUTHENTICATOR APP ----
    // Hands back a secret to scan, once. It is stored encrypted straight away,
    // but the account does not count as set up until a first correct code
    // proves the app actually works.
    async startMfaEnrollment(token: string) {
      const row = await loadSession(token);
      if (!row) throw unauthorized();
      if (row.staff.mfaEnrolledAt) {
        throw conflict('mfa_already_set_up', 'This account already has an authenticator app set up.');
      }

      const secret = generateSecret();
      await db
        .update(adminStaff)
        .set({ mfaSecretEncrypted: encryptSecret(secret, config.encryptionKey) })
        .where(eq(adminStaff.id, row.staff.id));

      return {
        secret,
        // What a phone's authenticator app scans.
        otpauthUrl: generateURI({ issuer: MFA_ISSUER, label: row.staff.email, secret }),
      };
    },

    // ---- STEP TWO: THE CODE ----
    // Finishes signing in. The same call confirms a brand-new authenticator app.
    async confirmMfa(token: string, code: string) {
      const row = await loadSession(token);
      if (!row) throw unauthorized();
      if (!row.staff.mfaSecretEncrypted) {
        throw badRequest('mfa_not_set_up', 'This account has no authenticator app set up yet.');
      }
      if (row.staff.lockedUntil && row.staff.lockedUntil.getTime() > Date.now()) {
        const seconds = Math.ceil((row.staff.lockedUntil.getTime() - Date.now()) / 1000);
        throw tooManyRequests(seconds, 'Too many attempts. Please wait before trying again.');
      }

      const secret = decryptSecret(row.staff.mfaSecretEncrypted, config.encryptionKey);
      const result = await verifyOtp({
        secret,
        token: code.replace(/\s+/g, ''),
        epochTolerance: MFA_CLOCK_TOLERANCE_SECONDS,
      });
      if (!result.valid) {
        await recordFailure(row.staff.id);
        throw invalidCredentials();
      }

      await db
        .update(adminSessions)
        .set({ mfaPassed: true })
        .where(eq(adminSessions.id, row.session.id));
      // A first correct code is what proves the app works.
      if (!row.staff.mfaEnrolledAt) {
        await db.update(adminStaff).set({ mfaEnrolledAt: new Date() }).where(eq(adminStaff.id, row.staff.id));
      }
      await clearFailures(row.staff.id);

      return {
        staff: { id: row.staff.id, name: row.staff.name, email: row.staff.email, avatarInitials: row.staff.avatarInitials },
        expiresAt: row.session.absoluteExpiresAt,
      };
    },

    // ---- RECOGNISING A SIGNED-IN STAFF MEMBER ----
    // Only a session that has passed two-factor counts. One that is still
    // waiting for a code is treated as not signed in at all.
    async authenticate(token: string): Promise<AdminActor | null> {
      const row = await loadSession(token);
      if (!row || !row.session.mfaPassed) return null;

      const now = new Date();
      if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await db
          .update(adminSessions)
          .set({
            lastSeenAt: now,
            idleExpiresAt: new Date(
              Math.min(now.getTime() + ADMIN_IDLE_MS, row.session.absoluteExpiresAt.getTime()),
            ),
          })
          .where(eq(adminSessions.id, row.session.id));
      }

      return {
        staffId: row.staff.id,
        sessionId: row.session.id,
        name: row.staff.name,
        email: row.staff.email,
      };
    },

    // ---- SIGNING OUT ----
    async signOut(token: string) {
      await db
        .update(adminSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(adminSessions.tokenHash, hashToken(token)), isNull(adminSessions.revokedAt)));
    },
  };
}

export type AdminAuthService = ReturnType<typeof createAdminAuthService>;
