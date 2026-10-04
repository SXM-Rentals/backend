// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The island's own clock. Every date and time a booking
// carries ("2026-10-12", "10:00") is island time, and this is the one place
// that turns them into real moments, and works out what day it is on the island.
//
// Both sides of the island keep Atlantic Standard Time, UTC−4, all year round:
// no summer time on either side. So a pickup at "10:00" is 14:00 UTC. Reading
// it as 10:00 UTC — as this backend used to — put every pickup four hours
// early: the deposit window opened 52 hours before pickup rather than 48, free
// cancellation ended four hours early, and after 8 in the evening on the island
// "today" was already tomorrow.

export const ISLAND_UTC_OFFSET = '-04:00';
const OFFSET_MS = -4 * 60 * 60 * 1000;

// "2026-10-12" at "10:00" on the island, as a real moment.
export function islandMoment(date: string, time: string): Date {
  return new Date(`${date}T${time.padEnd(5, '0')}:00${ISLAND_UTC_OFFSET}`);
}

// What day it is on the island at a moment (now, by default), as YYYY-MM-DD.
export function islandDate(at: Date | number = Date.now()): string {
  const ms = typeof at === 'number' ? at : at.getTime();
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// A moment in words, in island time, for a sentence a customer reads:
// "Friday 2 October at 10:00".
export function islandWords(at: Date): string {
  const shifted = new Date(at.getTime() + OFFSET_MS);
  const time = shifted.toISOString().slice(11, 16);
  return `${DAYS[shifted.getUTCDay()]} ${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]} at ${time}`;
}
