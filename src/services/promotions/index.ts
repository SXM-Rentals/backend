// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: A rental business's own discount codes — making them,
// pausing them, deleting them — and checking a code a customer types when they
// book.
//
// THE RULES (see the table in db/schema/bookings.ts for why each is there):
//   - a code belongs to one business and only works on its cars;
//   - one code per booking;
//   - 5% to 50% off the rental lines; the deposit is never discounted;
//   - commission is charged on what the renter pays, so the business and SXM
//     Rentals share the cost of the discount in proportion;
//   - startsOn and endsOn bound the pickup date, both included; minDays is the
//     shortest rental; maxUses counts bookings, and a cancelled one gives its
//     use back;
//   - a bad code never fails a quote: the price shows without it, and a message
//     says why. At booking, a code that no longer applies is refused rather
//     than the car being booked quietly at full price.

import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings, businessPromotions, vehicles } from '../../db/schema/index.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import { countRentalDays } from '../availability-engine/index.js';
import type { AppliedDiscount } from '../booking-engine/index.js';

type PromotionRow = typeof businessPromotions.$inferSelect;
type Tx = Pick<Database, 'select'>;

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

function toPromotion(row: PromotionRow, timesUsed: number) {
  return {
    id: row.id,
    code: row.code,
    percentOff: row.percentOff,
    minDays: row.minDays,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    maxUses: row.maxUses,
    timesUsed,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

// How many bookings, not cancelled, used each of these codes. One query.
async function usesOf(db: Tx, ids: string[]): Promise<Map<string, number>> {
  const uses = new Map<string, number>();
  if (ids.length === 0) return uses;
  const rows = await db
    .select({ id: bookings.promotionId, count: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(inArray(bookings.promotionId, ids), ne(bookings.status, 'cancelled')))
    .groupBy(bookings.promotionId);
  for (const row of rows) if (row.id) uses.set(row.id, row.count);
  return uses;
}

// ---- THE BUSINESS'S OWN LIST ----
export async function listPromotions(db: Database, providerId: string) {
  const rows = await db
    .select()
    .from(businessPromotions)
    .where(and(eq(businessPromotions.providerId, providerId), isNull(businessPromotions.deletedAt)))
    .orderBy(desc(businessPromotions.createdAt));
  const uses = await usesOf(db, rows.map((row) => row.id));
  return rows.map((row) => toPromotion(row, uses.get(row.id) ?? 0));
}

export type PromotionInput = {
  code: string;
  percentOff: number;
  minDays?: number | undefined;
  startsOn?: string | undefined;
  endsOn?: string | undefined;
  maxUses?: number | undefined;
};

export async function createPromotion(db: Database, providerId: string, input: PromotionInput) {
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    throw badRequest('invalid_dates', 'The last pickup date has to be on or after the first.');
  }
  try {
    const [row] = await db
      .insert(businessPromotions)
      .values({
        providerId,
        code: normaliseCode(input.code),
        percentOff: input.percentOff,
        minDays: input.minDays ?? null,
        startsOn: input.startsOn ?? null,
        endsOn: input.endsOn ?? null,
        maxUses: input.maxUses ?? null,
      })
      .returning();
    return toPromotion(row!, 0);
  } catch (error) {
    if ((error as { cause?: { code?: string } })?.cause?.code === '23505') {
      throw new AppError(409, 'code_taken', `You already have a code called ${normaliseCode(input.code)}.`);
    }
    throw error;
  }
}

async function ownPromotion(db: Database, providerId: string, id: string) {
  if (!isUuid(id)) throw notFound('We could not find that code.');
  const [row] = await db
    .select()
    .from(businessPromotions)
    .where(
      and(eq(businessPromotions.id, id), eq(businessPromotions.providerId, providerId), isNull(businessPromotions.deletedAt)),
    )
    .limit(1);
  if (!row) throw notFound('We could not find that code.');
  return row;
}

// Pausing and resuming. The rules of a code do not change once customers may
// have seen it; a different offer is a new code.
export async function setPromotionActive(db: Database, providerId: string, id: string, active: boolean) {
  const row = await ownPromotion(db, providerId, id);
  const [updated] = await db
    .update(businessPromotions)
    .set({ active })
    .where(eq(businessPromotions.id, row.id))
    .returning();
  const uses = await usesOf(db, [row.id]);
  return toPromotion(updated!, uses.get(row.id) ?? 0);
}

export async function deletePromotion(db: Database, providerId: string, id: string) {
  const row = await ownPromotion(db, providerId, id);
  await db.update(businessPromotions).set({ deletedAt: new Date(), active: false }).where(eq(businessPromotions.id, row.id));
}

// ---- CHECKING A CODE A CUSTOMER TYPED ----
export type PromoCheck =
  | { applied: true; promotion: PromotionRow; discount: AppliedDiscount }
  | { applied: false; message: string };

// db can be a transaction: at booking, the code's row is locked first so two
// bookings at once cannot both take its last use.
export async function checkPromoCode(
  db: Tx,
  vehicle: Pick<typeof vehicles.$inferSelect, 'providerId'>,
  code: string,
  dates: { startDate: string; endDate: string },
): Promise<PromoCheck> {
  const wanted = normaliseCode(code);
  const [row] = await db
    .select()
    .from(businessPromotions)
    .where(
      and(
        eq(businessPromotions.providerId, vehicle.providerId),
        eq(businessPromotions.code, wanted),
        isNull(businessPromotions.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    // Another business's code is a real code, just not for this car.
    const [elsewhere] = await db
      .select({ id: businessPromotions.id })
      .from(businessPromotions)
      .where(and(eq(businessPromotions.code, wanted), isNull(businessPromotions.deletedAt)))
      .limit(1);
    return {
      applied: false,
      message: elsewhere ? 'This code is not for this car.' : 'We do not recognise this code.',
    };
  }
  if (!row.active) return { applied: false, message: 'This code is paused at the moment.' };
  if (row.startsOn && dates.startDate < row.startsOn) {
    return { applied: false, message: `This code works for pickups from ${row.startsOn}.` };
  }
  if (row.endsOn && dates.startDate > row.endsOn) return { applied: false, message: 'This code has expired.' };
  if (row.minDays && countRentalDays(dates.startDate, dates.endDate) < row.minDays) {
    return { applied: false, message: `This code needs a rental of at least ${row.minDays} days.` };
  }
  if (row.maxUses) {
    const uses = (await usesOf(db, [row.id])).get(row.id) ?? 0;
    if (uses >= row.maxUses) return { applied: false, message: 'This code has been used up.' };
  }
  return { applied: true, promotion: row, discount: { code: row.code, percentOff: row.percentOff } };
}

// The discount a booking already has, for re-pricing it at new dates. It was
// accepted when the booking was made, so pausing or deleting the code since
// does not take it away — but the rental still has to be long enough for it.
export async function discountOfBooking(
  db: Database,
  promotionId: string | null,
  dates: { startDate: string; endDate: string },
): Promise<AppliedDiscount | null> {
  if (!promotionId) return null;
  const [row] = await db.select().from(businessPromotions).where(eq(businessPromotions.id, promotionId)).limit(1);
  if (!row) return null;
  if (row.minDays && countRentalDays(dates.startDate, dates.endDate) < row.minDays) return null;
  return { code: row.code, percentOff: row.percentOff };
}
