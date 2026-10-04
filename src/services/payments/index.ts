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
//
// ---- THE DEPOSIT, HELD AUTOMATICALLY ON THE CARD THAT PAID ----
// The customer pays once. With their agreement in so many words
// ("saveCardForDeposit"), the card that pays for the rental is saved on their
// Stripe record, and the deposit hold is placed on it by itself two days before
// pickup — or straight after paying, when pickup is sooner than that.
//
// IT IS STILL ONLY A HOLD. A separate payment, authorised and never taken unless
// a claim is agreed: never part of the rental, never commissioned, never paid
// out. Not placed at booking because a hold lasts about a week, and would be
// gone before a car booked weeks ahead was collected.
//
// When it cannot go through — the bank wants the customer to approve it, or the
// card is declined — it is NOT retried: the customer is told (in the app, by
// email and by push) and holds it with the existing button. That button stays,
// for exactly this.

import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
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
import { islandDate, islandWords } from '../../lib/island-time.js';
import type { OffSessionHold, PaymentGateway, PaymentRecord, WebhookEvent } from '../../lib/stripe.js';
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
  // The automatic hold could not go through; the customer has to hold it.
  depositHoldNeeded(depositId: string, reason: 'authentication_required' | 'declined'): Promise<void>;
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

// Beside the rental payment: the deposit, so the page can say in words what will
// happen to it. Null when the booking has no deposit.
export type DepositPlan = {
  amount: number;
  // Paying also saves the card, with the customer's agreement, for the hold.
  savesCard: boolean;
  // When the hold is placed: two days before pickup.
  holdFrom: string;
} | null;

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
    // options.saveCardForDeposit: the customer was shown, and agreed to, the
    // card also being used for the deposit hold. Left out — as every app
    // released before this leaves it — the payment is exactly as it always was.
    async startRentalPayment(
      actor: Actor,
      bookingId: string,
      options: { saveCardForDeposit?: boolean | undefined } = {},
    ): Promise<PaymentStart & { deposit: DepositPlan }> {
      const booking = await loadOwnBooking(actor, bookingId);
      if (booking.paymentStatus === 'paid') {
        throw conflict('already_paid', 'That booking has already been paid for.');
      }

      const [deposit] = await db.select().from(deposits).where(eq(deposits.bookingId, booking.id)).limit(1);
      // Only a deposit still to be held, and only when the customer agreed.
      const saving = Boolean(options.saveCardForDeposit && deposit && deposit.amountCents > 0 && deposit.status === 'not_taken');
      const stripeCustomerId = saving ? await stripeCustomerFor(actor, { create: true }) : null;

      const answer = async (payment: PaymentRecord) => {
        const savesCard = payment.savesCard === true;
        // The evidence of consent: the first time they agreed, kept on the deposit.
        if (saving && savesCard) {
          await db
            .update(deposits)
            .set({ holdConsentAt: new Date() })
            .where(and(eq(deposits.id, deposit!.id), isNull(deposits.holdConsentAt)));
        }
        return {
          paymentId: payment.id,
          clientSecret: payment.clientSecret,
          status: payment.status,
          amount: toAmount(booking.totalDueTodayCents),
          deposit:
            deposit && deposit.amountCents > 0
              ? {
                  amount: toAmount(deposit.amountCents),
                  savesCard,
                  holdFrom: holdWindowOpensAt(booking.startDate, booking.pickupTime).toISOString(),
                }
              : null,
        };
      };

      if (booking.stripePaymentIntentId) {
        const existing = await gateway.getPayment(booking.stripePaymentIntentId);
        // Stripe already has the money and its message has not arrived (or was
        // lost): record it now, exactly as the message would have.
        if (existing?.status === 'succeeded') {
          const recorded = await recordRentalPaid(db, existing.id, booking.totalDueTodayCents);
          if (recorded.state === 'recorded') await notifications?.paymentSucceeded(recorded.bookingId);
          // And, as the message would have, keep the card and hold the deposit
          // now if pickup is already within two days.
          if (existing.savesCard && existing.paymentMethodId) {
            await rememberCardThatPaid(db, booking.id, existing.paymentMethodId);
            await placeDueDepositHolds({ db, gateway, logger, notifications }, { bookingId: booking.id });
          }
          throw conflict('already_paid', 'That booking has already been paid for.');
        }
        if (existing && existing.status !== 'canceled') {
          // Started before the card could be saved with it. Still waiting for a
          // card, so it can be made to save it — never handed back as one that
          // will not, when the customer has just agreed that it will.
          if (saving && !existing.savesCard && ['requires_payment_method', 'requires_confirmation'].includes(existing.status)) {
            return answer(await gateway.saveCardOnPayment(existing.id, stripeCustomerId!));
          }
          return answer(existing);
        }
      }

      const payment = await gateway.createRentalPayment({
        bookingId: booking.id,
        bookingReference: booking.reference,
        amountCents: booking.totalDueTodayCents,
        saveCardFor: saving ? { stripeCustomerId: stripeCustomerId! } : undefined,
      });
      await db
        .update(bookings)
        .set({ stripePaymentIntentId: payment.id })
        .where(eq(bookings.id, booking.id));

      return answer(payment);
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
          `The deposit can be held from ${islandWords(opensAt)} (island time), two days before pickup. A hold on a card only lasts about a week, so placing it sooner would mean it had gone before you collected the car.`,
        );
      }

      // The saved card is being used for it this very moment.
      if (deposit.autoHoldStatus === 'placing' && deposit.autoHoldTriedAt && Date.now() - deposit.autoHoldTriedAt.getTime() < 10 * 60_000) {
        throw conflict('hold_in_progress', 'The deposit is being held on your saved card right now. Check again in a minute.');
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
      // A deposit waiting to be held on that card no longer can be: the
      // customer holds it themselves, as before.
      await db
        .update(deposits)
        .set({ paymentMethodId: null })
        .where(and(eq(deposits.paymentMethodId, cardId), eq(deposits.status, 'not_taken')));
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
        expiresBeforeReturn: expires ? islandDate(expires) <= booking.endDate : false,
        // When the customer may place the hold, so the app can say so rather
        // than offer a button that will be refused.
        holdOpensAt: holdWindowOpensAt(booking.startDate, booking.pickupTime).toISOString(),
        // Whether the backend will hold it by itself on the card that paid:
        //   scheduled       a card is saved and agreed to; held at autoHoldAt
        //   needs_customer  tried and could not go through; autoHoldProblem says
        //                   why, and the "Hold the deposit" button fixes it
        //   off             no saved card for it; the button, as before
        ...autoHoldView(deposit, booking),
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
          afterwards = await applyStripeEvent(tx as unknown as Database, event, notifications, logger, (bookingId) =>
            placeDueDepositHolds({ db, gateway, logger, notifications }, { bookingId }).then(() => undefined),
          );
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

// The card that paid, saved with the customer's agreement, kept beside that
// agreement on the deposit — so the hold never depends on looking the old
// payment up later.
export async function rememberCardThatPaid(db: Database, bookingId: string, paymentMethodId: string) {
  await db
    .update(deposits)
    .set({ paymentMethodId })
    .where(
      and(
        eq(deposits.bookingId, bookingId),
        isNotNull(deposits.holdConsentAt),
        isNull(deposits.paymentMethodId),
        eq(deposits.status, 'not_taken'),
      ),
    );
}

// ---- HOLDING DEPOSITS THAT ARE DUE, WITHOUT THE CUSTOMER THERE ----
// Run by the daily job (twice a day), and straight after a rental is paid. A
// deposit is held here only when ALL of these are true: it has not been held,
// the booking is still on, a card was saved for it with the customer's
// agreement, its window has opened (two days before pickup), no hold is already
// on its way, and it has not already needed the customer. Running it twice holds
// nothing twice: each deposit is claimed before Stripe is asked, and Stripe is
// asked with a key of its own that hands the same hold back.
const STALE_CLAIM_MS = 60 * 60_000;

export async function placeDueDepositHolds(
  deps: { db: Database; gateway: PaymentGateway; logger: Logger; notifications?: PaymentNotifier | undefined },
  options: { now?: Date; bookingId?: string } = {},
): Promise<{ held: number; needsCustomer: number; failed: number }> {
  const { db, gateway, logger, notifications } = deps;
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  // Not yet tried — or a try that stopped half way an hour ago (the job died).
  const free = or(
    isNull(deposits.autoHoldStatus),
    and(eq(deposits.autoHoldStatus, 'placing'), lt(deposits.autoHoldTriedAt, staleBefore)),
  );
  const ready = and(
    eq(deposits.status, 'not_taken'),
    gt(deposits.amountCents, 0),
    isNotNull(deposits.paymentMethodId),
    isNotNull(deposits.holdConsentAt),
    isNull(deposits.stripePaymentIntentId),
    free,
  );

  const due = await db
    .select({ deposit: deposits, booking: bookings, stripeCustomerId: customers.stripeCustomerId })
    .from(deposits)
    .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        ready,
        inArray(bookings.status, ['upcoming', 'active']),
        isNotNull(customers.stripeCustomerId),
        options.bookingId ? eq(bookings.id, options.bookingId) : undefined,
      ),
    );

  const tally = { held: 0, needsCustomer: 0, failed: 0 };
  for (const row of due) {
    // Not before its window: a hold placed sooner would be gone before pickup.
    if (now.getTime() < holdWindowOpensAt(row.booking.startDate, row.booking.pickupTime).getTime()) continue;

    // Claimed first, so two runs at the same moment cannot both place it.
    const [claimed] = await db
      .update(deposits)
      .set({ autoHoldStatus: 'placing', autoHoldTriedAt: now })
      .where(and(eq(deposits.id, row.deposit.id), ready))
      .returning({ id: deposits.id });
    if (!claimed) continue;

    let outcome: OffSessionHold;
    try {
      outcome = await gateway.holdDepositOffSession({
        bookingId: row.booking.id,
        bookingReference: row.booking.reference,
        depositId: row.deposit.id,
        amountCents: row.deposit.amountCents,
        stripeCustomerId: row.stripeCustomerId!,
        paymentMethodId: row.deposit.paymentMethodId!,
      });
    } catch (error) {
      // Stripe unreachable, or similar: let go of the claim and try on the next
      // run. Not a card problem, so the customer is not troubled with it.
      await db.update(deposits).set({ autoHoldStatus: null }).where(eq(deposits.id, row.deposit.id));
      logger.warn({ depositId: row.deposit.id, error: String(error) }, 'Could not place a deposit hold; will try again');
      tally.failed += 1;
      continue;
    }

    if (outcome.outcome === 'held') {
      await db
        .update(deposits)
        .set({ stripePaymentIntentId: outcome.paymentId, autoHoldStatus: 'placed' })
        .where(eq(deposits.id, row.deposit.id));
      // Stripe answered "held" there and then; its message will say the same.
      await recordDepositHeld(db, outcome.paymentId);
      tally.held += 1;
      continue;
    }

    // The bank wants the customer, or the card was declined. Recorded once, the
    // customer told once, and never tried again on its own.
    const amount = dollars(row.deposit.amountCents);
    await db
      .update(deposits)
      .set({
        autoHoldStatus: 'needs_customer',
        autoHoldProblem:
          outcome.reason === 'authentication_required'
            ? `Your bank wants you to approve the ${amount} deposit hold. Tap "Hold the deposit" to do it.`
            : `Your card could not be used for the ${amount} deposit hold. Tap "Hold the deposit" to use a card.`,
      })
      .where(eq(deposits.id, row.deposit.id));
    // The half-made hold is let go. It was never linked to the deposit, so the
    // message Stripe sends about cancelling it changes nothing here.
    if (outcome.paymentId) {
      await gateway.cancelDepositHold(outcome.paymentId).catch(() => undefined);
    }
    await notifications?.depositHoldNeeded(row.deposit.id, outcome.reason).catch(() => undefined);
    tally.needsCustomer += 1;
  }
  return tally;
}

// What the deposit panel says about the automatic hold.
function autoHoldView(deposit: typeof deposits.$inferSelect, booking: typeof bookings.$inferSelect) {
  if (deposit.autoHoldStatus === 'needs_customer') {
    return { autoHold: 'needs_customer' as const, autoHoldAt: null, autoHoldProblem: deposit.autoHoldProblem };
  }
  if (deposit.paymentMethodId && deposit.holdConsentAt) {
    return {
      autoHold: 'scheduled' as const,
      autoHoldAt: holdWindowOpensAt(booking.startDate, booking.pickupTime).toISOString(),
      autoHoldProblem: null,
    };
  }
  return { autoHold: 'off' as const, autoHoldAt: null, autoHoldProblem: null };
}

// 50000 → "$500", 5550 → "$55.50".
const dollars = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

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
  // Places the deposit hold now if its window is already open (pickup within two
  // days). Run after the payment is safely saved.
  holdDepositIfDue: (bookingId: string) => Promise<void>,
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
      const after: (() => Promise<void>)[] = [];
      if (recorded.state === 'recorded' && notifications) after.push(() => notifications.paymentSucceeded(recorded.bookingId));
      // Paid with the card saved for the deposit: remember which card, and hold
      // the deposit straight away if pickup is already within two days.
      const savedCard = object.setup_future_usage === 'off_session' && typeof object.customer === 'string';
      const paidWith = typeof object.payment_method === 'string' ? object.payment_method : null;
      const booking = await bookingWithPayment(db, paymentId);
      if (savedCard && paidWith && booking) {
        await rememberCardThatPaid(db, booking.id, paidWith);
        after.push(() => holdDepositIfDue(booking.id));
      }
      return after;
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
