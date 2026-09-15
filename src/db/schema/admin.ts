// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables that belong to SXM Rentals staff — the staff
// accounts themselves, the audit log recording every change a staff member
// makes, and the single row of platform-wide settings (commission rate,
// identity-check provider, feature switches).
//
// Staff accounts are a completely separate table from customers on purpose:
// the admin panel is its own sign-in, and a customer account can never be
// turned into a staff account by changing a field.

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, moment, updatedAt } from './columns.js';
import { auditAction, auditSubjectType, kycProvider, payoutEntity } from './enums.js';

// ---- STAFF ACCOUNTS ----
// Sign-in for staff (with mandatory two-factor codes) is built in Phase 2.
// Until then these columns exist but nothing can sign in with them.
export const adminStaff = pgTable(
  'admin_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    avatarInitials: text('avatar_initials').notNull(),
    passwordHash: text('password_hash'),
    // The two-factor secret, stored encrypted by the application — never plain.
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    disabledAt: moment('disabled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('admin_staff_email_unique').on(t.email)],
);

// ---- THE AUDIT LOG ----
// Every change a staff member makes: who, what, the value before and after in
// plain words, and the reason they gave. A change without a written reason is
// refused by the database itself. Rows are only ever added, never edited.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: moment('at').notNull().defaultNow(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => adminStaff.id, { onDelete: 'restrict' }),
    action: auditAction('action').notNull(),
    subjectType: auditSubjectType('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectLabel: text('subject_label').notNull(),
    field: text('field').notNull(),
    before: text('before').notNull(),
    after: text('after').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [
    check('audit_log_reason_required', sql`length(trim(${t.reason})) > 0`),
    index('audit_log_at_idx').on(t.at),
    index('audit_log_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

// ---- PLATFORM SETTINGS ----
// Exactly one row (id is always 1). The commission rate is stored in basis
// points: 3000 means 30%.
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: smallint('id').primaryKey().default(1),
    commissionRateBps: integer('commission_rate_bps').notNull().default(3000),
    kycProvider: kycProvider('kyc_provider').notNull().default('stripe_identity'),
    kycCostPerCheckCents: integer('kyc_cost_per_check_cents').notNull().default(0),
    kycBundledDocuments: boolean('kyc_bundled_documents').notNull().default(false),
    payoutEntity: payoutEntity('payout_entity').notNull().default('us_llc'),
    featureFlags: jsonb('feature_flags').notNull().default(sql`'[]'::jsonb`),
    rewardsConfig: jsonb('rewards_config').notNull().default(sql`'{}'::jsonb`),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('platform_settings_single_row', sql`${t.id} = 1`),
    check('platform_settings_commission_range', sql`${t.commissionRateBps} between 0 and 10000`),
  ],
);
