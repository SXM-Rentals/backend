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
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, moment, updatedAt } from './columns.js';
import { auditAction, auditSubjectType, kycProvider, payoutEntity } from './enums.js';

// ---- STAFF ACCOUNTS ----
// Kept completely apart from customers: a customer account can never become a
// staff account by changing a field, and the two sign-ins share nothing.
//
// Two-factor codes are mandatory. A staff account that has not yet set up an
// authenticator app can sign in only far enough to do so, and nothing else.
export const adminStaff = pgTable(
  'admin_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    avatarInitials: text('avatar_initials').notNull(),
    passwordHash: text('password_hash'),
    // The two-factor secret, encrypted by the application before it is stored —
    // never in plain text, so a copy of the database is not enough to make
    // valid codes. See lib/crypto.ts.
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    // Set the moment a first correct code proves the authenticator app works.
    mfaEnrolledAt: moment('mfa_enrolled_at'),
    // Wrong passwords or codes in a row, and when the account may be tried again.
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: moment('locked_until'),
    lastSignInAt: moment('last_sign_in_at'),
    disabledAt: moment('disabled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('admin_staff_email_unique').on(t.email)],
);

// ---- STAFF SIGN-IN SESSIONS ----
// A separate table from the customers' sessions, so a customer session can
// never be mistaken for a staff one. Staff sessions expire far sooner than
// customers': the admin panel is the highest-value target on the platform.
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => adminStaff.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    // True only once the two-factor code has been given. A session waiting for
    // that code can do nothing except finish signing in.
    mfaPassed: boolean('mfa_passed').notNull().default(false),
    lastSeenAt: moment('last_seen_at').notNull().defaultNow(),
    idleExpiresAt: moment('idle_expires_at').notNull(),
    absoluteExpiresAt: moment('absolute_expires_at').notNull(),
    revokedAt: moment('revoked_at'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('admin_sessions_token_hash_unique').on(t.tokenHash),
    index('admin_sessions_staff_idx').on(t.staffId),
  ],
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
