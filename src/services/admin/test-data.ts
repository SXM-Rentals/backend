// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Lets the Godfather clear one kind of test record before
// launch — bookings, payments, payouts, deposits, cars, businesses or points —
// so the owner can try SXM Rentals out for real and then put it back.
//
// THE MOST DANGEROUS THING IN THIS REPO, so it is fenced three ways:
//
//   1. IT SHUTS ITSELF. Checked on every call, never a setting to remember:
//        - ALLOW_TEST_RESET=on must be set on the server (absent means shut);
//        - and Stripe must never have run in LIVE mode on this platform. Once
//          live keys have been set, this is shut for good: live keys mean real
//          money and real customers. (See services/payments/stripe-mode.ts.)
//   2. THE AUDIT LOG AND STAFF ACCOUNTS ARE NEVER TOUCHED. No clear names them,
//      every clear says up front exactly which tables it may remove rows from,
//      and each one counts the audit log and the staff accounts before and after
//      inside its own transaction — if either changed, everything is undone.
//      Every clear writes its own audit row, in that same transaction.
//   3. GODFATHER ONLY, with the authenticator code (checked by the route).
//
// EACH CLEAR TAKES ONLY WHAT IT NAMES. Where the database will not let one kind
// go without another (a deposit cannot exist without its booking), it refuses
// and says what would have to go first, rather than taking more than was asked.

import { count, isNotNull } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import {
  adminStaff,
  auditLog,
  bookings,
  deposits,
  disputes,
  ledgerEntries,
  payouts,
  providers,
  refundRequests,
  rewardLedger,
  vehicles,
} from '../../db/schema/index.js';
import { AppError, conflict } from '../../lib/errors.js';
import { recordedStripeMode, stripeKeyMode } from '../payments/stripe-mode.js';
import { recordAudit } from './audit.js';
import type { AdminActor } from './auth.js';
import { requireTier } from './tiers.js';

export const CLEARABLE = ['bookings', 'payments', 'payouts', 'deposits', 'vehicles', 'providers', 'customer_spend'] as const;
export type Clearable = (typeof CLEARABLE)[number];

// Tables no clear may ever remove a row from. Checked before any clear runs.
const PROTECTED = new Set(['audit_log', 'admin_staff', 'admin_sessions', 'customers', 'credentials']);

const LABELS: Record<Clearable, string> = {
  bookings: 'Bookings',
  payments: 'Payments',
  payouts: 'Payouts',
  deposits: 'Deposits',
  vehicles: 'Vehicles',
  providers: 'Rental businesses',
  customer_spend: 'Customer points',
};

// ---- IS IT OPEN? ----
// The panel prints these sentences, so the owner can see what keeps it open.
export type ResetCondition = { name: string; met: boolean; sentence: string };

export async function testResetStatus(db: Database, config: Config) {
  const switchOn = config.allowTestReset;
  const recorded = await recordedStripeMode(db);
  const keysLive = config.stripeSecretKey ? stripeKeyMode(config.stripeSecretKey) === 'live' : false;
  const everLive = recorded === 'live' || keysLive;
  const conditions: ResetCondition[] = [
    {
      name: 'allow_test_reset',
      met: switchOn,
      sentence: switchOn
        ? 'ALLOW_TEST_RESET is on for this server.'
        : 'ALLOW_TEST_RESET is not on for this server, so clearing is shut.',
    },
    {
      name: 'never_live',
      met: !everLive,
      sentence: everLive
        ? 'Stripe has run in live mode on this platform: real money, real customers. Clearing is shut for good.'
        : 'Stripe has only ever run in test mode here: no real money has been taken.',
    },
  ];
  return { open: conditions.every((condition) => condition.met), conditions };
}

async function assertOpen(db: Database, config: Config) {
  const status = await testResetStatus(db, config);
  if (!status.open) {
    const why = status.conditions.filter((condition) => !condition.met).map((condition) => condition.sentence);
    throw new AppError(403, 'test_reset_closed', why.join(' '), { conditions: status.conditions });
  }
}

// ---- WHAT EACH CLEAR DOES ----
type Plan = {
  // The tables this clear may remove rows from, said out loud before it runs.
  removesFrom: string[];
  // Refuses with a sentence when the database would make it take more.
  blockedBy: (db: Database) => Promise<string | null>;
  run: (db: Database) => Promise<{ cleared: number; detail: string }>;
};

const countOf = async (db: Database, table: typeof bookings | typeof deposits | typeof payouts | typeof vehicles | typeof providers | typeof ledgerEntries | typeof rewardLedger) =>
  (await db.select({ value: count() }).from(table))[0]?.value ?? 0;

const PLANS: Record<Clearable, Plan> = {
  // Bookings and their own history: price lines, signatures, date changes,
  // refund requests, disputes, reviews and the notifications about them. The
  // payment lines are KEPT, detached from the booking they were for.
  bookings: {
    removesFrom: ['bookings', 'booking_price_lines', 'booking_signatures', 'date_change_requests', 'refund_requests', 'disputes', 'reviews', 'notifications'],
    blockedBy: async (db) =>
      (await countOf(db, deposits)) > 0
        ? 'Bookings cannot be cleared while their deposits are kept: a deposit belongs to its booking and cannot exist without it. Clear deposits first, then bookings.'
        : null,
    run: async (db) => {
      const detached = await db
        .update(ledgerEntries)
        .set({ bookingId: null })
        .where(isNotNull(ledgerEntries.bookingId))
        .returning({ id: ledgerEntries.id });
      await db.delete(refundRequests);
      await db.delete(disputes);
      const gone = await db.delete(bookings).returning({ id: bookings.id });
      return {
        cleared: gone.length,
        detail:
          `${gone.length} booking(s) cleared. Their ${detached.length} payment line(s) are kept on the Payments screen, no longer linked to a booking. ` +
          'Revenue on the dashboard and Analytics is worked out from bookings, so it now reads without them.',
      };
    },
  },

  // The money record only.
  payments: {
    removesFrom: ['ledger_entries'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(ledgerEntries).returning({ id: ledgerEntries.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} payment line(s) cleared. Bookings are untouched, so revenue worked out from them is unchanged.`,
      };
    },
  },

  // The payout runs. The bookings they covered stay, and count as owed again.
  payouts: {
    removesFrom: ['payouts'],
    blockedBy: async () => null,
    run: async (db) => {
      const owedAgain = await db
        .update(bookings)
        .set({ payoutId: null })
        .where(isNotNull(bookings.payoutId))
        .returning({ id: bookings.id });
      const gone = await db.delete(payouts).returning({ id: payouts.id });
      return {
        cleared: gone.length,
        detail:
          `${gone.length} payout(s) cleared. The ${owedAgain.length} booking(s) they covered count as owed again, ` +
          'so the next daily run gathers them into new payouts. Money already sent through Stripe is not taken back.',
      };
    },
  },

  // Deposit records. Holds already placed at Stripe are not released by this.
  deposits: {
    removesFrom: ['deposits'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(deposits).returning({ id: deposits.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} deposit record(s) cleared. Any hold still placed at Stripe stays there until it expires or is released in Stripe.`,
      };
    },
  },

  // Cars, with their photos, papers, blocks and accident records.
  vehicles: {
    removesFrom: ['vehicles', 'vehicle_photos', 'vehicle_documents', 'vehicle_blocks', 'vehicle_accident_records', 'saved_cars', 'reviews'],
    blockedBy: async (db) =>
      (await countOf(db, bookings)) > 0
        ? 'Vehicles cannot be cleared while bookings point at them. Clear deposits, then bookings, then vehicles.'
        : null,
    run: async (db) => {
      const gone = await db.delete(vehicles).returning({ id: vehicles.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} vehicle(s) cleared, with their photo records, papers, blocked days and accident history. Photo files stay in Cloudinary.`,
      };
    },
  },

  // Businesses and their fleets, memberships, profiles, payout accounts, codes,
  // conversations and connections. The people behind them keep their accounts.
  providers: {
    removesFrom: [
      'providers',
      'vehicles',
      'vehicle_photos',
      'vehicle_documents',
      'vehicle_blocks',
      'vehicle_accident_records',
      'saved_cars',
      'provider_members',
      'provider_business_profiles',
      'provider_payout_accounts',
      'provider_integrations',
      'business_promotions',
      'fleet_imports',
      'fleet_requests',
      'chat_threads',
    ],
    blockedBy: async (db) => {
      const waiting = [];
      if ((await countOf(db, bookings)) > 0) waiting.push('bookings');
      if ((await countOf(db, payouts)) > 0) waiting.push('payouts');
      return waiting.length
        ? `Rental businesses cannot be cleared while ${waiting.join(' and ')} point at them. Clear ${waiting.join(' and ')} first (and deposits before bookings).`
        : null;
    },
    run: async (db) => {
      await db.delete(vehicles);
      const gone = await db.delete(providers).returning({ id: providers.id });
      return {
        cleared: gone.length,
        detail:
          `${gone.length} rental business(es) cleared, with their fleets, conversations, discount codes and payout set-up. ` +
          'The people who ran them keep their own accounts. Stripe accounts they opened stay at Stripe.',
      };
    },
  },

  // Points back to zero. Lifetime spend and booking counts are worked out from
  // bookings, so they reach zero when bookings are cleared.
  customer_spend: {
    removesFrom: ['reward_ledger'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(rewardLedger).returning({ customerId: rewardLedger.customerId });
      const people = new Set(gone.map((row) => row.customerId)).size;
      return {
        cleared: gone.length,
        detail:
          `${gone.length} points entry(ies) cleared for ${people} customer(s): every customer's points are back to zero, and their accounts are untouched. ` +
          'Lifetime spend and booking counts are worked out from bookings, so they reach zero when bookings are cleared.',
      };
    },
  },
};

// The rows the audit log and staff accounts hold, to prove a clear left them be.
async function protectedCounts(db: Database) {
  const [audit] = await db.select({ value: count() }).from(auditLog);
  const [staff] = await db.select({ value: count() }).from(adminStaff);
  return { audit: audit?.value ?? 0, staff: staff?.value ?? 0 };
}

export function createTestDataService(deps: { db: Database; config: Config }) {
  const { db, config } = deps;
  return {
    async status(actor: AdminActor) {
      requireTier(actor, 'godfather');
      return testResetStatus(db, config);
    },

    async clear(actor: AdminActor, input: { what: Clearable; reason: string }) {
      requireTier(actor, 'godfather');
      await assertOpen(db, config);
      const plan = PLANS[input.what];
      const touched = plan.removesFrom.filter((table) => PROTECTED.has(table));
      if (touched.length > 0) throw new Error(`A clear may never touch ${touched.join(', ')}`);

      const blocked = await plan.blockedBy(db);
      if (blocked) throw conflict('would_take_more', `${blocked} Nothing was changed.`);

      return db.transaction(async (tx) => {
        const t = tx as unknown as Database;
        const before = await protectedCounts(t);
        const result = await plan.run(t);
        const after = await protectedCounts(t);
        if (before.audit !== after.audit || before.staff !== after.staff) {
          throw new Error('A clear changed the audit log or the staff accounts; undone.');
        }
        await recordAudit(t, {
          staffId: actor.staffId,
          action: 'test_records_cleared',
          subjectType: 'platform',
          subjectId: 'test-data',
          subjectLabel: 'Test data',
          field: LABELS[input.what],
          before: String(result.cleared),
          after: '0',
          reason: input.reason,
        });
        return { what: input.what, cleared: result.cleared, detail: result.detail };
      });
    },
  };
}

export type TestDataService = ReturnType<typeof createTestDataService>;

