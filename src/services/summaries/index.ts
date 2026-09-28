// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Loads the small bundles of another record's details that a
// list needs in order to be drawn — a few fields of a car, a business's name.
//
// WHY IT EXISTS: a booking and a conversation used to carry only ids, so to draw
// a booking card or a conversation header the apps fetched the WHOLE catalogue
// and looked each one up. That was instant with made-up data and is not over the
// internet: it costs a second round trip before any list can appear, and it gets
// worse as the catalogue grows, because the cost is the size of the catalogue
// rather than the length of the list. Thirteen screens did it.
//
// EVERYTHING HERE IS BATCHED, ON PURPOSE. Each function takes every id at once
// and answers with a Map, so a list of twenty bookings costs the same two or
// three queries as a list of one. Adding a per-row lookup to any caller of these
// would quietly undo the point of the file.

import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { providers, vehiclePhotos, vehicles } from '../../db/schema/index.js';

// Just enough of a car to draw it in a list: what it is, and one picture.
export type CarSummary = {
  id: string;
  make: string;
  model: string;
  year: number;
  // The cover photo, or null while the business has not added one. Null rather
  // than a stand-in image, so each app can decide what an empty listing looks
  // like in its own layout.
  photo: string | null;
};

// The cars, keyed by id. Two queries however long the list is.
export async function carSummariesFor(db: Database, vehicleIds: string[]): Promise<Map<string, CarSummary>> {
  const ids = [...new Set(vehicleIds)].filter(Boolean);
  const summaries = new Map<string, CarSummary>();
  if (ids.length === 0) return summaries;

  const [rows, photos] = await Promise.all([
    db
      .select({ id: vehicles.id, make: vehicles.make, model: vehicles.model, year: vehicles.year })
      .from(vehicles)
      .where(inArray(vehicles.id, ids)),
    // Every photo of these cars, cheapest order first: the cover is the lowest
    // position, the same rule the car's own page uses, so a booking card and the
    // car page cannot disagree about which picture is the main one.
    db
      .select({ vehicleId: vehiclePhotos.vehicleId, storageKey: vehiclePhotos.storageKey })
      .from(vehiclePhotos)
      .where(inArray(vehiclePhotos.vehicleId, ids))
      .orderBy(asc(vehiclePhotos.position), asc(vehiclePhotos.createdAt)),
  ]);

  const cover = new Map<string, string>();
  for (const photo of photos) {
    // First one wins, and they arrive in cover-first order.
    if (!cover.has(photo.vehicleId)) cover.set(photo.vehicleId, photo.storageKey);
  }

  for (const row of rows) {
    summaries.set(row.id, { ...row, photo: cover.get(row.id) ?? null });
  }
  return summaries;
}

// The businesses' names, keyed by id. One query.
export async function providerNamesFor(db: Database, providerIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(providerIds)].filter(Boolean);
  const names = new Map<string, string>();
  if (ids.length === 0) return names;

  const rows = await db
    .select({ id: providers.id, businessName: providers.businessName })
    .from(providers)
    .where(inArray(providers.id, ids));
  for (const row of rows) names.set(row.id, row.businessName);
  return names;
}

// One of each, for the single-record addresses. Written in terms of the batched
// versions so there is only one definition of what a summary contains.
export async function carSummaryFor(db: Database, vehicleId: string): Promise<CarSummary | null> {
  return (await carSummariesFor(db, [vehicleId])).get(vehicleId) ?? null;
}

export async function providerNameFor(db: Database, providerId: string): Promise<string> {
  const [row] = await db
    .select({ businessName: providers.businessName })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  // A booking always has a business, closed or not; the empty string is only
  // reached if a row went missing, and a blank name is better than a crash.
  return row?.businessName ?? '';
}
