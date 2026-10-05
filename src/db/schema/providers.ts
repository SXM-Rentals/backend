// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables for rental businesses. The business is split
// across tables on purpose:
//   - `providers` holds ONLY what any customer may see on the public page.
//   - `provider_business_profiles` holds the private half (legal name, owner's
//     own phone, registration) that only the business itself and staff see.
//   - `provider_members` says which customer accounts may act for which
//     business. This is the wall between businesses: every provider-dashboard
//     request is checked against it, so one business can never read or change
//     another's fleet, bookings or payouts.
//   - `provider_payout_accounts` tracks their Stripe Connect payout setup.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, moment, updatedAt } from './columns.js';
import {
  fleetRequestStatus,
  payoutMethod,
  islandSide,
  operatingSide,
  payoutAccountStatus,
  providerMemberRole,
  registrationStatus,
  verificationStatus,
} from './enums.js';
import { customers } from './identity.js';

// ---- THE PUBLIC BUSINESS PAGE ----
// Matches the `Provider` shape. Nothing private belongs in this table.
export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessName: text('business_name').notNull(),
  side: islandSide('side').notNull(),
  town: text('town').notNull(),
  description: text('description').notNull().default(''),
  // The business line shown publicly — not the owner's personal mobile.
  phone: text('phone').notNull().default(''),
  // How quickly the business usually answers, as a code the apps translate:
  // within_hour, within_hours or within_day. Empty until somebody sets it.
  respondsIn: text('responds_in').notNull().default(''),
  deliversVehicles: boolean('delivers_vehicles').notNull().default(false),
  airportPickup: boolean('airport_pickup').notNull().default(false),
  // "SXM Verified" — only ever set by staff.
  isVerified: boolean('is_verified').notNull().default(false),
  verificationStatus: verificationStatus('verification_status').notNull().default('unstarted'),
  rating: doublePrecision('rating').notNull().default(0),
  reviewCount: integer('review_count').notNull().default(0),
  deletedAt: moment('deleted_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  // Only the codes the apps translate, or nothing yet.
  check('providers_responds_in_known', sql`${t.respondsIn} in ('', 'within_hour', 'within_hours', 'within_day')`),
]);

// ---- "SEND IT TO US": A BUSINESS ASKING STAFF TO SET ITS FLEET UP ----
// For records on paper, in a message thread, or in software nobody can export
// from. Staff answer it from the admin panel.
export const fleetRequests = pgTable(
  'fleet_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => customers.id, { onDelete: 'set null' }),
    fleetSize: text('fleet_size').notNull(),
    recordFormat: text('record_format').notNull(),
    // How the owner would like to be reached, in their own words. The
    // business's own contact detail, for staff only.
    contact: text('contact').notNull(),
    notes: text('notes'),
    status: fleetRequestStatus('status').notNull().default('waiting'),
    handledAt: moment('handled_at'),
    handledByStaffId: uuid('handled_by_staff_id'),
    createdAt: createdAt(),
  },
  (t) => [index('fleet_requests_status_idx').on(t.status, t.createdAt)],
);

// The files sent with a request — possibly registration and insurance papers.
// KEPT IN THE DATABASE, NOT AT ANY WEB ADDRESS: only staff can open them, one
// at a time, through the admin panel. Small by rule (700 KB each, 5 a request).
const bytes = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
export const fleetRequestFiles = pgTable(
  'fleet_request_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => fleetRequests.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: bytes('content').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('fleet_request_files_request_idx').on(t.requestId)],
);

// ---- A BUSINESS'S OWN RENTAL SOFTWARE, CONNECTED ----
// Only a hash of the API key is kept, like a password; the key itself is shown
// once and never again. lastError set means its system stopped answering.
export const providerIntegrations = pgTable(
  'provider_integrations',
  {
    providerId: uuid('provider_id')
      .primaryKey()
      .references(() => providers.id, { onDelete: 'cascade' }),
    apiKeyHash: text('api_key_hash'),
    apiKeyLast4: text('api_key_last4'),
    webhookUrl: text('webhook_url'),
    lastSyncedAt: moment('last_synced_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('provider_integrations_key_unique').on(t.apiKeyHash)],
);

// ---- THE PRIVATE HALF ----
export const providerBusinessProfiles = pgTable('provider_business_profiles', {
  providerId: uuid('provider_id')
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
  legalName: text('legal_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  website: text('website'),
  registrationStatus: registrationStatus('registration_status').notNull().default('pending'),
  registeredIn: text('registered_in'),
  registrationNumber: text('registration_number'),
  // Staff's reason for turning the business down, which the business is shown
  // so it knows what to fix. Cleared when it is approved.
  verificationReason: text('verification_reason'),
  fleetSizeBand: text('fleet_size_band').notNull().default(''),
  locations: text('locations')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  operatingSide: operatingSide('operating_side').notNull(),
  // The person staff ring about a disputed deposit, and their own mobile.
  // A personal number: think twice before exporting or sharing it.
  ownerName: text('owner_name').notNull(),
  ownerPhone: text('owner_phone').notNull(),
  // Whether the business has connected its own booking software.
  apiConnected: boolean('api_connected').notNull().default(false),
  apiLastSyncedAt: moment('api_last_synced_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---- WHO MAY ACT FOR A BUSINESS ----
export const providerMembers = pgTable(
  'provider_members',
  {
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    role: providerMemberRole('role').notNull().default('staff'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.customerId] }),
    index('provider_members_customer_idx').on(t.customerId),
  ],
);

// ---- PAYOUT SETUP ----
// Stripe will not send money anywhere until status is "active".
export const providerPayoutAccounts = pgTable(
  'provider_payout_accounts',
  {
    providerId: uuid('provider_id')
      .primaryKey()
      .references(() => providers.id, { onDelete: 'cascade' }),
    stripeAccountId: text('stripe_account_id'),
    status: payoutAccountStatus('status').notNull().default('not_started'),
    // What Stripe is still waiting for, in plain words.
    outstanding: text('outstanding')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
    // Where the business's bank account is: US, FR (the French side counts as
    // France for Stripe) or SX (the Dutch side, paid by bank transfer).
    country: text('country').notNull().default('SX'),
    method: payoutMethod('method').notNull().default('stripe'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('provider_payout_accounts_stripe_unique').on(t.stripeAccountId)],
);
