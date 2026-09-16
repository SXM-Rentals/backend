// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Writes down every change a member of staff makes: who
// did it, what they acted on, which field changed, what it was before, what it
// is now, when, and the reason they gave.
//
// THE REASON IS NOT OPTIONAL. Every change goes through this one function, and
// it refuses a blank reason — as does the database itself. That is what makes
// "every staff change is recorded" a fact about the code rather than a hope
// about the people using it.
//
// WHY "BEFORE" AND "AFTER" ARE PLAIN WORDS: the log has to be readable a year
// later by somebody who was not there, possibly an accountant who does not know
// the database. "Explorer" becoming "VIP" tells that story; { tier: 2 } does not.
//
// Nothing here ever updates or deletes a row. The log is only ever added to.

import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adminStaff, auditLog } from '../../db/schema/index.js';
import { badRequest } from '../../lib/errors.js';

export type AuditAction =
  | 'account_updated'
  | 'account_deleted'
  | 'points_adjusted'
  | 'verification_approved'
  | 'verification_rejected'
  | 'refund_approved'
  | 'refund_denied'
  | 'deposit_claimed'
  | 'deposit_released'
  | 'promotion_changed'
  | 'settings_changed'
  | 'dispute_assigned'
  | 'dispute_resolved';

export type AuditSubjectType = 'customer' | 'provider' | 'vehicle' | 'booking' | 'payment' | 'platform';

export type AuditEntryInput = {
  staffId: string;
  action: AuditAction;
  subjectType: AuditSubjectType;
  subjectId: string;
  // What was acted on, in words: "Customer · Aria Duncan".
  subjectLabel: string;
  // What changed, in words: "Rewards points", "Insurance document".
  field: string;
  before: string;
  after: string;
  reason: string;
};

export async function recordAudit(db: Database, entry: AuditEntryInput): Promise<void> {
  const reason = entry.reason.trim();
  if (reason.length < 3) {
    throw badRequest('reason_required', 'Please give a reason for this change. It is written into the audit log.');
  }

  await db.insert(auditLog).values({
    staffId: entry.staffId,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    subjectLabel: entry.subjectLabel,
    field: entry.field,
    before: entry.before,
    after: entry.after,
    reason,
  });
}

// ---- READING THE LOG ----
// Newest first, with the name of whoever made each change.
export async function listAudit(db: Database, options: { limit?: number; subjectId?: string } = {}) {
  const rows = await db
    .select({ entry: auditLog, staffName: adminStaff.name })
    .from(auditLog)
    .innerJoin(adminStaff, eq(adminStaff.id, auditLog.staffId))
    .where(options.subjectId ? eq(auditLog.subjectId, options.subjectId) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(Math.min(options.limit ?? 100, 500));

  return rows.map((row) => ({
    id: row.entry.id,
    at: row.entry.at.toISOString(),
    staffId: row.entry.staffId,
    staffName: row.staffName,
    action: row.entry.action,
    subjectType: row.entry.subjectType,
    subjectId: row.entry.subjectId,
    subjectLabel: row.entry.subjectLabel,
    field: row.entry.field,
    before: row.entry.before,
    after: row.entry.after,
    reason: row.entry.reason,
  }));
}
