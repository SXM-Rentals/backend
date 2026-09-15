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
});

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
    country: text('country').notNull().default('SX'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('provider_payout_accounts_stripe_unique').on(t.stripeAccountId)],
);
