// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Deletes ONE test record — one booking, one payment line,
// one audit entry and so on — for the Godfather's Test Data screens, where the
// whole-kind clear is too blunt: somebody who made one test booking too many
// should not have to wipe every booking to be rid of it.
//
// It is the clear, one row wide, ON THE SAME TERMS. The gates are the clear's own
// and are applied by test-data.ts, not here: Godfather only, the authenticator
// code, the ALLOW_TEST_RESET + Stripe-never-live window, the same rate limit.
// A delete that is easier to reach than a clear would be a clear with the
// safeguards taken off.
//
// DO NOT CASCADE. Where the database will not let one record go without
// another (a booking cannot go while a deposit points at it), this refuses and
// says what would have to go first — in the words the panel prints — rather than
// taking more than was asked. Nothing is changed when it refuses. What a record
// OWNS (a booking's price lines and signature, a car's photos and papers) goes
// with it, exactly as it does in the whole-kind clear.
//
// NOTHING IS LEFT BEHIND: no audit entry, and deleting an audit entry leaves no
// note in its place. No entry is protected, including the ones an earlier version
// wrote to record a clearing.

import { count, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  bookings,
  customers,
  deposits,
  disputes,
  fleetRequests,
  ledgerEntries,
  payouts,
  providerMembers,
  providers,
  refundRequests,
  supportInteractions,
  supportMessages,
  vehicles,
} from '../../db/schema/index.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';

// The kinds a single record can be deleted from. Not "everything", and not
// customer points (a figure on an account, not a row); a whole business has its
// own address.
export const SINGLE_KINDS = [
  'bookings',
  'payments',
  'payouts',
  'deposits',
  'refunds',
  'disputes',
  'vehicles',
  'customers',
  'support',
  'fleet_requests',
  'audit_log',
] as const;
export type SingleKind = (typeof SINGLE_KINDS)[number];

type SinglePlan = {
  // What the record is called in a sentence: "the booking".
  noun: string;
  // What the record is named: "booking SXM-4801". Null when there is no such record.
  find: (db: Database, id: string) => Promise<string | null>;
  // Refuses with a sentence when the database would make this take more.
  blockedBy: (db: Database, id: string) => Promise<string | null>;
  run: (db: Database, id: string, name: string) => Promise<string>;
};

const capitalised = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
const nothingBlocks = async () => null;
const howMany = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function countWhere(db: Database, table: typeof bookings | typeof deposits, column: typeof bookings.customerId | typeof bookings.vehicleId | typeof deposits.bookingId, id: string) {
  return (await db.select({ value: count() }).from(table).where(eq(column, id)))[0]?.value ?? 0;
}

const PLANS: Record<SingleKind, SinglePlan> = {
  // The booking and its own history (price lines, signatures, date changes,
  // reviews, notifications about it, and its refund requests and disputes). Its
  // payment lines are KEPT, no longer linked to a booking.
  bookings: {
    noun: 'booking',
    find: async (db, id) => {
      const [row] = await db.select({ reference: bookings.reference }).from(bookings).where(eq(bookings.id, id)).limit(1);
      return row ? `booking ${row.reference}` : null;
    },
    blockedBy: async (db, id) =>
      (await countWhere(db, deposits, deposits.bookingId, id)) > 0
        ? 'This booking has a deposit held against it. Delete the deposit first.'
        : null,
    run: async (db, id, name) => {
      const detached = await db
        .update(ledgerEntries)
        .set({ bookingId: null })
        .where(eq(ledgerEntries.bookingId, id))
        .returning({ id: ledgerEntries.id });
      await db.delete(refundRequests).where(eq(refundRequests.bookingId, id));
      await db.delete(disputes).where(eq(disputes.bookingId, id));
      await db.delete(bookings).where(eq(bookings.id, id));
      return (
        `${capitalised(name)} deleted, with its price lines, signature and any refund requests and disputes about it. ` +
        (detached.length > 0
          ? `Its ${howMany(detached.length, 'payment line')} ${detached.length === 1 ? 'is' : 'are'} kept on the Payments screen, no longer linked to a booking. `
          : '') +
        'Revenue on the dashboard and Analytics is worked out from bookings, so it now reads without this one.'
      );
    },
  },

  payments: {
    noun: 'payment line',
    find: async (db, id) => {
      const [row] = await db.select({ ref: ledgerEntries.stripeRef }).from(ledgerEntries).where(eq(ledgerEntries.id, id)).limit(1);
      return row ? `payment line ${row.ref}` : null;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      await db.delete(ledgerEntries).where(eq(ledgerEntries.id, id));
      return `${capitalised(name)} deleted. The booking it was for is untouched.`;
    },
  },

  // The booking it covered counts as owed again.
  payouts: {
    noun: 'payout',
    find: async (db, id) => {
      const [row] = await db.select({ reference: payouts.reference }).from(payouts).where(eq(payouts.id, id)).limit(1);
      return row ? `payout ${row.reference}` : null;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      const owedAgain = await db
        .update(bookings)
        .set({ payoutId: null })
        .where(eq(bookings.payoutId, id))
        .returning({ id: bookings.id });
      await db.delete(payouts).where(eq(payouts.id, id));
      return (
        `${capitalised(name)} deleted. The ${howMany(owedAgain.length, 'booking')} it covered count as owed again, ` +
        'so the next daily run gathers them into a new payout. Money already sent through Stripe is not taken back.'
      );
    },
  },

  deposits: {
    noun: 'deposit',
    find: async (db, id) => {
      const [row] = await db
        .select({ reference: bookings.reference })
        .from(deposits)
        .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
        .where(eq(deposits.id, id))
        .limit(1);
      return row ? `deposit for booking ${row.reference}` : null;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      await db.delete(deposits).where(eq(deposits.id, id));
      return `${capitalised(name)} deleted. Any hold still placed at Stripe stays there until it expires or is released in Stripe.`;
    },
  },

  refunds: {
    noun: 'refund request',
    find: async (db, id) => {
      const [row] = await db
        .select({ reference: bookings.reference })
        .from(refundRequests)
        .innerJoin(bookings, eq(bookings.id, refundRequests.bookingId))
        .where(eq(refundRequests.id, id))
        .limit(1);
      return row ? `refund request for booking ${row.reference}` : null;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      await db.delete(refundRequests).where(eq(refundRequests.id, id));
      return `${capitalised(name)} deleted from the Refunds queue. A refund already made at Stripe stays made, and its line stays on the Payments screen.`;
    },
  },

  disputes: {
    noun: 'dispute',
    find: async (db, id) => {
      const [row] = await db.select({ reference: disputes.reference }).from(disputes).where(eq(disputes.id, id)).limit(1);
      return row ? `dispute ${row.reference}` : null;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      await db.delete(disputes).where(eq(disputes.id, id));
      return `${capitalised(name)} deleted. The booking it was about is untouched.`;
    },
  },

  // The car, with its photo records, papers, blocked days and accident history.
  vehicles: {
    noun: 'vehicle',
    find: async (db, id) => {
      const [row] = await db
        .select({ reference: vehicles.reference, make: vehicles.make, model: vehicles.model, year: vehicles.year })
        .from(vehicles)
        .where(eq(vehicles.id, id))
        .limit(1);
      return row ? `vehicle ${row.reference} (${row.year} ${row.make} ${row.model})` : null;
    },
    blockedBy: async (db, id) => {
      const n = await countWhere(db, bookings, bookings.vehicleId, id);
      return n > 0 ? `This vehicle has ${howMany(n, 'booking')} against it. Delete ${n === 1 ? 'that booking' : 'those bookings'} first.` : null;
    },
    run: async (db, id, name) => {
      await db.delete(vehicles).where(eq(vehicles.id, id));
      return `${capitalised(name)} deleted, with its photo records, papers, blocked days and accident history. Photo files stay in Cloudinary.`;
    },
  },

  // The person, with what is only theirs: sign-ins, saved cars, conversations,
  // notifications, points, devices. Refused while they have bookings, or run a
  // rental business — the business would be left without its owner.
  customers: {
    noun: 'customer',
    find: async (db, id) => {
      const [row] = await db
        .select({ firstName: customers.firstName, lastName: customers.lastName, email: customers.email })
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1);
      return row ? `${row.firstName} ${row.lastName} (${row.email})` : null;
    },
    blockedBy: async (db, id) => {
      const n = await countWhere(db, bookings, bookings.customerId, id);
      if (n > 0) return `This person has ${howMany(n, 'booking')}. Delete ${n === 1 ? 'that booking' : 'those bookings'} first.`;
      const runs = await db
        .select({ name: providers.businessName })
        .from(providerMembers)
        .innerJoin(providers, eq(providers.id, providerMembers.providerId))
        .where(eq(providerMembers.customerId, id));
      return runs.length > 0
        ? `This person runs a rental business (${runs.map((business) => business.name).join(', ')}). Delete the business first.`
        : null;
    },
    run: async (db, id, name) => {
      await db.delete(customers).where(eq(customers.id, id));
      return `${name} deleted, with their sign-ins, saved cars, conversations, notifications and points. They can sign up again with the same email address.`;
    },
  },

  // A support conversation IS the customer's thread, so the id is the customer's.
  support: {
    noun: 'support conversation',
    find: async (db, id) => {
      const [messages] = await db.select({ value: count() }).from(supportMessages).where(eq(supportMessages.customerId, id));
      const [records] = await db.select({ value: count() }).from(supportInteractions).where(eq(supportInteractions.customerId, id));
      if ((messages?.value ?? 0) + (records?.value ?? 0) === 0) return null;
      const [person] = await db
        .select({ firstName: customers.firstName, lastName: customers.lastName })
        .from(customers)
        .where(eq(customers.id, id))
        .limit(1);
      return `support conversation with ${person ? `${person.firstName} ${person.lastName}` : 'that customer'}`;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      const messages = await db.delete(supportMessages).where(eq(supportMessages.customerId, id)).returning({ id: supportMessages.id });
      const records = await db.delete(supportInteractions).where(eq(supportInteractions.customerId, id)).returning({ id: supportInteractions.id });
      return `${capitalised(name)} deleted: ${howMany(messages.length, 'message')} and ${howMany(records.length, 'support record')}. Emails already sent stay sent.`;
    },
  },

  fleet_requests: {
    noun: 'fleet request',
    find: async (db, id) => {
      const [row] = await db
        .select({ name: providers.businessName })
        .from(fleetRequests)
        .innerJoin(providers, eq(providers.id, fleetRequests.providerId))
        .where(eq(fleetRequests.id, id))
        .limit(1);
      return row ? `fleet request from ${row.name}` : null;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      await db.delete(fleetRequests).where(eq(fleetRequests.id, id));
      return `${capitalised(name)} deleted, with its attached files. Cars already added from it stay.`;
    },
  },

  // Any entry at all, including one an earlier version wrote to record a
  // clearing. Nothing is written in its place.
  audit_log: {
    noun: 'audit entry',
    find: async (db, id) => {
      const [row] = await db.select({ subject: auditLog.subjectLabel, field: auditLog.field }).from(auditLog).where(eq(auditLog.id, id)).limit(1);
      return row ? `audit entry for ${row.subject} (${row.field})` : null;
    },
    blockedBy: nothingBlocks,
    run: async (db, id, name) => {
      await db.delete(auditLog).where(eq(auditLog.id, id));
      return `${capitalised(name)} deleted.`;
    },
  },
};

// Deletes the one record, inside the caller's transaction, and says what went.
// 404 when there is no such record, 409 would_take_more when something else
// would have to go with it; either way nothing has been changed.
export async function deleteOneRecord(db: Database, what: SingleKind, id: string): Promise<string> {
  const plan = PLANS[what];
  const missing = notFound(`We could not find that ${plan.noun}.`);
  if (!isUuid(id)) throw missing;
  const name = await plan.find(db, id);
  if (!name) throw missing;

  const blocked = await plan.blockedBy(db, id);
  if (blocked) throw conflict('would_take_more', `${blocked} Nothing was changed.`);

  try {
    return await plan.run(db, id, name);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = new AppError(
      500,
      'delete_failed',
      `The ${plan.noun} could not be deleted: the database would not let it go. Nothing was changed.`,
    );
    failure.cause = error;
    throw failure;
  }
}
