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
//
// THREE THINGS THAT GO WRONG IN REAL LIFE, AND WHAT HAPPENS:
//   - A message is late or lost. Asking to pay (or hold) again then checks with
//     Stripe first: a payment Stripe already has is recorded exactly as the
//     message would have recorded it, and the app is told it is done, rather
//     than being handed a finished payment that Stripe's card sheet refuses.
//   - A message is about a booking this database has never heard of — a copy of
//     the backend on somebody's computer sharing the same Stripe test account,
//     say. Nothing is written and Stripe is told it arrived, so it stops trying.
//   - Recording a message fails half way (the database hiccups). The message is
//     only marked handled in the same transaction as the work itself, so the
//     failure is answered 500 and Stripe's retry gets a second chance.
//
// Every "record" below changes something only if it has not happened yet, so the
// app's check and Stripe's message can both arrive and the payment is still
// recorded once.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  bookings,
  customers,
  dateChangeRequests,
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
        // Stripe already has the money and its message has not arrived (or was
        // lost): record it now, exactly as the message would have.
        if (existing?.status === 'succeeded') {
          const recorded = await recordRentalPaid(db, existing.id, booking.totalDueTodayCents);
          if (recorded.state === 'recorded') await notifications?.paymentSucceeded(recorded.bookingId);
          throw conflict('already_paid', 'That booking has already been paid for.');
        }
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
        // The hold is already on the card and Stripe's message has not arrived:
        // record it now, and never hand back a hold that is already in place.
        if (existing?.status === 'requires_capture' || existing?.status === 'succeeded') {
          if (existing.status === 'requires_capture') await recordDepositHeld(db, existing.id);
          throw conflict('deposit_already_held', 'That deposit is already being held.');
        }
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
    // Runs once per message. A repeat is recognised and ignored. The message is
    // marked handled in the same transaction as the work, so a failure part way
    // leaves it unmarked and Stripe's retry is not mistaken for a repeat.
    async handleStripeEvent(event: WebhookEvent): Promise<{ handled: boolean }> {
      // Telling the customer happens after the transaction has committed.
      let afterwards: (() => Promise<void>)[] = [];
      try {
        await db.transaction(async (tx) => {
          const firstTime = await tx
            .insert(processedWebhookEvents)
            .values({ id: event.id, type: event.type })
            .onConflictDoNothing()
            .returning({ id: processedWebhookEvents.id });
          if (firstTime.length === 0) throw new Repeat();
          afterwards = await applyStripeEvent(tx as unknown as Database, event, notifications, logger);
        });
      } catch (error) {
        if (error instanceof Repeat) {
          logger.info({ eventId: event.id, type: event.type }, 'Stripe message already handled; ignoring repeat');
          return { handled: false };
        }
        if (error instanceof NotOurs) {
          // Rolled back: nothing about it is kept, not even that it came.
          logger.info(
            { eventId: event.id, type: event.type },
            'Stripe message about a payment this database does not have; ignored',
          );
          return { handled: false };
        }
        throw error;
      }
      for (const tell of afterwards) {
        await tell().catch((error: unknown) =>
          logger.warn({ error: String(error) }, 'Could not tell the customer about a payment'),
        );
      }
      return { handled: true };
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;

// ---- SHARED HELPERS ----

// A message Stripe already sent, and we already handled.
class Repeat extends Error {}
// A message about a payment this database has no record of.
class NotOurs extends Error {}

type Recorded = { state: 'recorded'; bookingId: string } | { state: 'already' } | { state: 'unknown' };

// ---- RECORDING WHAT HAPPENED ----
// Shared by Stripe's messages and by the check made when somebody asks to pay
// again, so the two can never record the same payment differently. Each one
// changes something only if it has not happened yet.

// The rental is paid for.
export async function recordRentalPaid(db: Database, paymentId: string, amountCents: number): Promise<Recorded> {
  const [paid] = await db
    .update(bookings)
    .set({ paymentStatus: 'paid' })
    .where(and(eq(bookings.stripePaymentIntentId, paymentId), inArray(bookings.paymentStatus, ['authorized', 'failed'])))
    .returning({ id: bookings.id });
  if (paid) {
    await recordLedgerEntry(db, paid.id, 'charge', amountCents, 'succeeded', paymentId);
    return { state: 'recorded', bookingId: paid.id };
  }
  return (await bookingWithPayment(db, paymentId)) ? { state: 'already' } : { state: 'unknown' };
}

// The extra days of a longer rental are paid for.
export async function recordDateChangePaid(db: Database, paymentId: string, amountCents: number): Promise<Recorded> {
  const [paid] = await db
    .update(dateChangeRequests)
    .set({ paymentStatus: 'paid' })
    .where(and(eq(dateChangeRequests.stripePaymentIntentId, paymentId), eq(dateChangeRequests.paymentStatus, 'unpaid')))
    .returning({ bookingId: dateChangeRequests.bookingId });
  if (paid) {
    await recordLedgerEntry(db, paid.bookingId, 'charge', amountCents, 'succeeded', paymentId);
    return { state: 'recorded', bookingId: paid.bookingId };
  }
  const [known] = await db
    .select({ id: dateChangeRequests.id })
    .from(dateChangeRequests)
    .where(eq(dateChangeRequests.stripePaymentIntentId, paymentId))
    .limit(1);
  return known ? { state: 'already' } : { state: 'unknown' };
}

// The deposit hold is in place on the card. Not a payment: nothing is taken.
export async function recordDepositHeld(db: Database, paymentId: string): Promise<Recorded> {
  const [held] = await db
    .update(deposits)
    .set({ status: 'held', authorizedAt: new Date() })
    .where(and(eq(deposits.stripePaymentIntentId, paymentId), eq(deposits.status, 'not_taken')))
    .returning({ bookingId: deposits.bookingId });
  if (held) return { state: 'recorded', bookingId: held.bookingId };
  return (await depositWithPayment(db, paymentId)) ? { state: 'already' } : { state: 'unknown' };
}

async function bookingWithPayment(db: Database, paymentId: string) {
  const [row] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.stripePaymentIntentId, paymentId)).limit(1);
  return row;
}

async function depositWithPayment(db: Database, paymentId: string) {
  const [row] = await db.select({ id: deposits.id }).from(deposits).where(eq(deposits.stripePaymentIntentId, paymentId)).limit(1);
  return row;
}

// What one of Stripe's messages changes. Throws NotOurs when it is about a
// payment this database does not have. Returns what to tell the customer once
// the change is safely saved.
async function applyStripeEvent(
  db: Database,
  event: WebhookEvent,
  notifications: PaymentNotifier | undefined,
  logger: Logger,
): Promise<(() => Promise<void>)[]> {
  const object = event.data.object;
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  const paymentId = typeof object.id === 'string' ? object.id : undefined;
  const amountCents = typeof object.amount === 'number' ? object.amount : 0;
  if (!paymentId) return [];
  const known = (recorded: Recorded) => {
    if (recorded.state === 'unknown') throw new NotOurs();
  };

  switch (event.type) {
    // A payment went through: the rental, or the extra days of a longer one.
    case 'payment_intent.succeeded': {
      if (metadata.kind === 'date_change') {
        known(await recordDateChangePaid(db, paymentId, amountCents));
        return [];
      }
      if (metadata.kind !== 'rental') return [];
      const recorded = await recordRentalPaid(db, paymentId, amountCents);
      known(recorded);
      return recorded.state === 'recorded' && notifications
        ? [() => notifications.paymentSucceeded(recorded.bookingId)]
        : [];
    }

    // The card was declined, or the bank's approval was not given. Each failed
    // try is recorded; a booking already paid is never marked failed.
    case 'payment_intent.payment_failed': {
      if (metadata.kind !== 'rental') return [];
      const [failed] = await db
        .update(bookings)
        .set({ paymentStatus: 'failed' })
        .where(and(eq(bookings.stripePaymentIntentId, paymentId), inArray(bookings.paymentStatus, ['authorized', 'failed'])))
        .returning({ id: bookings.id });
      if (!failed) {
        if (!(await bookingWithPayment(db, paymentId))) throw new NotOurs();
        return [];
      }
      await recordLedgerEntry(db, failed.id, 'charge', amountCents, 'failed', paymentId);
      return notifications ? [() => notifications.paymentFailed(failed.id)] : [];
    }

    // The deposit hold is now in place on the customer's card. THIS IS NOT A
    // PAYMENT: nothing has been taken, and nothing is recorded as revenue.
    case 'payment_intent.amount_capturable_updated': {
      if (metadata.kind !== 'deposit') return [];
      known(await recordDepositHeld(db, paymentId));
      return [];
    }

    // A hold that has been let go, whether by us or by Stripe expiring it. A
    // deposit already settled after a claim stays settled.
    case 'payment_intent.canceled': {
      if (metadata.kind !== 'deposit') return [];
      const [released] = await db
        .update(deposits)
        .set({ status: 'released', releasedAt: new Date() })
        .where(and(eq(deposits.stripePaymentIntentId, paymentId), inArray(deposits.status, ['not_taken', 'held'])))
        .returning({ id: deposits.id });
      if (!released && !(await depositWithPayment(db, paymentId))) throw new NotOurs();
      return [];
    }

    // Rental money given back. Stripe says how much of the charge has been
    // refunded IN ALL so far; only what is new is recorded. A refund approved
    // in the admin panel was already written down as pending, so it is marked
    // done rather than written a second time.
    case 'charge.refunded': {
      const refundedIntent = typeof object.payment_intent === 'string' ? object.payment_intent : paymentId;
      const booking = await bookingWithPayment(db, refundedIntent);
      if (!booking) throw new NotOurs();
      const refundedInAll = typeof object.amount_refunded === 'number' ? object.amount_refunded : amountCents;
      const ofThisRefund = and(
        eq(ledgerEntries.bookingId, booking.id),
        eq(ledgerEntries.stripeRef, refundedIntent),
        eq(ledgerEntries.kind, 'refund'),
      );
      await db.update(ledgerEntries).set({ status: 'succeeded' }).where(and(ofThisRefund, eq(ledgerEntries.status, 'pending')));
      const [already] = await db
        .select({ total: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)::int` })
        .from(ledgerEntries)
        .where(ofThisRefund);
      const fresh = refundedInAll - (already?.total ?? 0);
      // Refunded some other way — in Stripe's own dashboard, say.
      if (fresh > 0) await recordLedgerEntry(db, booking.id, 'refund', fresh, 'succeeded', refundedIntent);
      await db.update(bookings).set({ paymentStatus: 'refunded' }).where(eq(bookings.id, booking.id));
      return [];
    }

    // A rental business has given Stripe more of its details, so what it is
    // still waiting for — and whether they can be paid — has changed.
    case 'account.updated': {
      const payoutsEnabled = object.payouts_enabled === true;
      const requirements = object.requirements as { currently_due?: string[] } | undefined;
      const outstanding = requirements?.currently_due ?? [];
      const [updated] = await db
        .update(providerPayoutAccounts)
        .set({
          payoutsEnabled,
          outstanding,
          status: payoutsEnabled ? 'active' : outstanding.length > 0 ? 'pending' : 'restricted',
        })
        .where(eq(providerPayoutAccounts.stripeAccountId, paymentId))
        .returning({ id: providerPayoutAccounts.providerId });
      if (!updated) throw new NotOurs();
      return [];
    }

    default:
      logger.info({ type: event.type }, 'Stripe message of a kind we do not act on');
      return [];
  }
}

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
