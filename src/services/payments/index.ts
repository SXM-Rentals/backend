// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: All the rules about money — starting the payment for a
// rental, placing the hold for a security deposit, letting that hold go or
// keeping part of it after a claim, and dealing with the messages Stripe sends
// back when something actually happens on a card.
//
// THE MOST IMPORTANT RULE IN THIS FILE: a security deposit is never revenue.
// It is a separate payment, only ever authorised (held) and not taken, tracked
// on its own table with its own life cycle, and it never touches the booking's
// total, the commission or what a business is paid. Keeping any part of one
// requires a written reason, and the database refuses a claim without one.
//
// WHY THE REAL WORK HAPPENS IN THE WEBHOOK: a card can be declined, or need the
// bank's approval, after the customer has left the page. Stripe telling us
// afterwards is the only trustworthy account of what happened, so nothing is
// marked paid or held until Stripe says so — never because an app said it went
// through. Stripe also sends the same message again if it is unsure we received
// it, so every message is recorded and a repeat is ignored.

import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  bookings,
  customers,
  deposits,
  ledgerEntries,
  processedWebhookEvents,
  providerPayoutAccounts,
} from '../../db/schema/index.js';
import { holdExpiresAt, holdWindowOpensAt } from './holds.js';
import type { PaymentGateway, WebhookEvent } from '../../lib/stripe.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';

type Logger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

// Told when money actually moves, so the customer hears about it. Optional: a
// payment is never failed because a message could not be sent.
export type PaymentNotifier = {
  paymentSucceeded(bookingId: string): Promise<void>;
  paymentFailed(bookingId: string): Promise<void>;
  depositReleased(depositId: string): Promise<void>;
  depositClaimed(depositId: string): Promise<void>;
};

export type PaymentServiceDeps = {
  db: Database;
  gateway: PaymentGateway;
  logger: Logger;
  notifications?: PaymentNotifier;
};

// What an app is given so it can finish the payment on the customer's device.
export type PaymentStart = {
  paymentId: string;
  clientSecret: string;
  status: string;
  amount: number;
};

const toAmount = (cents: number) => cents / 100;

export function createPaymentService(deps: PaymentServiceDeps) {
  const { db, gateway, logger, notifications } = deps;

  // ---- ONE OF YOUR OWN BOOKINGS ----
  // Somebody else's booking is "not found", exactly like one that never existed.
  async function loadOwnBooking(actor: Actor, bookingId: string) {
    if (!isUuid(bookingId)) throw notFound('We could not find that booking.');
    const [booking] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.customerId, actor.customerId)))
      .limit(1);
    if (!booking) throw notFound('We could not find that booking.');
    if (booking.status === 'cancelled') {
      throw conflict('booking_cancelled', 'That booking has been cancelled.');
    }
    return booking;
  }

  // The customer's record at Stripe, made the first time it is needed — when
  // they save a card — and never before, so nobody gets a Stripe record just
  // for looking at an empty list.
  async function stripeCustomerFor(actor: Actor, options: { create: boolean }): Promise<string | null> {
    const [customer] = await db.select().from(customers).where(eq(customers.id, actor.customerId)).limit(1);
    if (!customer) throw notFound();
    if (customer.stripeCustomerId || !options.create) return customer.stripeCustomerId;

    const created = await gateway.createCustomer({
      customerId: customer.id,
      email: customer.email,
      name: `${customer.firstName} ${customer.lastName}`,
    });
    await db.update(customers).set({ stripeCustomerId: created.id }).where(eq(customers.id, customer.id));
    return created.id;
  }

  return {
    // ---- PAYING FOR THE RENTAL ----
    // Asking twice gives the same payment back rather than starting a second.
    async startRentalPayment(actor: Actor, bookingId: string): Promise<PaymentStart> {
      const booking = await loadOwnBooking(actor, bookingId);
      if (booking.paymentStatus === 'paid') {
        throw conflict('already_paid', 'That booking has already been paid for.');
      }

      if (booking.stripePaymentIntentId) {
        const existing = await gateway.getPayment(booking.stripePaymentIntentId);
        if (existing && existing.status !== 'canceled') {
          return { ...existing, paymentId: existing.id, amount: toAmount(booking.totalDueTodayCents) };
        }
      }

      const payment = await gateway.createRentalPayment({
        bookingId: booking.id,
        bookingReference: booking.reference,
        amountCents: booking.totalDueTodayCents,
      });
      await db
        .update(bookings)
        .set({ stripePaymentIntentId: payment.id })
        .where(eq(bookings.id, booking.id));

      return { ...payment, paymentId: payment.id, amount: toAmount(booking.totalDueTodayCents) };
    },

    // ---- HOLDING THE SECURITY DEPOSIT ----
    // A separate payment that is authorised and never taken. The money stays
    // the customer's; it is simply set aside on their card.
    async startDepositHold(actor: Actor, bookingId: string): Promise<PaymentStart> {
      const booking = await loadOwnBooking(actor, bookingId);
      const [deposit] = await db.select().from(deposits).where(eq(deposits.bookingId, booking.id)).limit(1);
      if (!deposit) throw notFound('That booking has no security deposit.');
      if (deposit.status === 'held') throw conflict('deposit_already_held', 'That deposit is already being held.');
      if (deposit.status === 'claimed') throw conflict('deposit_claimed', 'That deposit has already been settled.');
      if (booking.status === 'completed') {
        throw conflict('booking_finished', 'That rental is over, so there is no deposit to hold.');
      }

      // Not before the two days before pickup: a hold placed earlier would be
      // dropped by the bank before the car was even collected.
      const opensAt = holdWindowOpensAt(booking.startDate, booking.pickupTime);
      if (Date.now() < opensAt.getTime()) {
        throw conflict(
          'too_early',
          `The deposit can be held from ${opensAt.toISOString().slice(0, 16).replace('T', ' at ')} (UTC), two days before pickup. A hold on a card only lasts about a week, so placing it sooner would mean it had gone before you collected the car.`,
        );
      }

      if (deposit.stripePaymentIntentId) {
        const existing = await gateway.getPayment(deposit.stripePaymentIntentId);
        if (existing && existing.status !== 'canceled') {
          return { ...existing, paymentId: existing.id, amount: toAmount(deposit.amountCents) };
        }
      }

      const payment = await gateway.createDepositHold({
        bookingId: booking.id,
        bookingReference: booking.reference,
        depositId: deposit.id,
        amountCents: deposit.amountCents,
      });
      await db.update(deposits).set({ stripePaymentIntentId: payment.id }).where(eq(deposits.id, deposit.id));

      return { ...payment, paymentId: payment.id, amount: toAmount(deposit.amountCents) };
    },

    // ---- SAVED CARDS ----
    // Kept at Stripe, on the customer's own Stripe record. This server holds
    // the id of that record and nothing else about any card: the app is told the
    // brand, the last four digits and the expiry, which is all Stripe gives us.
    async listCards(actor: Actor) {
      const stripeCustomerId = await stripeCustomerFor(actor, { create: false });
      if (!stripeCustomerId) return [];
      return gateway.listCards(stripeCustomerId);
    },

    // The secret the app hands to Stripe's own form in "save a card" mode.
    async startCardSetup(actor: Actor) {
      const stripeCustomerId = await stripeCustomerFor(actor, { create: true });
      return gateway.createCardSetup(stripeCustomerId!);
    },

    // Another customer's card is "not found", exactly like one that never
    // existed — the same rule as every other record here.
    async removeCard(actor: Actor, cardId: string) {
      const stripeCustomerId = await stripeCustomerFor(actor, { create: false });
      if (!stripeCustomerId || !(await gateway.removeCard(stripeCustomerId, cardId))) {
        throw notFound('We could not find that card.');
      }
    },

    async makeDefaultCard(actor: Actor, cardId: string) {
      const stripeCustomerId = await stripeCustomerFor(actor, { create: false });
      if (!stripeCustomerId || !(await gateway.setDefaultCard(stripeCustomerId, cardId))) {
        throw notFound('We could not find that card.');
      }
      return gateway.listCards(stripeCustomerId);
    },

    // ---- THE DEPOSIT, SEEN BY THE CUSTOMER ----
    async getDepositFor(actor: Actor, bookingId: string) {
      const booking = await loadOwnBooking(actor, bookingId);
      const [deposit] = await db.select().from(deposits).where(eq(deposits.bookingId, booking.id)).limit(1);
      if (!deposit) throw notFound('That booking has no security deposit.');
      // When the bank will drop the hold, and whether that is before the car is
      // due back — on a long rental it can be, and the customer should hear it
      // from us rather than notice a missing hold.
      const expires = deposit.status === 'held' ? holdExpiresAt(deposit.authorizedAt) : null;
      return {
        amount: toAmount(deposit.amountCents),
        status: deposit.status,
        heldSince: deposit.authorizedAt?.toISOString() ?? null,
        holdExpiresAt: expires?.toISOString() ?? null,
        expiresBeforeReturn: expires ? expires.toISOString().slice(0, 10) <= booking.endDate : false,
        // When the customer may place the hold, so the app can say so rather
        // than offer a button that will be refused.
        holdOpensAt: holdWindowOpensAt(booking.startDate, booking.pickupTime).toISOString(),
        releasedAt: deposit.releasedAt?.toISOString() ?? null,
        // Shown only when part of it was kept, always with the written reason.
        ...(deposit.status === 'claimed'
          ? {
              claimedAmount: toAmount(deposit.claimedAmountCents ?? deposit.amountCents),
              claimReason: deposit.claimReason,
            }
          : {}),
      };
    },

    // ---- GIVING A DEPOSIT BACK ----
    // The ordinary ending: the car comes back, the hold is let go.
    async releaseDeposit(depositId: string) {
      const deposit = await loadDeposit(db, depositId);
      if (deposit.status === 'released') return;
      if (deposit.status === 'claimed') throw conflict('deposit_claimed', 'That deposit has already been settled.');

      if (deposit.stripePaymentIntentId) await gateway.cancelDepositHold(deposit.stripePaymentIntentId);
      await db
        .update(deposits)
        .set({ status: 'released', releasedAt: new Date() })
        .where(eq(deposits.id, deposit.id));

      await notifications?.depositReleased(deposit.id);
    },

    // ---- KEEPING PART OF A DEPOSIT ----
    // The most disputable thing this platform can do, so: never more than was
    // held, never without a written reason, and always recorded as its own
    // ledger line rather than quietly folded into revenue.
    async claimDeposit(depositId: string, input: { reason: string; amountCents: number }) {
      const deposit = await loadDeposit(db, depositId);
      if (deposit.status !== 'held') {
        throw conflict('deposit_not_held', 'A deposit can only be claimed while it is being held.');
      }
      if (!input.reason.trim()) {
        throw badRequest('reason_required', 'A written reason is required to keep any part of a deposit.');
      }
      if (input.amountCents <= 0 || input.amountCents > deposit.amountCents) {
        throw badRequest('invalid_amount', 'The amount kept has to be between nothing and the whole deposit.');
      }

      if (deposit.stripePaymentIntentId) {
        await gateway.captureDepositHold(deposit.stripePaymentIntentId, input.amountCents);
      }
      await db
        .update(deposits)
        .set({
          status: 'claimed',
          claimedAt: new Date(),
          claimReason: input.reason.trim(),
          claimedAmountCents: input.amountCents,
        })
        .where(eq(deposits.id, deposit.id));

      // Always tell the customer, with the reason that was written down.
      await notifications?.depositClaimed(deposit.id);
    },

    // ---- WHAT STRIPE TELLS US AFTERWARDS ----
    // Runs once per message. A repeat is recognised and ignored.
    async handleStripeEvent(event: WebhookEvent): Promise<{ handled: boolean }> {
      const firstTime = await db
        .insert(processedWebhookEvents)
        .values({ id: event.id, type: event.type })
        .onConflictDoNothing()
        .returning({ id: processedWebhookEvents.id });
      if (firstTime.length === 0) {
        logger.info({ eventId: event.id, type: event.type }, 'Stripe message already handled; ignoring repeat');
        return { handled: false };
      }

      const object = event.data.object;
      const metadata = (object.metadata ?? {}) as Record<string, string>;
      const paymentId = typeof object.id === 'string' ? object.id : undefined;
      const amountCents = typeof object.amount === 'number' ? object.amount : 0;
      if (!paymentId) return { handled: true };

      switch (event.type) {
        // The rental has been paid for.
        case 'payment_intent.succeeded': {
          if (metadata.kind !== 'rental') break;
          await db
            .update(bookings)
            .set({ paymentStatus: 'paid' })
            .where(eq(bookings.stripePaymentIntentId, paymentId));
          await recordLedgerEntry(db, metadata.bookingId, 'charge', amountCents, 'succeeded', paymentId);
          if (metadata.bookingId) await notifications?.paymentSucceeded(metadata.bookingId);
          break;
        }

        // The card was declined, or the bank's approval was not given.
        case 'payment_intent.payment_failed': {
          if (metadata.kind !== 'rental') break;
          await db
            .update(bookings)
            .set({ paymentStatus: 'failed' })
            .where(eq(bookings.stripePaymentIntentId, paymentId));
          await recordLedgerEntry(db, metadata.bookingId, 'charge', amountCents, 'failed', paymentId);
          if (metadata.bookingId) await notifications?.paymentFailed(metadata.bookingId);
          break;
        }

        // The deposit hold is now in place on the customer's card. THIS IS NOT
        // A PAYMENT: nothing has been taken, and nothing is recorded as revenue.
        case 'payment_intent.amount_capturable_updated': {
          if (metadata.kind !== 'deposit') break;
          await db
            .update(deposits)
            .set({ status: 'held', authorizedAt: new Date() })
            .where(eq(deposits.stripePaymentIntentId, paymentId));
          break;
        }

        // A hold that has been let go, whether by us or by Stripe expiring it.
        case 'payment_intent.canceled': {
          if (metadata.kind !== 'deposit') break;
          await db
            .update(deposits)
            .set({ status: 'released', releasedAt: new Date() })
            .where(eq(deposits.stripePaymentIntentId, paymentId));
          break;
        }

        // Rental money given back.
        case 'charge.refunded': {
          const refundedIntent = typeof object.payment_intent === 'string' ? object.payment_intent : paymentId;
          const [booking] = await db
            .select({ id: bookings.id })
            .from(bookings)
            .where(eq(bookings.stripePaymentIntentId, refundedIntent))
            .limit(1);
          if (!booking) break;
          await db.update(bookings).set({ paymentStatus: 'refunded' }).where(eq(bookings.id, booking.id));
          await recordLedgerEntry(db, booking.id, 'refund', amountCents, 'succeeded', refundedIntent);
          break;
        }

        // A rental business has given Stripe more of its details, so what it
        // is still waiting for — and whether they can be paid — has changed.
        case 'account.updated': {
          const payoutsEnabled = object.payouts_enabled === true;
          const requirements = object.requirements as { currently_due?: string[] } | undefined;
          const outstanding = requirements?.currently_due ?? [];
          await db
            .update(providerPayoutAccounts)
            .set({
              payoutsEnabled,
              outstanding,
              status: payoutsEnabled ? 'active' : outstanding.length > 0 ? 'pending' : 'restricted',
            })
            .where(eq(providerPayoutAccounts.stripeAccountId, paymentId));
          break;
        }

        default:
          logger.info({ type: event.type }, 'Stripe message of a kind we do not act on');
      }

      return { handled: true };
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;

// ---- SHARED HELPERS ----

async function loadDeposit(db: Database, depositId: string) {
  if (!isUuid(depositId)) throw notFound('We could not find that deposit.');
  const [deposit] = await db.select().from(deposits).where(eq(deposits.id, depositId)).limit(1);
  if (!deposit) throw notFound('We could not find that deposit.');
  return deposit;
}

// Every movement of money gets its own line, so the payments screens and the
// accounts can be reconciled against Stripe later.
async function recordLedgerEntry(
  db: Database,
  bookingId: string | undefined,
  kind: 'charge' | 'refund',
  amountCents: number,
  status: 'succeeded' | 'failed',
  stripeRef: string,
) {
  await db.insert(ledgerEntries).values({
    bookingId: bookingId && isUuid(bookingId) ? bookingId : null,
    kind,
    amountCents,
    status,
    stripeRef,
    occurredAt: new Date(),
  });
}
