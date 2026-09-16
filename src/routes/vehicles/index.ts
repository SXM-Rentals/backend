// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for browsing cars, under
// /api/v1/vehicles. These are public — somebody searching for a car has not
// signed in yet, and the whole point of the website is that a search result can
// appear in Google.
//
//   GET /vehicles              search and filter, matching the Search screen
//   GET /vehicles/:id          one car's page
//   GET /vehicles/:id/reviews  its reviews
//
// Only cars a member of staff has approved ("live") are ever returned. The list
// is capped and paged so nobody can pull the whole fleet down in one request.

import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { customers, reviews, vehicleAccidentRecords, vehiclePhotos, vehicles } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import { parseInput } from '../../lib/validate.js';
import { unavailableDatesFor } from '../../services/availability-engine/index.js';
import { toReview, toVehicle } from '../../services/serializers/vehicles.js';

export type VehicleRouteOptions = { db: Database };

// The most cars one request can return.
const MAX_PAGE_SIZE = 100;

// Everything the Search screen can narrow the list down by. Written to match
// the `VehicleFilters` type in the apps' api-client.
const searchQuery = z.object({
  search: z.string().trim().max(120).optional(),
  classes: z
    .string()
    .optional()
    .transform((value) => value?.split(',').map((item) => item.trim()).filter(Boolean))
    .pipe(z.array(z.enum(['economy', 'compact', 'suv', 'van', 'fourByFour', 'luxury'])).optional()),
  minPrice: z.coerce.number().min(0).max(100_000).optional(),
  maxPrice: z.coerce.number().min(0).max(100_000).optional(),
  seats: z.coerce.number().int().min(1).max(20).optional(),
  transmission: z.enum(['automatic', 'manual']).optional(),
  fuel: z.enum(['petrol', 'diesel', 'hybrid', 'electric']).optional(),
  deliveryOnly: z.enum(['true', 'false']).optional(),
  side: z.enum(['dutch', 'french']).optional(),
  sort: z.enum(['recommended', 'price_low', 'price_high', 'rating']).default('recommended'),
  // Only show cars actually free for these dates.
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const idParam = z.object({ id: z.string().max(64) });

export default async function vehicleRoutes(app: FastifyInstance, options: VehicleRouteOptions) {
  const { db } = options;

  // ---- SEARCH ----
  app.get('/', async (request) => {
    const filters = parseInput(searchQuery, request.query);

    const conditions = [eq(vehicles.listingStatus, 'live'), isNull(vehicles.deletedAt)];
    if (filters.search) {
      // Matches the way the apps search: make, model or town.
      const term = `%${filters.search}%`;
      conditions.push(
        or(ilike(vehicles.make, term), ilike(vehicles.model, term), ilike(vehicles.pickupTown, term))!,
      );
    }
    if (filters.classes?.length) conditions.push(inArray(vehicles.vehicleClass, filters.classes));
    if (filters.minPrice !== undefined) conditions.push(gte(vehicles.dailyRateCents, Math.round(filters.minPrice * 100)));
    if (filters.maxPrice !== undefined) conditions.push(lte(vehicles.dailyRateCents, Math.round(filters.maxPrice * 100)));
    if (filters.seats !== undefined) conditions.push(gte(vehicles.seats, filters.seats));
    if (filters.transmission) conditions.push(eq(vehicles.transmission, filters.transmission));
    if (filters.fuel) conditions.push(eq(vehicles.fuel, filters.fuel));
    if (filters.deliveryOnly === 'true') conditions.push(eq(vehicles.deliveryAvailable, true));
    if (filters.side) conditions.push(eq(vehicles.side, filters.side));

    // Free for the dates asked about: no booking of this car overlaps them.
    if (filters.startDate && filters.endDate && filters.endDate > filters.startDate) {
      conditions.push(
        sql`not exists (
          select 1 from bookings
          where bookings.vehicle_id = ${vehicles.id}
            and bookings.status <> 'cancelled'
            and bookings.start_date < ${filters.endDate}
            and bookings.end_date > ${filters.startDate}
        )`,
      );
    }

    const order = {
      price_low: asc(vehicles.dailyRateCents),
      price_high: desc(vehicles.dailyRateCents),
      // "Recommended" is best-rated first, the same stand-in the apps use.
      rating: desc(vehicles.rating),
      recommended: desc(vehicles.rating),
    }[filters.sort];

    const rows = await db
      .select()
      .from(vehicles)
      .where(and(...conditions))
      .orderBy(order, asc(vehicles.id))
      .limit(filters.limit)
      .offset(filters.offset);

    if (rows.length === 0) return [];

    // The photos, declared damage and booked days for this page of cars, each
    // in one query rather than one per car.
    const ids = rows.map((row) => row.id);
    const [photos, accidents, taken] = await Promise.all([
      db.select().from(vehiclePhotos).where(inArray(vehiclePhotos.vehicleId, ids)),
      db.select().from(vehicleAccidentRecords).where(inArray(vehicleAccidentRecords.vehicleId, ids)),
      unavailableDatesFor(db, ids),
    ]);

    return rows.map((row) =>
      toVehicle(
        row,
        photos.filter((photo) => photo.vehicleId === row.id),
        accidents.filter((accident) => accident.vehicleId === row.id),
        taken.get(row.id) ?? [],
      ),
    );
  });

  // ---- ONE CAR ----
  app.get('/:id', async (request) => {
    const { id } = parseInput(idParam, request.params);
    if (!isUuid(id)) throw notFound('We could not find that vehicle.');

    const [vehicle] = await db
      .select()
      .from(vehicles)
      .where(and(eq(vehicles.id, id), eq(vehicles.listingStatus, 'live'), isNull(vehicles.deletedAt)))
      .limit(1);
    if (!vehicle) throw notFound('We could not find that vehicle.');

    const [photos, accidents, taken] = await Promise.all([
      db.select().from(vehiclePhotos).where(eq(vehiclePhotos.vehicleId, id)),
      db.select().from(vehicleAccidentRecords).where(eq(vehicleAccidentRecords.vehicleId, id)),
      unavailableDatesFor(db, [id]),
    ]);

    return toVehicle(vehicle, photos, accidents, taken.get(id) ?? []);
  });

  // ---- ITS REVIEWS ----
  app.get('/:id/reviews', async (request) => {
    const { id } = parseInput(idParam, request.params);
    if (!isUuid(id)) throw notFound('We could not find that vehicle.');

    const rows = await db
      .select({ review: reviews, firstName: customers.firstName, lastName: customers.lastName })
      .from(reviews)
      .innerJoin(customers, eq(customers.id, reviews.customerId))
      .where(eq(reviews.vehicleId, id))
      .orderBy(desc(reviews.createdAt))
      .limit(MAX_PAGE_SIZE);

    return rows.map((row) => toReview(row.review, row));
  });
}
