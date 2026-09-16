// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables for the vehicles businesses list — the
// listing itself (make, model, price, deposit, where to collect it), its
// photos, the accident history the business declared, and the paperwork staff
// review (registration, insurance, roadworthiness). Customer reviews live in
// bookings.ts, because every review belongs to a real, completed booking.
//
// All money is stored in whole cents (2500 = $25.00) so sums never pick up
// rounding errors.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adminStaff } from './admin.js';
import { createdAt, moment, updatedAt } from './columns.js';
import {
  documentReviewStatus,
  fuelType,
  islandSide,
  listingStatus,
  transmission,
  vehicleClass,
  vehicleDocumentKind,
  vehicleType,
} from './enums.js';
import { providers } from './providers.js';

// ---- THE LISTING ----
// Matches the `Vehicle` shape (photos, accident history and booked days come
// from the tables below and from bookings).
export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The short staff-facing code, e.g. SXM-V-118.
    reference: text('reference').notNull(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    type: vehicleType('type').notNull().default('car'),
    make: text('make').notNull(),
    model: text('model').notNull(),
    year: integer('year').notNull(),
    trim: text('trim'),
    vehicleClass: vehicleClass('vehicle_class').notNull(),
    transmission: transmission('transmission').notNull(),
    fuel: fuelType('fuel').notNull(),
    seats: integer('seats').notNull(),
    doors: integer('doors').notNull(),
    airConditioning: boolean('air_conditioning').notNull().default(true),

    // Pricing
    dailyRateCents: integer('daily_rate_cents').notNull(),
    weeklyRateCents: integer('weekly_rate_cents'),
    minimumDays: integer('minimum_days').notNull().default(1),
    maximumDays: integer('maximum_days').notNull().default(30),

    // The security deposit this car asks for. Held separately; never revenue.
    depositAmountCents: integer('deposit_amount_cents').notNull(),
    depositIsVehicleSpecific: boolean('deposit_is_vehicle_specific').notNull().default(false),

    // Collection
    pickupTown: text('pickup_town').notNull(),
    side: islandSide('side').notNull(),
    deliveryAvailable: boolean('delivery_available').notNull().default(false),
    // UNUSED: delivery is free, so nothing reads or charges this. Kept so the
    // decision can be reversed without rebuilding the table.
    deliveryFeeCents: integer('delivery_fee_cents'),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),

    rating: doublePrecision('rating').notNull().default(0),
    reviewCount: integer('review_count').notNull().default(0),
    description: text('description').notNull().default(''),
    // New listings wait for staff review before customers can see them.
    listingStatus: listingStatus('listing_status').notNull().default('pending_review'),
    deletedAt: moment('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vehicles_reference_unique').on(t.reference),
    index('vehicles_provider_idx').on(t.providerId),
    check('vehicles_daily_rate_positive', sql`${t.dailyRateCents} > 0`),
    check('vehicles_deposit_not_negative', sql`${t.depositAmountCents} >= 0`),
    check('vehicles_day_limits', sql`${t.minimumDays} >= 1 and ${t.minimumDays} <= ${t.maximumDays}`),
    check('vehicles_seats_positive', sql`${t.seats} > 0`),
  ],
);

// ---- PHOTOS ----
// The files themselves live in encrypted object storage; this is the pointer.
export const vehiclePhotos = pgTable(
  'vehicle_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('vehicle_photos_vehicle_idx').on(t.vehicleId)],
);

// ---- DECLARED ACCIDENT HISTORY ----
// What the business told us. SXM Rentals does not independently verify it.
export const vehicleAccidentRecords = pgTable(
  'vehicle_accident_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    occurredOn: date('occurred_on').notNull(),
    description: text('description').notNull(),
    repaired: boolean('repaired').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('vehicle_accident_records_vehicle_idx').on(t.vehicleId)],
);

// ---- PAPERWORK STAFF REVIEW BY HAND ----
// A rejection must always carry a reason; the database refuses one without.
export const vehicleDocuments = pgTable(
  'vehicle_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    kind: vehicleDocumentKind('kind').notNull(),
    status: documentReviewStatus('status').notNull().default('pending'),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    uploadedAt: moment('uploaded_at').notNull().defaultNow(),
    expiresAt: date('expires_at'),
    reason: text('reason'),
    reviewedByStaffId: uuid('reviewed_by_staff_id').references(() => adminStaff.id, { onDelete: 'set null' }),
    reviewedAt: moment('reviewed_at'),
  },
  (t) => [
    index('vehicle_documents_vehicle_idx').on(t.vehicleId),
    check('vehicle_documents_rejection_reason', sql`${t.status} <> 'rejected' or ${t.reason} is not null`),
  ],
);
