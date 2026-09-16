// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Works out what each rental business is owed and sends it
// to them. A payout gathers up the finished, paid-for bookings a business has
// not yet been paid for, adds up their share, and records one payment covering
// the lot.
//
// THREE RULES BUILT INTO THIS FILE:
//
// 1. SECURITY DEPOSITS ARE NEVER PAID OUT. Nothing here reads the deposits
//    table at all. A deposit is the customer's money, held and given back, so
//    it can never end up in a business's bank account by mistake.
//
// 2. A BOOKING IS PAID OUT ONCE. Each booking is stamped with the payout that
//    covered it, and only bookings with no stamp are gathered up — so running
//    a payout twice cannot pay for the same rental twice.
//
// 3. THE DEDUCTION IS ALWAYS VISIBLE. Every payout records what customers paid
//    (gross), what SXM Rentals kept (commission), and what the business gets
//    (amount) — and the database refuses a payout where those do not add up.
//
// Only bookings that are COMPLETED and PAID are included: money is sent after
// the rental has happened and the customer's payment actually arrived.

import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings, payouts, providerPayoutAccounts } from '../../db/schema/index.js';
import type { PaymentGateway } from '../../lib/stripe.js';
import { conflict, notFound } from '../../lib/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- WHEN THE NEXT PAYOUT RUNS ----
// Weekly, on a Monday. The dashboard shows this date so a business knows when
// to expect money rather than having to ask.
export function nextPayoutDate(from: Date = new Date()): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  // 1 = Monday. Always the next one, never today.
  const daysUntilMonday = ((8 - date.getUTCDay()) % 7) || 7;
  return new Date(date.getTime() + daysUntilMonday * DAY_MS).toISOString().slice(0, 10);
}

// The short code a business sees against a payment, e.g. PO-2026-0914.
function payoutReference(periodEnd: string): string {
  return `PO-${periodEnd.replace(/-/g, '').slice(0, 4)}-${periodEnd.replace(/-/g, '').slice(4)}`;
}

export type BuiltPayout = typeof payouts.$inferSelect;

// ---- GATHERING UP WHAT IS OWED ----
// Returns the payout that was created, or null when there is nothing to pay.
export async function buildPayout(
  db: Database,
  providerId: string,
  period: { start: string; end: string },
): Promise<BuiltPayout | null> {
  return db.transaction(async (tx) => {
    // Finished, paid for, and not yet paid out. Deposits are not read here.
    const owed = await tx
      .select({
        id: bookings.id,
        grossCents: bookings.grossCents,
        commissionCents: bookings.commissionCents,
        payoutCents: bookings.payoutCents,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.providerId, providerId),
          eq(bookings.status, 'completed'),
          eq(bookings.paymentStatus, 'paid'),
          isNull(bookings.payoutId),
          gte(bookings.endDate, period.start),
          lte(bookings.endDate, period.end),
        ),
      )
      .orderBy(asc(bookings.endDate));

    if (owed.length === 0) return null;

    const totals = owed.reduce(
      (sum, booking) => ({
        gross: sum.gross + booking.grossCents,
        commission: sum.commission + booking.commissionCents,
        amount: sum.amount + booking.payoutCents,
      }),
      { gross: 0, commission: 0, amount: 0 },
    );

    const [payout] = await tx
      .insert(payouts)
      .values({
        reference: `${payoutReference(period.end)}-${providerId.slice(0, 4)}`,
        providerId,
        amountCents: totals.amount,
        grossCents: totals.gross,
        commissionCents: totals.commission,
        bookingCount: owed.length,
        periodStart: period.start,
        periodEnd: period.end,
        status: 'pending',
      })
      .returning();
    if (!payout) throw new Error('Payout was not created');

    // Stamp each booking, so it can never be gathered into a second payout.
    for (const booking of owed) {
      await tx.update(bookings).set({ payoutId: payout.id }).where(eq(bookings.id, booking.id));
    }

    return payout;
  });
}

// ---- SENDING THE MONEY ----
// Stripe pays the business directly from their own connected account. We only
// ever ask for the transfer; their bank details never touch this server.
export async function sendPayout(db: Database, gateway: PaymentGateway, payoutId: string): Promise<void> {
  const [payout] = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1);
  if (!payout) throw notFound('We could not find that payout.');
  if (payout.status === 'paid') throw conflict('already_paid', 'That payout has already been sent.');

  const [account] = await db
    .select()
    .from(providerPayoutAccounts)
    .where(eq(providerPayoutAccounts.providerId, payout.providerId))
    .limit(1);
  if (!account?.stripeAccountId || !account.payoutsEnabled) {
    throw conflict(
      'payouts_not_enabled',
      'This business cannot be paid yet — they still have details to give Stripe.',
    );
  }

  await db.update(payouts).set({ status: 'processing' }).where(eq(payouts.id, payout.id));
  const transfer = await gateway.createTransfer({
    accountId: account.stripeAccountId,
    amountCents: payout.amountCents,
    reference: payout.reference,
  });

  await db
    .update(payouts)
    .set({ status: 'paid', paidOn: new Date(), stripeTransferId: transfer.id })
    .where(eq(payouts.id, payout.id));
}
