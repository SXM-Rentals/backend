// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Managing staff accounts from the admin panel — adding
// somebody, giving somebody locked out a fresh start, switching off an account
// when somebody leaves, and switching it back on.
//
// THIS REVERSES A DELIBERATE DECISION, so the guards around it matter more than
// the features. Staff accounts used to be created only from the server, on the
// grounds that nobody should be able to grant themselves admin access through
// the panel. Doing it from the panel is safe only because:
//
//   - only a signed-in staff member can do any of it (middleware/auth.ts), and
//   - every one of these also needs the actor's own authenticator code, checked
//     fresh in the request (routes/admin/index.ts calls verifyStepUp), so a
//     session left open on an unlocked screen is not enough, and
//   - a new or reset account must set its own password before it can do
//     anything at all, so the person who created it cannot go on acting as
//     them, and
//   - nobody can disable or reset their own account, so the panel can never
//     lock out the last person able to put things right.
//
// `npm run admin:create` and `npm run admin:reset` stay as the way back in when
// the panel cannot help.
//
// Every change here writes one audit entry with the reason the staff member
// gave. A password, a code or a secret is never written into the audit log, a
// response or a log line.

import { and, asc, eq, isNull, isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adminStaff } from '../../db/schema/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { hashPassword, type BreachedPasswordChecker } from '../../lib/passwords.js';
import { isUuid } from '../../lib/ownership.js';
import type { AdminActor } from './auth.js';
import { recordAudit } from './audit.js';
import { assertMayActOn, assertMayGrant, assertNotSelf, TIER_LABELS, type AdminTier } from './tiers.js';

type StaffRow = typeof adminStaff.$inferSelect;

// What the panel is told about a staff account. Deliberately no password hash,
// no two-factor secret, and no failure counters.
export type StaffRecord = {
  id: string;
  name: string;
  email: string;
  avatarInitials: string;
  mfaEnrolled: boolean;
  mustChangePassword: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  disabledAt: string | null;
  // What this person is allowed to do. See services/admin/tiers.ts.
  tier: AdminTier;
};

export function toStaffRecord(staff: StaffRow): StaffRecord {
  return {
    id: staff.id,
    name: staff.name,
    email: staff.email,
    avatarInitials: staff.avatarInitials,
    // Whether they have an authenticator app working, not the secret itself.
    mfaEnrolled: staff.mfaEnrolledAt !== null,
    mustChangePassword: staff.mustChangePassword,
    lastSignInAt: staff.lastSignInAt?.toISOString() ?? null,
    createdAt: staff.createdAt.toISOString(),
    disabledAt: staff.disabledAt?.toISOString() ?? null,
    tier: staff.tier,
  };
}

// What the auth service lends this one: the same lockout counters and the same
// way of ending sessions, so there is one of each rather than two.
type AuthHelpers = {
  createStaff(input: {
    name: string;
    email: string;
    password: string;
    mustChangePassword?: boolean;
    tier?: AdminTier;
  }): Promise<StaffRow>;
  revokeStaffSessions(staffId: string, exceptSessionId?: string): Promise<void>;
  clearFailures(staffId: string): Promise<void>;
};

export type AdminStaffServiceDeps = {
  db: Database;
  auth: AuthHelpers;
  breachedPasswords?: BreachedPasswordChecker;
};

export function createAdminStaffService(deps: AdminStaffServiceDeps) {
  const { db, auth, breachedPasswords } = deps;

  async function loadStaff(id: string): Promise<StaffRow> {
    if (!isUuid(id)) throw notFound('We could not find that staff account.');
    const [staff] = await db.select().from(adminStaff).where(eq(adminStaff.id, id)).limit(1);
    if (!staff) throw notFound('We could not find that staff account.');
    return staff;
  }

  // Staff passwords get the same check customers' do: a password already in a
  // known breach is refused outright.
  async function assertPasswordAllowed(password: string) {
    if (breachedPasswords && (await breachedPasswords.isBreached(password))) {
      throw conflict(
        'password_breached',
        'This password has appeared in a known data breach, so it is not safe to use. Please choose a different one.',
      );
    }
  }

  return {
    // ---- WHO THE STAFF ARE ----
    // Defaults to active only, because that is what the dispute picker and the
    // rest of the panel mean by "staff".
    async list(status: 'active' | 'disabled' | 'all' = 'active'): Promise<StaffRecord[]> {
      const rows = await db
        .select()
        .from(adminStaff)
        .where(
          status === 'active'
            ? isNull(adminStaff.disabledAt)
            : status === 'disabled'
              ? isNotNull(adminStaff.disabledAt)
              : undefined,
        )
        .orderBy(asc(adminStaff.name));
      return rows.map(toStaffRecord);
    },

    // ---- ADDING SOMEBODY ----
    // They get a temporary password and no authenticator app: they set both up
    // themselves on their first sign-in.
    async create(
      actor: AdminActor,
      input: { name: string; email: string; password: string; tier: AdminTier; reason: string },
    ) {
      // You cannot create somebody at your own level or above — otherwise the
      // first thing anybody would do is make themselves a colleague who outranks
      // them and act through that account instead.
      assertMayGrant(actor, input.tier);
      await assertPasswordAllowed(input.password);

      const staff = await auth.createStaff({
        name: input.name,
        email: input.email,
        password: input.password,
        mustChangePassword: true,
        tier: input.tier,
      });

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'staff_created',
        subjectType: 'staff',
        subjectId: staff.id,
        subjectLabel: `Staff · ${staff.name}`,
        field: 'Staff account',
        before: 'Did not exist',
        after: `Created as ${TIER_LABELS[staff.tier]}`,
        reason: input.reason,
      });

      return toStaffRecord(staff);
    },

    // ---- A FRESH START FOR SOMEBODY LOCKED OUT ----
    // A forgotten password, or a lost phone. Not for your own account: use
    // "change password" for that, which proves you know the current one.
    async reset(
      actor: AdminActor,
      id: string,
      input: { password: string; resetAuthenticator?: boolean; reason: string },
    ) {
      const staff = await loadStaff(id);
      if (staff.id === actor.staffId) {
        throw conflict('cannot_reset_self', 'Use Change password for your own account.');
      }
      // Nobody resets somebody at their own level or above, and nobody but the
      // godfather resets the godfather — which is what keeps the business's
      // owner able to get back in.
      assertMayActOn(actor, staff);
      await assertPasswordAllowed(input.password);

      const [updated] = await db
        .update(adminStaff)
        .set({
          passwordHash: await hashPassword(input.password),
          // They must replace the temporary password before doing anything.
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
          // A lost phone also means starting the authenticator app again.
          ...(input.resetAuthenticator ? { mfaSecretEncrypted: null, mfaEnrolledAt: null } : {}),
        })
        .where(eq(adminStaff.id, staff.id))
        .returning();

      // Anything they were signed in to stops working now.
      await auth.revokeStaffSessions(staff.id);

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'staff_reset',
        subjectType: 'staff',
        subjectId: staff.id,
        subjectLabel: `Staff · ${staff.name}`,
        field: 'Sign-in',
        before: 'Working',
        after: `Temporary password issued${input.resetAuthenticator ? ', authenticator reset' : ''}`,
        reason: input.reason,
      });

      return toStaffRecord(updated!);
    },

    // ---- CHANGING WHAT SOMEBODY MAY DO ----
    // Promoting, demoting, or moving somebody to read-only. Three rules meet
    // here, and all three are in services/admin/tiers.ts: you cannot act on an
    // account at your own level or above, you cannot grant a level at or above
    // your own, and you cannot change your own — whoever you are. The last one
    // is the difference between a hierarchy and a ladder.
    async changeTier(actor: AdminActor, id: string, input: { tier: AdminTier; reason: string }) {
      const staff = await loadStaff(id);
      assertNotSelf(actor, staff.id, 'access level');
      assertMayActOn(actor, staff);
      assertMayGrant(actor, input.tier);

      if (staff.tier === input.tier) {
        throw conflict('already_that_tier', `${staff.name} is already ${TIER_LABELS[input.tier]}.`);
      }

      const [updated] = await db
        .update(adminStaff)
        .set({ tier: input.tier })
        .where(eq(adminStaff.id, staff.id))
        .returning();

      // Their sessions end. The new level applies from their very next request
      // either way — every request reads it fresh from this row — but the panel
      // they have open was drawn for the OLD level: an owner's staff screen,
      // buttons they can no longer use. Signing them out makes the change
      // unmistakable, and they come back to a panel drawn for what they may do now.
      await auth.revokeStaffSessions(staff.id);

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'staff_tier_changed',
        subjectType: 'staff',
        subjectId: staff.id,
        subjectLabel: `Staff · ${staff.name}`,
        field: 'Access level',
        // In words, so the log reads as a sentence next year.
        before: TIER_LABELS[staff.tier],
        after: TIER_LABELS[input.tier],
        reason: input.reason,
      });

      return toStaffRecord(updated!);
    },

    // ---- SOMEBODY HAS LEFT ----
    async disable(actor: AdminActor, id: string, input: { reason: string }) {
      const staff = await loadStaff(id);
      if (staff.id === actor.staffId) {
        throw conflict('cannot_disable_self', 'You cannot switch off your own account.');
      }
      assertMayActOn(actor, staff);
      if (staff.disabledAt) throw conflict('already_disabled', 'That account is already switched off.');

      const [updated] = await db
        .update(adminStaff)
        .set({ disabledAt: new Date() })
        .where(eq(adminStaff.id, staff.id))
        .returning();
      // Signed out everywhere immediately; sign-in already refuses them.
      await auth.revokeStaffSessions(staff.id);

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'staff_disabled',
        subjectType: 'staff',
        subjectId: staff.id,
        subjectLabel: `Staff · ${staff.name}`,
        field: 'Access',
        before: 'Active',
        after: 'Disabled',
        reason: input.reason,
      });

      return toStaffRecord(updated!);
    },

    // ---- THEY ARE BACK ----
    // Only lifts the block. If they also need a new password, that is a reset.
    async enable(actor: AdminActor, id: string, input: { reason: string }) {
      const staff = await loadStaff(id);
      assertMayActOn(actor, staff);
      if (!staff.disabledAt) throw conflict('not_disabled', 'That account is not switched off.');

      const [updated] = await db
        .update(adminStaff)
        .set({ disabledAt: null })
        .where(eq(adminStaff.id, staff.id))
        .returning();
      await auth.clearFailures(staff.id);

      await recordAudit(db, {
        staffId: actor.staffId,
        action: 'staff_enabled',
        subjectType: 'staff',
        subjectId: staff.id,
        subjectLabel: `Staff · ${staff.name}`,
        field: 'Access',
        before: 'Disabled',
        after: 'Active',
        reason: input.reason,
      });

      return toStaffRecord(updated!);
    },
  };
}

export type AdminStaffService = ReturnType<typeof createAdminStaffService>;
