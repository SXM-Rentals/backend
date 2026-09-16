// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Works out whether a car is actually free for a set of
// dates, and which days it is already taken. It is the single place that
// decides "is this car available?", so search, the car's page and the moment a
// booking is made all agree.
//
// HOW DATES ARE COUNTED: a rental from the 1st to the 4th uses the nights of
// the 1st, 2nd and 3rd — three days — and the car is handed back on the
// morning of the 4th. So the 4th is free for somebody else to collect. Two
// bookings clash only when one starts before the other ends.
//
// A cancelled booking never blocks anything.

import { and, eq, gt, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings } from '../../db/schema/index.js';

// How far ahead the "already booked" days are listed for a car's page.
export const AVAILABILITY_HORIZON_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- WORKING WITH PLAIN YYYY-MM-DD DATES ----
// Kept as text and compared as text, with no time zone anywhere: a rental on
// the 1st is the 1st on the island, whatever time zone the phone is set to.

export function parseDate(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function today(): string {
  return formatDate(Date.now());
}

// How many days a rental runs for: the 1st to the 4th is 3.
export function countRentalDays(startDate: string, endDate: string): number {
  return Math.round((parseDate(endDate) - parseDate(startDate)) / DAY_MS);
}

// Every day a rental occupies: the 1st to the 4th gives the 1st, 2nd and 3rd.
export function daysBetween(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  for (let day = parseDate(startDate); day < parseDate(endDate); day += DAY_MS) {
    days.push(formatDate(day));
  }
  return days;
}

// ---- IS THIS CAR FREE? ----
// Checked again inside the booking transaction, while the car's row is locked,
// so two people booking the same car at the same moment cannot both succeed.
export async function isVehicleFree(
  db: Database,
  vehicleId: string,
  startDate: string,
  endDate: string,
): Promise<boolean> {
  const [clash] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.vehicleId, vehicleId),
        ne(bookings.status, 'cancelled'),
        // They overlap unless one finishes before the other starts.
        lt(bookings.startDate, endDate),
        gt(bookings.endDate, startDate),
      ),
    )
    .limit(1);
  return clash === undefined;
}

// ---- WHICH DAYS ARE ALREADY TAKEN ----
// For one or many cars at once (search asks about a whole page of them), from
// today up to the horizon above.
export async function unavailableDatesFor(
  db: Database,
  vehicleIds: string[],
  horizonDays = AVAILABILITY_HORIZON_DAYS,
): Promise<Map<string, string[]>> {
  const taken = new Map<string, string[]>();
  for (const id of vehicleIds) taken.set(id, []);
  if (vehicleIds.length === 0) return taken;

  const from = today();
  const until = formatDate(parseDate(from) + horizonDays * DAY_MS);

  const rows = await db
    .select({ vehicleId: bookings.vehicleId, startDate: bookings.startDate, endDate: bookings.endDate })
    .from(bookings)
    .where(
      and(
        sql`${bookings.vehicleId} in ${vehicleIds}`,
        ne(bookings.status, 'cancelled'),
        lt(bookings.startDate, until),
        gt(bookings.endDate, from),
      ),
    );

  for (const row of rows) {
    const days = taken.get(row.vehicleId);
    if (!days) continue;
    for (const day of daysBetween(row.startDate, row.endDate)) {
      if (day >= from && day < until) days.push(day);
    }
  }

  for (const [id, days] of taken) taken.set(id, [...new Set(days)].sort());
  return taken;
}
