// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The command behind `npm run tasks:daily`, meant to be
// run once a day by the host's scheduler. It does the work that has to happen
// whether or not anybody is looking at the site:
//
//   1. Moves bookings on as the dates pass — a rental becomes active on the day
//      it starts and completed once the car is due back.
//   2. Reminds customers collecting or returning a car tomorrow.
//   3. Says which deposit holds will run out before the car is due back — a card
//      hold lasts about seven days whatever the rental does.
//   4. Gathers what each rental business is owed for the past week into a
//      payout, ready to be sent.
//   5. Removes the Stripe record — and with it every saved card — of anybody
//      who has closed their account.
//
// Everything here is safe to run twice: a booking already in the right state is
// left alone, a reminder already sent is not sent again, and a booking already
// covered by a payout is never gathered into a second one.
//
// It does NOT send money. Sending is a separate, deliberate step.

import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { connectDatabase } from '../db/client.js';
import { bookings, customers, fleetImports, providers } from '../db/schema/index.js';
import { createStripeGateway } from '../lib/stripe.js';
import { createDisabledPushSender, createExpoPushSender } from '../lib/push.js';
import { createPushService } from '../services/push/index.js';
import { createConsoleEmailSender, createResendEmailSender, createUnconfiguredEmailSender } from '../lib/email.js';
import { placeDueDepositHolds } from '../services/payments/index.js';
import { recordedStripeMode, stripeKeyMode } from '../services/payments/stripe-mode.js';
import { advanceBookingStatuses } from '../services/booking-engine/lifecycle.js';
import { createNotificationService } from '../services/notifications/index.js';
import { buildPayout } from '../services/payment-splitting/index.js';
import { holdsExpiringBeforeReturn } from '../services/payments/holds.js';
import { expireUnansweredDateChanges } from '../services/date-changes/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const asDate = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

const config = loadConfig();
const connection = await connectDatabase(config.databaseUrl);

try {
  // ---- 1: BOOKINGS MOVE ON ----
  const moved = await advanceBookingStatuses(connection.db);
  console.log(`Bookings: ${moved.startedToday} started, ${moved.completed} completed.`);

  // ---- 2: TOMORROW'S COLLECTIONS AND RETURNS ----
  const push = createPushService({
    db: connection.db,
    sender: config.expoAccessToken
      ? createExpoPushSender({ accessToken: config.expoAccessToken, logger: console })
      : createDisabledPushSender(),
    logger: console,
  });
  const notifications = createNotificationService({
    db: connection.db,
    // Real email once Resend is set up for this job too, as for the API.
    email: config.resendApiKey
      ? createResendEmailSender({ apiKey: config.resendApiKey, from: config.emailFrom, replyTo: config.emailReplyTo, logger: console })
      : config.isProduction
        ? createUnconfiguredEmailSender(console)
        : createConsoleEmailSender(console),
    logger: console,
    brand: { siteUrl: config.appUrl, logoUrl: config.emailLogoUrl },
    // Tomorrow's reminders go to phones too, for those who want them.
    push,
  });
  const reminders = await notifications.sendTomorrowsReminders();
  console.log(`Reminders: ${reminders.pickups} collecting tomorrow, ${reminders.returns} returning tomorrow.`);

  // Phones whose app has been removed stop being sent to.
  const receipts = await push.checkReceipts();
  console.log(`Push receipts: ${receipts.checked} checked, ${receipts.removed} phone(s) no longer registered and removed.`);

  // Spreadsheets read for an import and never confirmed. They hold a
  // business's fleet details, so they are not kept past their hour for long.
  const clearedImports = await connection.db
    .delete(fleetImports)
    .where(lt(fleetImports.expiresAt, new Date(Date.now() - 24 * 60 * 60 * 1000)))
    .returning({ id: fleetImports.id });
  console.log(`Fleet imports: ${clearedImports.length} old ones cleared.`);

  // Requests for new dates that nobody answered in time.
  const expired = await expireUnansweredDateChanges(connection.db);
  console.log(`Date change requests: ${expired} expired unanswered.`);

  // ---- 3: DEPOSITS DUE TO BE HELD ON THE CARD THAT PAID ----
  // Two days before pickup, on the card the customer saved for it when paying.
  // A hold that cannot go through is never retried: the customer is told, once.
  // Keys here in a different Stripe mode from the server's would hold deposits
  // on cards the other mode has never heard of. Skipped, loudly, until they match.
  const stripeModeMatches = config.stripeSecretKey
    ? (await recordedStripeMode(connection.db)) === stripeKeyMode(config.stripeSecretKey)
    : false;
  if (config.stripeSecretKey && !stripeModeMatches) {
    console.warn(
      'Stripe: this job has ' + stripeKeyMode(config.stripeSecretKey) + ' keys but the server is in another mode. ' +
        'Update STRIPE_SECRET_KEY in the GitHub secrets to match Render. Deposit holds skipped.',
    );
  }
  if (config.stripeSecretKey && stripeModeMatches) {
    const holds = await placeDueDepositHolds({
      db: connection.db,
      gateway: createStripeGateway({
        secretKey: config.stripeSecretKey,
        webhookSecret: config.stripeWebhookSecret,
        currency: config.currency,
      }),
      logger: console,
      notifications,
    });
    console.log(
      `Deposit holds placed automatically: ${holds.held} held, ${holds.needsCustomer} need the customer, ${holds.failed} to try again.`,
    );
  } else {
    console.log('Deposit holds placed automatically: skipped, STRIPE_SECRET_KEY is not set for this job.');
  }

  // ---- 3b: DEPOSIT HOLDS ABOUT TO RUN OUT ----
  // A card hold lasts about seven days whatever the rental does, so on a longer
  // rental the deposit stops existing while the car is still out. Nothing here
  // renews it — that needs the customer's agreement to keep a card on file — but
  // saying so out loud, every day, beats finding out when a claim fails.
  const expiring = await holdsExpiringBeforeReturn(connection.db);
  if (expiring.length === 0) {
    console.log('Deposit holds: none running out before their car is due back.');
  } else {
    console.warn(`Deposit holds: ${expiring.length} will run out BEFORE the car is due back.`);
    for (const hold of expiring) {
      console.warn(
        `  ${hold.bookingReference}: $${(hold.amountCents / 100).toFixed(2)} hold ends ` +
          `${hold.expiresAt.slice(0, 10)}, car due back ${hold.rentalEndsOn}.`,
      );
    }
    console.warn('  Act on these: take a fresh deposit, or accept there is nothing to claim against.');
  }

  // ---- 4: WHAT EACH BUSINESS IS OWED ----
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

  // ---- 5: SAVED CARDS OF CLOSED ACCOUNTS ----
  // Closing an account erases what is not needed for the books. Saved cards are
  // not needed for anything once the account is gone, and they live at Stripe,
  // not here — so the Stripe record goes, taking every card with it. Done here
  // rather than at the moment of closing so a Stripe hiccup can never stop
  // somebody closing their account; it is simply tried again tomorrow.
  if (config.stripeSecretKey) {
    const gateway = createStripeGateway({
      secretKey: config.stripeSecretKey,
      webhookSecret: config.stripeWebhookSecret,
      currency: config.currency,
    });
    const closed = await connection.db
      .select({ id: customers.id, stripeCustomerId: customers.stripeCustomerId })
      .from(customers)
      .where(and(isNotNull(customers.deletedAt), isNotNull(customers.stripeCustomerId)));
    let removed = 0;
    for (const row of closed) {
      try {
        await gateway.deleteCustomer(row.stripeCustomerId!);
        await connection.db.update(customers).set({ stripeCustomerId: null }).where(eq(customers.id, row.id));
        removed += 1;
      } catch (error) {
        console.warn(`Could not remove a closed account's saved cards at Stripe; will try again tomorrow.`, error);
      }
    }
    console.log(`Saved cards of closed accounts: ${removed} Stripe record(s) removed.`);
  }
} catch (error) {
  console.error('Daily tasks failed:', error);
  process.exitCode = 1;
} finally {
  await connection.close();
}
