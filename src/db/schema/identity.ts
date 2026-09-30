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
import { accountType, authTokenPurpose, phoneChallengePurpose, verificationStatus } from './enums.js';

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
    // When the owner proved the number is theirs, with a code sent to it. Only a
    // confirmed number signs in by text; changing the number clears this.
    phoneVerifiedAt: moment('phone_verified_at'),
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

    // Their record at Stripe, made the first time they save a card. Their
    // saved cards live there, never here. Removed at Stripe when the account
    // closes (the daily job does it), taking every saved card with it.
    stripeCustomerId: text('stripe_customer_id'),
    // The identity check in progress at Stripe, if one was started. Only its
    // id is kept; the photos stay with Stripe.
    identitySessionId: text('identity_session_id'),

    // Set when the account is closed. The row stays so the audit trail and
    // past bookings still point at something real.
    deletedAt: moment('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('customers_email_unique').on(t.email),
    uniqueIndex('customers_stripe_customer_unique').on(t.stripeCustomerId),
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
    // For a change of email only: the address it will become once confirmed.
    newEmail: text('new_email'),
    expiresAt: moment('expires_at').notNull(),
    usedAt: moment('used_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_tokens_token_hash_unique').on(t.tokenHash),
    index('auth_tokens_customer_purpose_idx').on(t.customerId, t.purpose),
  ],
);

// ---- A CODE SENT BY TEXT ----
// Only a hash of the code is kept. One row per code asked for — including for a
// number no account has, which is never actually texted — so the limits count
// every attempt the same way and trying numbers tells nobody anything.
export const phoneChallenges = pgTable(
  'phone_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    purpose: phoneChallengePurpose('purpose').notNull(),
    // Who it is for: the account with this confirmed number, or the signed-in
    // person confirming it. Empty when no account has the number.
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: moment('expires_at').notNull(),
    usedAt: moment('used_at'),
    cancelledAt: moment('cancelled_at'),
    ipAddress: text('ip_address'),
    createdAt: createdAt(),
  },
  (t) => [
    index('phone_challenges_phone_idx').on(t.phone, t.createdAt),
    index('phone_challenges_ip_idx').on(t.ipAddress, t.createdAt),
  ],
);
