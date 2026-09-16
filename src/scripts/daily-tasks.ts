// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The command behind `npm run tasks:daily`, meant to be
// run once a day by the host's scheduler. It does the work that has to happen
// whether or not anybody is looking at the site:
//
//   1. Moves bookings on as the dates pass — a rental becomes active on the day
//      it starts and completed once the car is due back.
//   2. Reminds customers collecting or returning a car tomorrow.
//   3. Gathers what each rental business is owed for the past week into a
//      payout, ready to be sent.
//
// Everything here is safe to run twice: a booking already in the right state is
// left alone, a reminder already sent is not sent again, and a booking already
// covered by a payout is never gathered into a second one.
//
// It does NOT send money. Sending is a separate, deliberate step.

import { eq, isNull } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { connectDatabase } from '../db/client.js';
import { bookings, providers } from '../db/schema/index.js';
import { createConsoleEmailSender, createUnconfiguredEmailSender } from '../lib/email.js';
import { advanceBookingStatuses } from '../services/booking-engine/lifecycle.js';
import { createNotificationService } from '../services/notifications/index.js';
import { buildPayout } from '../services/payment-splitting/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const asDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

const config = loadConfig();
const connection = await connectDatabase(config.databaseUrl);

try {
  // ---- 1: BOOKINGS MOVE ON ----
  const moved = await advanceBookingStatuses(connection.db);
  console.log(`Bookings: ${moved.startedToday} started, ${moved.completed} completed.`);

  // ---- 2: TOMORROW'S COLLECTIONS AND RETURNS ----
  const notifications = createNotificationService({
    db: connection.db,
    email: config.isProduction ? createUnconfiguredEmailSender(console) : createConsoleEmailSender(console),
    logger: console,
  });
  const reminders = await notifications.sendTomorrowsReminders();
  console.log(`Reminders: ${reminders.pickups} collecting tomorrow, ${reminders.returns} returning tomorrow.`);

  // ---- 3: WHAT EACH BUSINESS IS OWED ----
  // Every business with a finished, paid-for rental not yet covered by a payout.
  const owed = await connection.db
    .selectDistinct({ providerId: bookings.providerId })
    .from(bookings)
    .where(isNull(bookings.payoutId));

  const period = { start: asDate(Date.now() - 7 * DAY_MS), end: asDate(Date.now()) };
  let created = 0;
  for (const row of owed) {
    const payout = await buildPayout(connection.db, row.providerId, period);
    if (!payout) continue;
    created += 1;
    const [business] = await connection.db
      .select({ name: providers.businessName })
      .from(providers)
      .where(eq(providers.id, row.providerId))
      .limit(1);
    console.log(
      `Payout ${payout.reference} for ${business?.name ?? row.providerId}: ` +
        `$${(payout.amountCents / 100).toFixed(2)} across ${payout.bookingCount} booking(s).`,
    );
  }
  console.log(`Payouts prepared: ${created}. None have been sent — that is a separate step.`);
} catch (error) {
  console.error('Daily tasks failed:', error);
  process.exitCode = 1;
} finally {
  await connection.close();
}
