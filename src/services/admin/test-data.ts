// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Lets the Godfather clear test records before launch —
// one kind at a time (bookings, payments, cars, businesses, customers,
// conversations, the audit log…) or everything at once — so the owner can try
// SXM Rentals out for real and then put it back.
//
// THE MOST DANGEROUS THING IN THIS REPO, so it is fenced three ways:
//
//   1. IT SHUTS ITSELF. Checked on every call, never a setting to remember:
//        - ALLOW_TEST_RESET=on must be set on the server (absent means shut);
//        - and Stripe must never have run in LIVE mode on this platform. Once
//          live keys have been set, this is shut for good: live keys mean real
//          money and real customers. (See services/payments/stripe-mode.ts.)
//   2. STAFF ACCOUNTS AND PLATFORM SETTINGS ARE NEVER TOUCHED, by any clear,
//      Everything included. Each clear says up front which tables it may remove
//      rows from, and counts the staff accounts and the settings before and after
//      inside its own transaction — if either changed, everything is undone.
//      Keeping the settings is what keeps fence 1 standing: the record that
//      Stripe ran live lives there.
//   3. GODFATHER ONLY, with the authenticator code (checked by the route).
//
// NOTHING IS LEFT BEHIND. This is the owner's decision, made firmly and more than
// once: the Godfather is the one account that answers to nobody for what it does
// to test data, so a clear writes no audit entry and no note of any kind. The
// audit log can itself be cleared, on its own or with Everything, and is then
// empty — no row says it happened. Fence 1 is the safeguard instead of a trail:
// once Stripe has run live, none of this works for anybody, the Godfather
// included. Every clear other than the log's own and Everything's still proves
// it left the log alone.
//
// EACH CLEAR TAKES ONLY WHAT IT NAMES. Where the database will not let one kind
// go without another (a deposit cannot exist without its booking), it refuses
// and says what would have to go first, rather than taking more than was asked.
// "Everything" is the way to take it all in one go: it runs every clear in the
// order the database needs, in one transaction, so it either all goes or none.
// The audit log goes LAST of all, so a step that fails part-way can never leave a
// record saying a clearing was attempted: the failure says which step it was, and
// nothing — in the log or anywhere else — has changed.

import { count, isNotNull, notInArray } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import {
  adminStaff,
  auditLog,
  bookings,
  chatThreads,
  customers,
  deposits,
  disputes,
  fleetRequests,
  ledgerEntries,
  notifications,
  payouts,
  platformSettings,
  providerMembers,
  providers,
  refundRequests,
  rewardLedger,
  supportInteractions,
  supportMessages,
  vehicles,
} from '../../db/schema/index.js';
import { AppError, conflict } from '../../lib/errors.js';
import { recordedStripeMode, stripeKeyMode } from '../payments/stripe-mode.js';
import { recordAudit } from './audit.js';
import type { AdminActor } from './auth.js';
import { requireTier } from './tiers.js';

export const CLEARABLE = [
  'everything',
  'bookings',
  'payments',
  'payouts',
  'deposits',
  'refunds',
  'disputes',
  'vehicles',
  'providers',
  'customers',
  'customer_spend',
  'messages',
  'notifications',
  'support',
  'fleet_requests',
  'audit_log',
] as const;
export type Clearable = (typeof CLEARABLE)[number];
type OneKind = Exclude<Clearable, 'everything'>;

// Tables no clear may ever remove a row from. Checked before any clear runs.
const ALWAYS_KEPT = new Set(['admin_staff', 'admin_sessions', 'platform_settings']);

// What the panel prints, and what the audit entry names in its "field".
const LABELS: Record<Clearable, string> = {
  everything: 'Everything',
  bookings: 'Bookings',
  payments: 'Payments',
  payouts: 'Payouts',
  deposits: 'Deposits',
  refunds: 'Refund requests',
  disputes: 'Disputes',
  vehicles: 'Vehicles',
  providers: 'Rental businesses',
  customers: 'Customer accounts',
  customer_spend: 'Customer points',
  messages: 'Conversations',
  notifications: 'Notifications',
  support: 'Support messages',
  fleet_requests: 'Fleet requests',
  audit_log: 'Audit log',
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
  run: (db: Database) => Promise<{ cleared: number; detail: string; breakdown?: Partial<Record<OneKind, number>> }>;
};

type Counted =
  | typeof bookings
  | typeof deposits
  | typeof payouts
  | typeof vehicles
  | typeof providers
  | typeof ledgerEntries
  | typeof rewardLedger
  | typeof customers;
const countOf = async (db: Database, table: Counted) => (await db.select({ value: count() }).from(table))[0]?.value ?? 0;

const PLANS: Record<OneKind, Plan> = {
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

  // The Refunds queue. The bookings stay, and refunds already made stay made.
  refunds: {
    removesFrom: ['refund_requests'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(refundRequests).returning({ id: refundRequests.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} refund request(s) cleared from the Refunds queue. Refunds already made at Stripe stay made, and their lines stay on the Payments screen.`,
      };
    },
  },

  // The Disputes queue. The bookings stay.
  disputes: {
    removesFrom: ['disputes'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(disputes).returning({ id: disputes.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} dispute(s) cleared. The bookings they were about are untouched.`,
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
      'reviews',
      'provider_members',
      'provider_business_profiles',
      'provider_payout_accounts',
      'provider_integrations',
      'business_promotions',
      'fleet_imports',
      'fleet_requests',
      'fleet_request_files',
      'chat_threads',
      'chat_messages',
      'chat_thread_settings',
      'calls',
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

  // Customer accounts, with everything that is only theirs: sign-ins, saved
  // cars, conversations, notifications, points, reviews, devices. Somebody who
  // runs a rental business is KEPT — the business cannot be left without its
  // owner — until rental businesses are cleared.
  customers: {
    removesFrom: [
      'customers',
      'credentials',
      'sessions',
      'auth_tokens',
      'phone_challenges',
      'devices',
      'notification_preferences',
      'push_tickets',
      'saved_cars',
      'reviews',
      'reward_ledger',
      'notifications',
      'support_messages',
      'chat_threads',
      'chat_messages',
      'chat_thread_settings',
      'calls',
    ],
    blockedBy: async (db) =>
      (await countOf(db, bookings)) > 0
        ? 'Customer accounts cannot be cleared while bookings point at them. Clear deposits, then bookings, then customer accounts.'
        : null,
    run: async (db) => {
      const gone = await db
        .delete(customers)
        .where(notInArray(customers.id, db.select({ id: providerMembers.customerId }).from(providerMembers)))
        .returning({ id: customers.id });
      const kept = await countOf(db, customers);
      return {
        cleared: gone.length,
        detail:
          `${gone.length} customer account(s) cleared, with their sign-ins, saved cars, conversations, notifications and points. ` +
          (kept > 0
            ? `${kept} account(s) are kept because they run a rental business; clear rental businesses first to remove those too. `
            : '') +
          'Anybody cleared can sign up again with the same email address.',
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

  // Conversations between renters and businesses, with their messages and calls.
  messages: {
    removesFrom: ['chat_threads', 'chat_messages', 'chat_thread_settings', 'calls'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(chatThreads).returning({ id: chatThreads.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} conversation(s) cleared, with their messages and call records. Texts and calls already made stay made.`,
      };
    },
  },

  // The in-app notification lists.
  notifications: {
    removesFrom: ['notifications'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(notifications).returning({ id: notifications.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} notification(s) cleared from people's in-app lists. Pushes and emails already sent stay sent.`,
      };
    },
  },

  // The Support inbox, and the record of who was helped by the assistant.
  support: {
    removesFrom: ['support_messages', 'support_interactions'],
    blockedBy: async () => null,
    run: async (db) => {
      const messages = await db.delete(supportMessages).returning({ id: supportMessages.id });
      const interactions = await db.delete(supportInteractions).returning({ id: supportInteractions.id });
      return {
        cleared: messages.length + interactions.length,
        detail: `${messages.length} support message(s) and ${interactions.length} support record(s) cleared. Emails already sent stay sent.`,
      };
    },
  },

  // Fleet requests sent in by businesses, with the files attached to them.
  fleet_requests: {
    removesFrom: ['fleet_requests', 'fleet_request_files'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(fleetRequests).returning({ id: fleetRequests.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} fleet request(s) cleared, with their attached files. Cars already added from them stay.`,
      };
    },
  },

  // Every entry in the audit log, none kept. Nothing is written in its place.
  audit_log: {
    removesFrom: ['audit_log'],
    blockedBy: async () => null,
    run: async (db) => {
      const gone = await db.delete(auditLog).returning({ id: auditLog.id });
      return {
        cleared: gone.length,
        detail: `${gone.length} audit entry(ies) cleared.`,
      };
    },
  },
};

// The order Everything clears in: what points at something goes before the
// thing it points at, so no step is ever refused. The audit log is last of all.
const EVERYTHING_ORDER: OneKind[] = [
  'deposits',
  'refunds',
  'disputes',
  'payments',
  'payouts',
  'bookings',
  'customer_spend',
  'messages',
  'notifications',
  'support',
  'fleet_requests',
  'vehicles',
  'providers',
  'customers',
  'audit_log',
];

// A step that fails says which one it was, in a sentence. The transaction around
// it undoes everything, so "nothing was changed" is true when this is thrown.
async function withFailureNamed<T>(what: OneKind, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = new AppError(
      500,
      'clear_failed',
      `Clearing stopped at ${LABELS[what].toLowerCase()}, which the database would not let go. Nothing was changed.`,
    );
    failure.cause = error;
    throw failure;
  }
}

const EVERYTHING: Plan = {
  removesFrom: [...new Set(EVERYTHING_ORDER.flatMap((what) => PLANS[what].removesFrom))],
  blockedBy: async () => null,
  run: async (db) => {
    const breakdown: Partial<Record<OneKind, number>> = {};
    for (const what of EVERYTHING_ORDER) {
      breakdown[what] = (await withFailureNamed(what, () => PLANS[what].run(db))).cleared;
    }
    const cleared = Object.values(breakdown).reduce((sum, value) => sum + (value ?? 0), 0);
    const said = EVERYTHING_ORDER.filter((what) => (breakdown[what] ?? 0) > 0).map(
      (what) => `${breakdown[what]} ${LABELS[what].toLowerCase()}`,
    );
    return {
      cleared,
      breakdown,
      detail:
        (said.length > 0 ? `Everything is cleared: ${said.join(', ')}. ` : 'There was nothing to clear. ') +
        'Staff accounts and platform settings are kept. ' +
        'Money at Stripe, photo files in Cloudinary, and texts and emails already sent are not touched by this.',
    };
  },
};

const planFor = (what: Clearable) => (what === 'everything' ? EVERYTHING : PLANS[what]);

// The rows that must survive a clear, to prove it left them be.
async function guardedCounts(db: Database) {
  const [audit] = await db.select({ value: count() }).from(auditLog);
  const [staff] = await db.select({ value: count() }).from(adminStaff);
  const [settings] = await db.select({ value: count() }).from(platformSettings);
  return { audit: audit?.value ?? 0, staff: staff?.value ?? 0, settings: settings?.value ?? 0 };
}

export function createTestDataService(deps: { db: Database; config: Config }) {
  const { db, config } = deps;
  return {
    // Whether clearing is open and why, and the kinds the panel can offer.
    async status(actor: AdminActor) {
      requireTier(actor, 'godfather');
      return {
        ...(await testResetStatus(db, config)),
        kinds: CLEARABLE.map((what) => ({ what, label: LABELS[what] })),
      };
    },

    // reason is accepted because the panel asks for one, and is not recorded.
    async clear(actor: AdminActor, input: { what: Clearable; reason: string }) {
      requireTier(actor, 'godfather');
      await assertOpen(db, config);
      const plan = planFor(input.what);
      const touched = plan.removesFrom.filter((table) => ALWAYS_KEPT.has(table));
      if (touched.length > 0) throw new Error(`A clear may never touch ${touched.join(', ')}`);
      const clearsTheLog = plan.removesFrom.includes('audit_log');

      const blocked = await plan.blockedBy(db);
      if (blocked) {
        throw conflict('would_take_more', `${blocked} Nothing was changed. "Everything" clears it all at once, in the right order.`);
      }

      return db.transaction(async (tx) => {
        const t = tx as unknown as Database;
        const before = await guardedCounts(t);
        // Everything names its own failing step; a single kind is named here.
        const result = await (input.what === 'everything' ? plan.run(t) : withFailureNamed(input.what, () => plan.run(t)));
        const after = await guardedCounts(t);
        if (before.staff !== after.staff || before.settings !== after.settings) {
          throw new Error('A clear changed the staff accounts or the platform settings; undone.');
        }
        if (!clearsTheLog && before.audit !== after.audit) {
          throw new Error('A clear changed the audit log without being asked to; undone.');
        }
        // No audit entry, no note: see "NOTHING IS LEFT BEHIND" at the top.
        return {
          what: input.what,
          cleared: result.cleared,
          detail: result.detail,
          ...(result.breakdown ? { breakdown: result.breakdown } : {}),
        };
      });
    },
  };
}

export type TestDataService = ReturnType<typeof createTestDataService>;
