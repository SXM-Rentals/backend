// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The figures behind the charts on the staff analytics
// screen — money taken, bookings made and people who signed up, between any two
// dates.
//
// THE BUCKET SIZE FOLLOWS THE SPAN, and that is the whole trick. Somebody
// asking for the last fifty days and getting two monthly bars has been given an
// answer to a question they did not ask. So a short range is counted by day, a
// season by week, a year by month, and several years by quarter. The chart
// adapts to the question instead of making the person phrase the question to
// suit the chart. This mirrors the admin panel's own rule exactly, so the real
// figures arrive bucketed the way its screens already expect.
//
// TWO THINGS TO KNOW ABOUT THE NUMBERS:
//   - Money is counted by WHEN THE BOOKING WAS MADE, not when the rental
//     happens, because that is the question the screen asks: how much did we
//     take that week.
//   - A cancelled booking still counts as a booking that was made, but brings
//     in no money, so it is in the count and not in the total.
//
// Security deposits appear nowhere here. They are the customer's money being
// held, so counting them would overstate the size of the platform.

import { and, gte, lte, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings, customers } from '../../db/schema/index.js';

// 'year' is the coarsest step. The admin panel's own list stops at 'quarter',
// which overflows the readable limit once a range passes about ten years; the
// bucket name never leaves this server (the response is only labels and
// figures), so going one step coarser keeps the promise below without changing
// anything the apps read.
export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type SeriesPoint = {
  label: string;
  gmv: number;
  bookings: number;
  newUsers: number;
};

// The widths, in days. Quarter is here so several years still come out as
// something a person can read across rather than a hundred slivers.
const BUCKET_DAYS: Record<Bucket, number> = { day: 1, week: 7, month: 30.44, quarter: 91.3, year: 365.25 };

// Above about forty bars a chart stops being readable — the marks get thinner
// than the gaps between them and the labels collide.
const MAX_BARS = 40;

export function bucketFor(startISO: string, endISO: string): Bucket {
  const days = Math.max(1, (Date.parse(endISO) - Date.parse(startISO)) / 86_400_000);
  // The narrowest bucket that keeps the bar count under the ceiling, so a short
  // range still gets all the detail it can support.
  for (const bucket of ['day', 'week', 'month', 'quarter', 'year'] as Bucket[]) {
    if (days / BUCKET_DAYS[bucket] <= MAX_BARS) return bucket;
  }
  // Longer than about forty years. Years is as coarse as this goes.
  return 'year';
}

// How each bucket is labelled on the axis. Short, because a dozen of them share
// the width of one card. Everything is worked out in UTC so the same range
// gives the same answer wherever the server happens to be running.
function bucketLabel(date: Date, bucket: Bucket): string {
  if (bucket === 'year') {
    return String(date.getUTCFullYear());
  }
  if (bucket === 'quarter') {
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${String(date.getUTCFullYear()).slice(2)}`;
  }
  if (bucket === 'month') {
    return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// Steps forward by one bucket.
function advance(date: Date, bucket: Bucket): Date {
  const next = new Date(date);
  if (bucket === 'day') next.setUTCDate(next.getUTCDate() + 1);
  else if (bucket === 'week') next.setUTCDate(next.getUTCDate() + 7);
  else if (bucket === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else if (bucket === 'quarter') next.setUTCMonth(next.getUTCMonth() + 3);
  else next.setUTCMonth(next.getUTCMonth() + 12);
  return next;
}

// ---- THE SERIES BETWEEN TWO DATES ----
export async function buildSeries(db: Database, startISO: string, endISO: string): Promise<SeriesPoint[]> {
  const bucket = bucketFor(startISO, endISO);

  const from = new Date(`${startISO.slice(0, 10)}T00:00:00.000Z`);
  const to = new Date(`${endISO.slice(0, 10)}T23:59:59.999Z`);

  const [bookingRows, customerRows] = await Promise.all([
    db
      .select({ createdAt: bookings.createdAt, grossCents: bookings.grossCents, status: bookings.status })
      .from(bookings)
      .where(and(gte(bookings.createdAt, from), lte(bookings.createdAt, to))),
    db
      .select({ createdAt: customers.createdAt })
      .from(customers)
      .where(and(gte(customers.createdAt, from), lte(customers.createdAt, to))),
  ]);

  // A month bucket starts on the 1st and a quarter on its first month —
  // otherwise the first bar covers a stub of a period and reads as a collapse
  // in trade rather than as a partial bucket.
  const cursor = new Date(from);
  if (bucket === 'month') cursor.setUTCDate(1);
  if (bucket === 'quarter') cursor.setUTCMonth(Math.floor(cursor.getUTCMonth() / 3) * 3, 1);
  if (bucket === 'year') cursor.setUTCMonth(0, 1);

  const points: SeriesPoint[] = [];
  // The width above already keeps the count under MAX_BARS, so this cannot run
  // away however long the range is.
  while (cursor <= to) {
    const bucketStart = new Date(cursor);
    const bucketEnd = advance(cursor, bucket);
    const inBucket = (at: Date) => at >= bucketStart && at < bucketEnd;

    const made = bookingRows.filter((row) => inBucket(row.createdAt));
    points.push({
      label: bucketLabel(bucketStart, bucket),
      // Cancelled bookings brought in nothing, so they are counted but not totalled.
      gmv: made.filter((row) => row.status !== 'cancelled').reduce((sum, row) => sum + row.grossCents, 0) / 100,
      bookings: made.length,
      newUsers: customerRows.filter((row) => inBucket(row.createdAt)).length,
    });

    cursor.setTime(bucketEnd.getTime());
  }

  return points;
}

// ---- THE LAST FEW WHOLE MONTHS ----
// Kept because the dashboard and the quick ranges think in whole months.
export async function buildMonthlySeries(db: Database, months: number): Promise<SeriesPoint[]> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  const [bookingRows, customerRows] = await Promise.all([
    db
      .select({ createdAt: bookings.createdAt, grossCents: bookings.grossCents, status: bookings.status })
      .from(bookings)
      .where(and(gte(bookings.createdAt, start), ne(bookings.status, 'cancelled'))),
    db.select({ createdAt: customers.createdAt }).from(customers).where(gte(customers.createdAt, start)),
  ]);

  return Array.from({ length: months }, (_, index) => {
    const monthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
    const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index + 1, 1));
    const inMonth = (at: Date) => at >= monthStart && at < monthEnd;

    const made = bookingRows.filter((row) => inMonth(row.createdAt));
    return {
      label: bucketLabel(monthStart, 'month'),
      gmv: made.reduce((sum, row) => sum + row.grossCents, 0) / 100,
      bookings: made.length,
      newUsers: customerRows.filter((row) => inMonth(row.createdAt)).length,
    };
  }).filter((_, index) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)) <= end);
}
