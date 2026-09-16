// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Moves bookings through their life as the dates pass — an
// upcoming rental becomes active on the morning it starts, and a finished one
// becomes completed once the car is due back.
//
// WHY THIS IS NOT DONE WHEN SOMEBODY OPENS A SCREEN: a booking's state has to
// be true whether or not anybody is looking. It runs once a day from the
// scheduled command (scripts/daily-tasks.ts), so the figures a business sees
// and the money it is owed are the same no matter who visits the site.
//
// It is safe to run as often as you like: a booking already in the right state
// is left alone.

import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings } from '../../db/schema/index.js';
import { today } from '../availability-engine/index.js';

export type LifecycleResult = {
  startedToday: number;
  completed: number;
};

export async function advanceBookingStatuses(db: Database): Promise<LifecycleResult> {
  const now = today();

  // ---- STARTED ----
  // The collection day has arrived and the car is not yet due back.
  const started = await db
    .update(bookings)
    .set({ status: 'active' })
    .where(
      and(
        eq(bookings.status, 'upcoming'),
        lte(bookings.startDate, now),
        sql`${bookings.endDate} > ${now}`,
      ),
    )
    .returning({ id: bookings.id });

  // ---- FINISHED ----
  // The return day has arrived, whether the rental had started or not.
  const completed = await db
    .update(bookings)
    .set({ status: 'completed' })
    .where(and(inArray(bookings.status, ['upcoming', 'active']), lte(bookings.endDate, now)))
    .returning({ id: bookings.id });

  return { startedToday: started.length, completed: completed.length };
}
