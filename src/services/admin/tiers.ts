// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Says what each kind of staff account is allowed to do, and
// holds the handful of rules that stop a tier system becoming a ladder anybody
// can climb.
//
// Until now there was one flat level: every staff account could do everything,
// and the trade behind that was accountability rather than restriction —
// everybody can do anything, and everything anybody does is on the record with a
// reason. TIERS ADD RESTRICTION ON TOP OF THAT RECORD; they do not replace it.
// The audit log is unchanged for every tier.
//
// ---- THE FOUR RULES THAT MATTER ----
//
// Without these, tiers are decoration:
//
//   1. Nobody may act on an account at their own level or above. An
//      administrator cannot reset an owner; an owner cannot disable the
//      godfather, or another owner.
//   2. Nobody may grant a level at or above their own. An owner cannot make
//      somebody an owner, and nothing in the panel can grant godfather at all —
//      that moves by a command on the server, deliberately and rarely.
//   3. Nobody may change their own level, not even the godfather. It is the one
//      change that has to come from somebody else.
//   4. The godfather cannot be disabled or reset by anybody else, so the panel
//      can never lock out the person whose business this is.
//
// Rule 1 and rule 2 are the same idea twice: you cannot reach sideways, and you
// cannot reach up.

import { AppError } from '../../lib/errors.js';

export type AdminTier = 'godfather' | 'owner' | 'administrator' | 'viewer';

// Highest first. Position in this list IS the hierarchy — a lower index means
// more authority — so the order is not cosmetic.
export const TIERS: AdminTier[] = ['godfather', 'owner', 'administrator', 'viewer'];

// What each one is called on screen and in the audit log, so a log entry reads
// as a sentence rather than as a column value.
export const TIER_LABELS: Record<AdminTier, string> = {
  godfather: 'Godfather',
  owner: 'Owner',
  administrator: 'Administrator',
  viewer: 'Viewer',
};

// Lower number, more authority.
export function rank(tier: AdminTier): number {
  return TIERS.indexOf(tier);
}

export function outranks(actor: AdminTier, other: AdminTier): boolean {
  return rank(actor) < rank(other);
}

export function atLeast(actor: AdminTier, needed: AdminTier): boolean {
  return rank(actor) <= rank(needed);
}

const notAllowed = (message: string) => new AppError(403, 'not_allowed', message);

// ---- THE GATE ON A ROUTE ----
// "You have to be at least this senior to do this at all." Declared beside the
// route rather than buried in a service, so the whole list can be read at once.
//
// What needs `owner` today: everything under /admin/staff except reading the
// list. WHEN PLATFORM SETTINGS GET AN ADDRESS — the commission rate, promo codes,
// whatever the platform_settings table grows into — they need `owner` too. There
// is no such address yet, which is the only reason this file does not mention one.
// Everything else that changes something needs `administrator`, which every tier
// above it also satisfies; a viewer is refused every change by method, in
// routes/admin/index.ts, rather than route by route.
export function requireTier(actor: { tier: AdminTier }, needed: AdminTier): void {
  if (atLeast(actor.tier, needed)) return;
  throw notAllowed(
    `This needs ${TIER_LABELS[needed]} access or higher. Your account is ${TIER_LABELS[actor.tier]} — ask somebody with ${TIER_LABELS[needed]} access.`,
  );
}

// ---- THE GATE ON A PERSON ----
// Acting on somebody else's account: resetting them, disabling them, changing
// what they are allowed to do.
export function assertMayActOn(
  actor: { staffId: string; tier: AdminTier },
  subject: { id: string; tier: AdminTier; name: string },
): void {
  // The godfather is nobody else's to touch. Said first, and in its own words,
  // because it is the rule that keeps the business's owner able to get back in.
  if (subject.tier === 'godfather' && subject.id !== actor.staffId) {
    throw notAllowed('The Godfather account cannot be changed by anybody else.');
  }
  if (subject.id === actor.staffId) return;
  if (!outranks(actor.tier, subject.tier)) {
    throw notAllowed(
      `${subject.name} is ${TIER_LABELS[subject.tier]}, the same as you or above. Only somebody more senior can change this account.`,
    );
  }
}

// ---- THE GATE ON A TIER ----
// Granting one, whether when creating an account or changing an existing one.
export function assertMayGrant(actor: { staffId: string; tier: AdminTier }, tier: AdminTier): void {
  if (tier === 'godfather') {
    // Not "you are not senior enough": nobody is, through the API. There is
    // exactly one godfather and it moves by a command on the server.
    throw notAllowed('Godfather cannot be granted from the admin panel.');
  }
  if (!outranks(actor.tier, tier)) {
    throw notAllowed(
      `You cannot make somebody ${TIER_LABELS[tier]} — that is your own level or above. Ask somebody more senior.`,
    );
  }
}

// Changing your own level is the one change that always comes from somebody
// else, whoever you are: otherwise the top of the ladder is whoever thought of
// it first.
export function assertNotSelf(actor: { staffId: string }, subjectId: string, what: string): void {
  if (actor.staffId === subjectId) {
    throw new AppError(409, 'cannot_change_own_tier', `You cannot change your own ${what}. Ask somebody else to.`);
  }
}
