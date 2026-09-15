// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The checks that stop one person from reaching another
// person's data by changing an ID in a web address. Every service that loads a
// booking, a message thread, a payout or a session by its ID passes it through
// here first.
//
// The important detail: a record that belongs to somebody else gets exactly
// the same "not found" answer as a record that does not exist at all. If it
// said "not allowed" instead, anyone could learn which IDs are real simply by
// guessing and watching which answer comes back.

import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { providerMembers } from '../db/schema/index.js';
import { notFound } from './errors.js';

// ---- WHO IS MAKING THE REQUEST ----
// Worked out from the session by middleware/auth.ts.
export type Actor = {
  customerId: string;
  sessionId: string;
  // How they proved it: a browser cookie (website) or a bearer code (phone app).
  authMethod: 'cookie' | 'bearer';
};

// True when `value` is shaped like a database ID. Checked before querying so a
// garbage ID is simply "not found" rather than a database error.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// ---- "IS THIS YOURS?" ----
// Hands back the record only when it belongs to the actor. Missing and
// someone-else's look identical from the outside.
export function assertOwnedBy<T>(record: T | null | undefined, ownerIdOf: (record: T) => string, actor: Actor): T {
  if (record === null || record === undefined || ownerIdOf(record) !== actor.customerId) {
    throw notFound();
  }
  return record;
}

// ---- "DO YOU WORK FOR THIS BUSINESS?" ----
// The wall between rental businesses. Returns the actor's role at the business,
// or answers "not found" when they are not a member of it.
export async function assertProviderMember(
  db: Database,
  providerId: string,
  actor: Actor,
): Promise<{ role: 'owner' | 'staff' }> {
  if (!isUuid(providerId)) throw notFound();
  const [membership] = await db
    .select({ role: providerMembers.role })
    .from(providerMembers)
    .where(and(eq(providerMembers.providerId, providerId), eq(providerMembers.customerId, actor.customerId)))
    .limit(1);
  if (!membership) throw notFound();
  return membership;
}
