// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Lets a business take one of its cars off sale for some
// days — servicing, a private hire, keeping it back — and put it back.
//
// Until this existed, the only days SXM Rentals treated as taken were booked
// ones, so a car sitting in the garage could still be booked. A block is now a
// taken day everywhere availability is decided (see services/availability-
// engine): search, the car's page, quotes and the booking itself.
//
// THE RULES:
//   - both dates count; a one-day block has the same start and end;
//   - not in the past, and not ending before it starts (invalid_dates);
//   - not over a day already booked (days_booked, naming the booking) — the
//     business sorts that booking out first, rather than a customer finding
//     their rental quietly overlapping a garage visit;
//   - customers never learn why a day is unavailable.

import { and, asc, eq, gt, gte, lte, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings, vehicleBlocks } from '../../db/schema/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import { countRentalDays, today } from '../availability-engine/index.js';
import { ownVehicleId } from '../provider/index.js';

export type BlockReason = 'servicing' | 'private_hire' | 'held_back' | 'other';

// The longest one block may be. Longer than this is taking the car off the
// platform, which has its own button.
const MAX_BLOCK_DAYS = 366;

function toBlock(row: typeof vehicleBlocks.$inferSelect) {
  return { id: row.id, startDate: row.startDate, endDate: row.endDate, reason: row.reason };
}

// The car's blocks that are not over yet, soonest first.
export async function listBlocks(db: Database, providerId: string, vehicleId: string) {
  const id = await ownVehicleId(db, providerId, vehicleId);
  const rows = await db
    .select()
    .from(vehicleBlocks)
    .where(and(eq(vehicleBlocks.vehicleId, id), gte(vehicleBlocks.endDate, today())))
    .orderBy(asc(vehicleBlocks.startDate));
  return rows.map(toBlock);
}

export async function addBlock(
  db: Database,
  providerId: string,
  vehicleId: string,
  input: { startDate: string; endDate: string; reason: BlockReason },
) {
  const id = await ownVehicleId(db, providerId, vehicleId);
  if (input.startDate < today()) throw badRequest('invalid_dates', 'A block cannot start in the past.');
  if (input.endDate < input.startDate) throw badRequest('invalid_dates', 'The last day has to be on or after the first.');
  if (countRentalDays(input.startDate, input.endDate) + 1 > MAX_BLOCK_DAYS) {
    throw badRequest('invalid_dates', 'A block can be at most a year. To stop renting the car, take it off the platform.');
  }

  // A booking with a night on any of these days. The booking's end date is the
  // morning it comes back, so a car returned on the first blocked day is fine.
  const [booked] = await db
    .select({ reference: bookings.reference })
    .from(bookings)
    .where(
      and(
        eq(bookings.vehicleId, id),
        ne(bookings.status, 'cancelled'),
        lte(bookings.startDate, input.endDate),
        gt(bookings.endDate, input.startDate),
      ),
    )
    .orderBy(asc(bookings.startDate))
    .limit(1);
  if (booked) {
    throw conflict('days_booked', `Some of those days are already booked (${booked.reference}). Sort that booking out first.`);
  }

  const [created] = await db
    .insert(vehicleBlocks)
    .values({ vehicleId: id, startDate: input.startDate, endDate: input.endDate, reason: input.reason })
    .returning();
  return toBlock(created!);
}

export async function removeBlock(db: Database, providerId: string, vehicleId: string, blockId: string) {
  const id = await ownVehicleId(db, providerId, vehicleId);
  if (!isUuid(blockId)) throw notFound('We could not find that block.');
  const removed = await db
    .delete(vehicleBlocks)
    .where(and(eq(vehicleBlocks.id, blockId), eq(vehicleBlocks.vehicleId, id)))
    .returning({ id: vehicleBlocks.id });
  if (removed.length === 0) throw notFound('We could not find that block.');
}

