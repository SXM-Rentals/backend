// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Forgets Stripe's TEST-mode records the first time the
// server starts with LIVE keys.
//
// While testing, the live database collects Stripe ids that exist only in test
// mode: customers' Stripe records and saved cards, the accounts businesses
// started for payouts, and payments on unpaid bookings. Stripe's live mode has
// never heard of them, so with live keys every one of them is "no such
// customer" — and a customer who saved a card while testing could not pay.
//
// So the mode the keys are in is remembered, and on the switch from test to
// live those references are let go. They are made again, for real, the next
// time each is needed. Paid and refunded bookings keep theirs: they are the
// record of what happened, test or not.
//
// ONE WAY ONLY. Going back from live keys to test keys never forgets anything:
// those would be real customers' cards and real businesses' payout accounts. It
// is logged loudly instead.

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  bookings,
  customers,
  dateChangeRequests,
  deposits,
  platformSettings,
  providerPayoutAccounts,
} from '../../db/schema/index.js';

export type StripeMode = 'test' | 'live';

// sk_live_…, rk_live_… are live; anything else is test.
export function stripeKeyMode(secretKey: string): StripeMode {
  return /^(sk|rk)_live_/.test(secretKey) ? 'live' : 'test';
}

export async function recordedStripeMode(db: Database): Promise<StripeMode | null> {
  const [row] = await db.select({ mode: platformSettings.stripeMode }).from(platformSettings).where(eq(platformSettings.id, 1)).limit(1);
  return (row?.mode as StripeMode | null | undefined) ?? null;
}

type Logger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

export async function settleStripeMode(db: Database, secretKey: string, logger: Logger) {
  const mode = stripeKeyMode(secretKey);
  const before = await recordedStripeMode(db);
  if (before === mode) return { mode, forgotten: null };

  if (before === 'live' && mode === 'test') {
    logger.warn(
      { recorded: before, keys: mode },
      'Stripe TEST keys are set on a database that has gone LIVE. Nothing has been forgotten: put the live keys back.',
    );
    return { mode, forgotten: null };
  }

  const forgotten = mode === 'live' ? await db.transaction((tx) => forgetTestRecords(tx as unknown as Database)) : null;
  await db
    .insert(platformSettings)
    .values({ id: 1, stripeMode: mode })
    .onConflictDoUpdate({ target: platformSettings.id, set: { stripeMode: mode } });
  if (forgotten) logger.info({ forgotten }, 'Switched to Stripe live mode: test-mode references forgotten');
  return { mode, forgotten };
}

async function forgetTestRecords(db: Database) {
  const customersCleared = await db
    .update(customers)
    .set({ stripeCustomerId: null, identitySessionId: null })
    .where(or(isNotNull(customers.stripeCustomerId), isNotNull(customers.identitySessionId)))
    .returning({ id: customers.id });

  const payoutAccountsCleared = await db
    .update(providerPayoutAccounts)
    .set({ stripeAccountId: null, status: 'not_started', payoutsEnabled: false, outstanding: sql`'{}'::text[]` })
    .where(isNotNull(providerPayoutAccounts.stripeAccountId))
    .returning({ id: providerPayoutAccounts.providerId });

  // Only payments nobody completed. A paid booking keeps its record.
  const unpaidBookingsCleared = await db
    .update(bookings)
    .set({ stripePaymentIntentId: null })
    .where(and(isNotNull(bookings.stripePaymentIntentId), inArray(bookings.paymentStatus, ['authorized', 'failed'])))
    .returning({ id: bookings.id });

  // Deposits not yet held: the saved card and any half-made hold were test ones.
  const depositsCleared = await db
    .update(deposits)
    .set({
      stripePaymentIntentId: null,
      paymentMethodId: null,
      holdConsentAt: null,
      autoHoldStatus: null,
      autoHoldProblem: null,
      autoHoldTriedAt: null,
    })
    .where(and(eq(deposits.status, 'not_taken'), or(isNotNull(deposits.stripePaymentIntentId), isNotNull(deposits.paymentMethodId))))
    .returning({ id: deposits.id });

  const dateChangesCleared = await db
    .update(dateChangeRequests)
    .set({ stripePaymentIntentId: null })
    .where(and(isNotNull(dateChangeRequests.stripePaymentIntentId), eq(dateChangeRequests.paymentStatus, 'unpaid')))
    .returning({ id: dateChangeRequests.id });

  return {
    customers: customersCleared.length,
    payoutAccounts: payoutAccountsCleared.length,
    unpaidBookings: unpaidBookingsCleared.length,
    deposits: depositsCleared.length,
    dateChanges: dateChangesCleared.length,
  };
}
