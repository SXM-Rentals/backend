// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables for people and signing in — the customer
// record itself, their scrambled password, the sessions that keep them signed
// in on each device, and the single-use codes behind "verify your email" and
// "reset your password" links.
//
// The password, sessions and codes are kept in their own tables, apart from the
// customer record, so that no query that reads a customer's profile can
// accidentally carry a password hash along with it.

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, moment, updatedAt } from './columns.js';
import { accountType, authTokenPurpose, verificationStatus } from './enums.js';

// ---- CUSTOMERS ----
// One row per person with an SXM Rentals account. Matches the `User` shape the
// apps use. The email is always stored lower-case so "Ana@x.com" and
// "ana@x.com" are the same account.
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    accountType: accountType('account_type').notNull(),

    // Where they are in the identity check (filled in by the verification phase).
    verificationStatus: verificationStatus('verification_status').notNull().default('unstarted'),
    selfieDone: boolean('selfie_done').notNull().default(false),
    licenseDone: boolean('license_done').notNull().default(false),
    identityDocDone: boolean('identity_doc_done').notNull().default(false),
    verificationReason: text('verification_reason'),
    verificationSubmittedAt: moment('verification_submitted_at'),

    // A confirmed island resident. A status, not a tier that is earned.
    isIslander: boolean('is_islander').notNull().default(false),

    // Set when the account is closed. The row stays so the audit trail and
    // past bookings still point at something real.
    deletedAt: moment('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('customers_email_unique').on(t.email),
    check('customers_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

// ---- PASSWORDS ----
// The scrambled (Argon2id) password and the sign-in safety counters.
export const credentials = pgTable('credentials', {
  customerId: uuid('customer_id')
    .primaryKey()
    .references(() => customers.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: moment('email_verified_at'),
  // Wrong-password attempts in a row, and when the account may be tried again.
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: moment('locked_until'),
  passwordChangedAt: moment('password_changed_at').notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---- SESSIONS ----
// One row per signed-in device. Only the fingerprint of the session code is
// stored (see lib/crypto.ts). A session ends when it is revoked, when it has
// not been used for a while (idle), or when it is simply too old (absolute).
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    lastSeenAt: moment('last_seen_at').notNull().defaultNow(),
    idleExpiresAt: moment('idle_expires_at').notNull(),
    absoluteExpiresAt: moment('absolute_expires_at').notNull(),
    revokedAt: moment('revoked_at'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_hash_unique').on(t.tokenHash), index('sessions_customer_idx').on(t.customerId)],
);

// ---- SINGLE-USE LINK CODES ----
// Behind "verify your email" and "reset your password". Each code works once
// (used_at is set the moment it is used) and only until it expires.
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    purpose: authTokenPurpose('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: moment('expires_at').notNull(),
    usedAt: moment('used_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_tokens_token_hash_unique').on(t.tokenHash),
    index('auth_tokens_customer_purpose_idx').on(t.customerId, t.purpose),
  ],
);
