// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Changing a rental's dates "in case something happens" —
// keeping the car longer, bringing it back early, or moving a rental that has
// not started — as a request the business accepts or declines.
//
//                         before pickup   during the rental
//   keep it longer              yes              yes
//   bring it back early         yes              yes
//   move it                     yes              —
//
// ---- THE MONEY, WHICH IS THE PART TO GET RIGHT ----
//
// The backend prices every change; the app never works out a price. A change is
// priced as the whole rental at the new dates, exactly as a new booking would be,
// and compared with what the booking costs now:
//
//   costs more   the renter pays the difference (once payments are on, through
//                Stripe's own card sheet; until then, to the business directly).
//   costs less   the CANCELLATION POLICY applies to the days given up: all of it
//                back more than 48 hours before pickup, half inside 48 hours —
//                and once the rental has started, nothing back. (The owner's
//                decision: once the car is collected, the days booked are paid
//                for.) Whatever is not given back stays on the booking as a line
//                of its own, so the lines always add up to what the renter pays.
//
// Every figure a business sees comes as gross, commission and net together, from
// what the renter actually ends up paying.
//
// ---- THE RULES OF A REQUEST ----
//
//   - the price is fixed when it is asked for, so the business accepts exactly
//     what the renter was shown;
//   - one open request per booking;
//   - the new days are NOT held while it waits: if somebody books them first,
//     accepting is refused;
//   - unanswered, it expires at pickup for a rental not yet started, and at the
//     current return time for one under way;
//   - only an accepted request changes the booking — dates, price lines and
//     figures in one transaction, and any refund into the refunds queue exactly
//     as a cancellation does.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { bookingPriceLines, bookings, dateChangeRequests, providerMembers, refundRequests, vehicles } from '../../db/schema/index.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import type { PaymentGateway } from '../../lib/stripe.js';
import { countRentalDays, isVehicleFree, today } from '../availability-engine/index.js';
import { commissionRateBps, quoteBooking, refundDue } from '../booking-engine/index.js';
import { isFeatureOn, requireFeature } from '../capabilities/index.js';
import { discountOfBooking } from '../promotions/index.js';
import type { PushService } from '../push/index.js';

type RequestRow = typeof dateChangeRequests.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;

const toAmount = (cents: number) => cents / 100;

// A booking's pickup or return, as a moment. The stored times are the island's
// own; compared in UTC from the date and time as written, like the refund rule.
const moment = (date: string, time: string) => new Date(`${date}T${time.padEnd(5, '0')}:00Z`);

// A request past its moment: unanswered at pickup (not started) or at the
// current return time (under way) — or its booking is no longer running at all.
function pastExpiry(booking: BookingRow): boolean {
  if (booking.status !== 'upcoming' && booking.status !== 'active') return true;
  const until =
    booking.status === 'active' ? moment(booking.endDate, booking.returnTime) : moment(booking.startDate, booking.pickupTime);
  return Date.now() >= until.getTime();
}

// Marks every unanswered request past its moment as expired. Run by the daily
// job; answering a request checks the same rule first.
export async function expireUnansweredDateChanges(db: Database): Promise<number> {
  const pending = await db
    .select({ request: dateChangeRequests, booking: bookings })
    .from(dateChangeRequests)
    .innerJoin(bookings, eq(bookings.id, dateChangeRequests.bookingId))
    .where(eq(dateChangeRequests.status, 'pending'));
  const due = pending.filter((row) => pastExpiry(row.booking)).map((row) => row.request.id);
  if (due.length > 0) {
    await db
      .update(dateChangeRequests)
      .set({ status: 'expired', decidedAt: new Date() })
      .where(inArray(dateChangeRequests.id, due));
  }
  return due.length;
}

// ---- WHAT EACH SIDE IS SHOWN ----
export function customerDateChange(row: RequestRow) {
  return {
    id: row.id,
    startDate: row.startDate,
    endDate: row.endDate,
    fromStartDate: row.fromStartDate,
    fromEndDate: row.fromEndDate,
    days: row.days,
    fromDays: row.fromDays,
    total: toAmount(row.totalCents),
    difference: toAmount(row.differenceCents),
    refund: toAmount(row.refundCents),
    explanation: row.explanation,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    note: row.note,
    paymentStatus: row.paymentStatus,
  };
}

// The business's copy carries what the whole booking would be worth to it,
// gross, commission and net together — product rule 3.
export function providerDateChange(row: RequestRow) {
  return {
    ...customerDateChange(row),
    grossAmount: toAmount(row.grossCents),
    commission: toAmount(row.commissionCents),
    netAmount: toAmount(row.payoutCents),
  };
}

// The latest request on each of these bookings, in one query.
export async function latestDateChanges(db: Database, bookingIds: string[]): Promise<Map<string, RequestRow>> {
  const latest = new Map<string, RequestRow>();
  if (bookingIds.length === 0) return latest;
  const rows = await db
    .select()
    .from(dateChangeRequests)
    .where(inArray(dateChangeRequests.bookingId, bookingIds))
    .orderBy(desc(dateChangeRequests.requestedAt));
  for (const row of rows) if (!latest.has(row.bookingId)) latest.set(row.bookingId, row);
  return latest;
}

// The latest refund on each of these bookings — after a cancellation, or after
// a rental was shortened — in one query.
export async function latestRefunds(db: Database, bookingIds: string[]) {
  const latest = new Map<string, typeof refundRequests.$inferSelect>();
  if (bookingIds.length === 0) return latest;
  const rows = await db
    .select()
    .from(refundRequests)
    .where(inArray(refundRequests.bookingId, bookingIds))
    .orderBy(desc(refundRequests.requestedAt));
  for (const row of rows) if (!latest.has(row.bookingId)) latest.set(row.bookingId, row);
  return latest;
}

// What the customer is told about a refund. The note only for a denial, and only
// the words written FOR the customer — never staff's own reason, which may be
// meant for colleagues.
export function refundView(row: typeof refundRequests.$inferSelect | undefined) {
  if (!row) return null;
  return {
    amount: toAmount(row.amountCents),
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    note: row.status === 'denied' ? (row.customerNote ?? null) : null,
  };
}

type Notifier = {
  notify(input: {
    customerId: string;
    bookingId: string;
    kind: 'booking_confirmed';
    title: string;
    body: string;
  }): Promise<void>;
};

export type DateChangeServiceDeps = {
  db: Database;
  config: Config;
  gateway: PaymentGateway;
  notifications: Notifier;
  push: PushService;
};

export function createDateChangeService(deps: DateChangeServiceDeps) {
  const { db, config, gateway, notifications, push } = deps;

  async function ownBooking(actor: Actor, bookingId: string) {
    if (!isUuid(bookingId)) throw notFound('We could not find that booking.');
    const [row] = await db
      .select({ booking: bookings, vehicle: vehicles })
      .from(bookings)
      .innerJoin(vehicles, eq(vehicles.id, bookings.vehicleId))
      .where(and(eq(bookings.id, bookingId), eq(bookings.customerId, actor.customerId)))
      .limit(1);
    if (!row) throw notFound('We could not find that booking.');
    return row;
  }

  // ---- PRICING A CHANGE ----
  // The same checks for the quote, the request and the business's accept, so the
  // three can never disagree.
  async function price(booking: BookingRow, vehicle: typeof vehicles.$inferSelect, dates: { startDate: string; endDate: string }) {
    if (booking.status !== 'upcoming' && booking.status !== 'active') {
      throw conflict('not_changeable', 'That booking is cancelled or finished, so its dates cannot change.');
    }
    if (dates.startDate === booking.startDate && dates.endDate === booking.endDate) {
      throw badRequest('no_change', 'Those are the dates the booking already has.');
    }
    if (booking.status === 'active' && dates.startDate !== booking.startDate) {
      throw conflict('already_started', 'The rental has started, so only its return date can change.');
    }
    const days = countRentalDays(dates.startDate, dates.endDate);
    if (days < 1) throw badRequest('invalid_dates', 'The return date has to be after the pickup date.');
    const firstNewDay = booking.status === 'active' ? dates.endDate : dates.startDate;
    if (firstNewDay < today()) throw badRequest('invalid_dates', 'One of those days is in the past.');
    if (days < vehicle.minimumDays) {
      throw badRequest('below_minimum_days', `This car is rented for at least ${vehicle.minimumDays} days.`);
    }
    if (days > vehicle.maximumDays) {
      throw badRequest('above_maximum_days', `This car can be rented for at most ${vehicle.maximumDays} days.`);
    }

    const rateBps = await commissionRateBps(db);
    // A discount code the booking was made with still applies at the new dates,
    // as long as the rental is still long enough for it.
    const discount = await discountOfBooking(db, booking.promotionId, dates);
    const quote = quoteBooking(vehicle, { ...dates, collection: booking.collection }, rateBps, discount);
    const totalCents = quote.grossCents;
    const differenceCents = totalCents - booking.totalDueTodayCents;

    let refundCents = 0;
    let explanation: string | null = null;
    if (differenceCents < 0) {
      const started = booking.status === 'active' || Date.now() >= moment(booking.startDate, booking.pickupTime).getTime();
      if (started) {
        explanation = 'The rental has started, so days given up are not refunded.';
      } else {
        const due = refundDue(
          { startDate: booking.startDate, pickupTime: booking.pickupTime, paidCents: -differenceCents },
          new Date(),
        );
        refundCents = due.amountCents;
        explanation =
          due.rule === 'free'
            ? 'More than 48 hours before pickup, so all of the difference comes back.'
            : 'Inside 48 hours of pickup, so half of the difference comes back.';
      }
    }

    // What the renter ends up paying, and the lines that add up to it.
    const renterPaysCents = differenceCents >= 0 ? totalCents : booking.totalDueTodayCents - refundCents;
    const lines = quote.lines.map((line) => ({ label: line.label, amountCents: line.amountCents }));
    if (renterPaysCents > totalCents) {
      lines.push({ label: 'Kept under the cancellation policy', amountCents: renterPaysCents - totalCents });
    }
    const commissionCents = Math.round((renterPaysCents * rateBps) / 10_000);

    const onSale = vehicle.listingStatus === 'live' && !vehicle.deletedAt;
    const available =
      onSale && (await isVehicleFree(db, vehicle.id, dates.startDate, dates.endDate, booking.id));

    return {
      days,
      fromDays: countRentalDays(booking.startDate, booking.endDate),
      quoteLines: quote.lines,
      lines,
      totalCents,
      differenceCents,
      refundCents,
      explanation,
      grossCents: renterPaysCents,
      commissionCents,
      payoutCents: renterPaysCents - commissionCents,
      available,
    };
  }

  async function ownersOf(providerId: string) {
    const rows = await db
      .select({ customerId: providerMembers.customerId })
      .from(providerMembers)
      .where(eq(providerMembers.providerId, providerId));
    return rows.map((row) => row.customerId);
  }

  async function loadForBusiness(providerId: string, bookingId: string, requestId: string) {
    if (!isUuid(bookingId) || !isUuid(requestId)) throw notFound('We could not find that request.');
    const [row] = await db
      .select({ request: dateChangeRequests, booking: bookings, vehicle: vehicles })
      .from(dateChangeRequests)
      .innerJoin(bookings, eq(bookings.id, dateChangeRequests.bookingId))
      .innerJoin(vehicles, eq(vehicles.id, bookings.vehicleId))
      .where(
        and(eq(dateChangeRequests.id, requestId), eq(bookings.id, bookingId), eq(bookings.providerId, providerId)),
      )
      .limit(1);
    if (!row) throw notFound('We could not find that request.');
    if (row.request.status !== 'pending') {
      throw conflict('change_decided', 'That request has already been answered, taken back or expired.');
    }
    if (pastExpiry(row.booking)) {
      await db.update(dateChangeRequests).set({ status: 'expired', decidedAt: new Date() }).where(eq(dateChangeRequests.id, requestId));
      throw conflict('change_decided', 'That request expired before it was answered.');
    }
    return row;
  }

  return {
    // ---- THE PRICE, BEFORE ASKING ----
    async quote(actor: Actor, bookingId: string, dates: { startDate: string; endDate: string }) {
      requireFeature(config, 'dateChanges');
      const { booking, vehicle } = await ownBooking(actor, bookingId);
      const priced = await price(booking, vehicle, dates);
      return {
        days: priced.days,
        lines: priced.quoteLines.map((line) => ({ label: line.label, amount: toAmount(line.amountCents) })),
        total: toAmount(priced.totalCents),
        difference: toAmount(priced.differenceCents),
        refund: toAmount(priced.refundCents),
        explanation: priced.explanation,
        available: priced.available,
      };
    },

    // ---- ASKING ----
    async request(actor: Actor, bookingId: string, dates: { startDate: string; endDate: string }) {
      requireFeature(config, 'dateChanges');
      const { booking, vehicle } = await ownBooking(actor, bookingId);
      const priced = await price(booking, vehicle, dates);
      if (!priced.available) throw conflict('unavailable', 'The car is not free on all of those days.');

      const [open] = await db
        .select({ id: dateChangeRequests.id })
        .from(dateChangeRequests)
        .where(and(eq(dateChangeRequests.bookingId, booking.id), eq(dateChangeRequests.status, 'pending')))
        .limit(1);
      if (open) throw conflict('change_pending', 'There is already a request waiting for the business to answer.');

      const [created] = await db
        .insert(dateChangeRequests)
        .values({
          bookingId: booking.id,
          startDate: dates.startDate,
          endDate: dates.endDate,
          fromStartDate: booking.startDate,
          fromEndDate: booking.endDate,
          days: priced.days,
          fromDays: priced.fromDays,
          totalCents: priced.totalCents,
          differenceCents: priced.differenceCents,
          refundCents: priced.refundCents,
          grossCents: priced.grossCents,
          commissionCents: priced.commissionCents,
          payoutCents: priced.payoutCents,
          lines: priced.lines,
          explanation: priced.explanation,
        })
        .returning();

      // The business hears straight away: the dates asked for, nothing about the
      // renter beyond what its booking already shows.
      for (const owner of await ownersOf(booking.providerId)) {
        await push.sendToCustomer(owner, {
          category: 'bookings',
          title: `New dates asked for — ${booking.reference}`,
          body: `${dates.startDate} to ${dates.endDate}. Open the booking to answer.`,
          data: { type: 'business_booking', id: booking.id },
        });
      }
      return customerDateChange(created!);
    },

    // ---- TAKING IT BACK ----
    async withdraw(actor: Actor, bookingId: string, requestId: string) {
      const { booking } = await ownBooking(actor, bookingId);
      if (!isUuid(requestId)) throw notFound('We could not find that request.');
      const [row] = await db
        .select()
        .from(dateChangeRequests)
        .where(and(eq(dateChangeRequests.id, requestId), eq(dateChangeRequests.bookingId, booking.id)))
        .limit(1);
      if (!row) throw notFound('We could not find that request.');
      if (row.status !== 'pending') {
        throw conflict('change_decided', 'That request has already been answered, taken back or expired.');
      }
      const [updated] = await db
        .update(dateChangeRequests)
        .set({ status: 'withdrawn', decidedAt: new Date() })
        .where(eq(dateChangeRequests.id, row.id))
        .returning();
      return customerDateChange(updated!);
    },

    // ---- THE BUSINESS ACCEPTS ----
    // Everything in one transaction: the days checked again, the booking's dates
    // moved, its lines re-priced, its figures replaced, and any refund queued.
    async accept(providerId: string, bookingId: string, requestId: string) {
      const { request, booking, vehicle } = await loadForBusiness(providerId, bookingId, requestId);
      const onSale = vehicle.listingStatus === 'live' && !vehicle.deletedAt;
      if (!onSale || !(await isVehicleFree(db, vehicle.id, request.startDate, request.endDate, booking.id))) {
        throw conflict('unavailable', 'Somebody else has booked the car on one of those days since this was asked.');
      }

      const extraToPay = request.differenceCents > 0 && booking.paymentStatus === 'paid' && isFeatureOn(config, 'payments');
      await db.transaction(async (tx) => {
        await tx
          .update(bookings)
          .set({
            startDate: request.startDate,
            endDate: request.endDate,
            grossCents: request.grossCents,
            commissionCents: request.commissionCents,
            payoutCents: request.payoutCents,
            totalDueTodayCents: request.grossCents,
            // An unpaid booking's old payment was for the old amount. It is let
            // go, so paying now starts one for the new amount.
            ...(booking.paymentStatus === 'paid' ? {} : { stripePaymentIntentId: null }),
          })
          .where(eq(bookings.id, booking.id));
        await tx.delete(bookingPriceLines).where(eq(bookingPriceLines.bookingId, booking.id));
        await tx.insert(bookingPriceLines).values(
          request.lines.map((line, position) => ({ bookingId: booking.id, label: line.label, amountCents: line.amountCents, position })),
        );
        await tx
          .update(dateChangeRequests)
          .set({ status: 'accepted', decidedAt: new Date(), paymentStatus: extraToPay ? 'unpaid' : null })
          .where(eq(dateChangeRequests.id, request.id));
        // Money coming back goes through the refunds queue, like a cancellation:
        // one person approves it, and it is on the record against them.
        if (request.refundCents > 0 && booking.paymentStatus === 'paid') {
          await tx.insert(refundRequests).values({
            bookingId: booking.id,
            amountCents: request.refundCents,
            reasonGiven: `Dates changed to ${request.startDate} – ${request.endDate}. ${request.explanation ?? ''}`.trim(),
          });
        }
      });

      await notifications.notify({
        customerId: booking.customerId,
        bookingId: booking.id,
        kind: 'booking_confirmed',
        title: `New dates confirmed — ${booking.reference}`,
        body: `Your rental now runs from ${request.startDate} to ${request.endDate}.`,
      });
    },

    // ---- THE BUSINESS DECLINES ----
    async decline(providerId: string, bookingId: string, requestId: string, input: { note?: string | undefined }) {
      const { request, booking } = await loadForBusiness(providerId, bookingId, requestId);
      await db
        .update(dateChangeRequests)
        .set({ status: 'declined', decidedAt: new Date(), note: input.note ?? null })
        .where(eq(dateChangeRequests.id, request.id));
      await notifications.notify({
        customerId: booking.customerId,
        bookingId: booking.id,
        kind: 'booking_confirmed',
        title: `Your new dates were declined — ${booking.reference}`,
        body: 'Your rental keeps its original dates. Open the booking to see why.',
      });
    },

    // ---- PAYING FOR A LONGER RENTAL ----
    // The same as paying for the booking: Stripe's own card sheet with a secret.
    async startPayment(actor: Actor, bookingId: string, requestId: string) {
      requireFeature(config, 'payments');
      const { booking } = await ownBooking(actor, bookingId);
      if (!isUuid(requestId)) throw notFound('We could not find that request.');
      const [row] = await db
        .select()
        .from(dateChangeRequests)
        .where(and(eq(dateChangeRequests.id, requestId), eq(dateChangeRequests.bookingId, booking.id)))
        .limit(1);
      if (!row) throw notFound('We could not find that request.');
      if (row.paymentStatus === 'paid') throw conflict('already_paid', 'The extra days have already been paid for.');
      if (row.status !== 'accepted' || row.paymentStatus !== 'unpaid') {
        throw new AppError(409, 'nothing_to_pay', 'There is nothing to pay for this request.');
      }

      if (row.stripePaymentIntentId) {
        const existing = await gateway.getPayment(row.stripePaymentIntentId);
        if (existing && existing.status !== 'canceled') {
          return { clientSecret: existing.clientSecret, amount: toAmount(row.differenceCents), status: existing.status };
        }
      }
      const payment = await gateway.createDateChangePayment({
        bookingId: booking.id,
        bookingReference: booking.reference,
        dateChangeId: row.id,
        amountCents: row.differenceCents,
      });
      await db.update(dateChangeRequests).set({ stripePaymentIntentId: payment.id }).where(eq(dateChangeRequests.id, row.id));
      return { clientSecret: payment.clientSecret, amount: toAmount(row.differenceCents), status: payment.status };
    },
  };
}

export type DateChangeService = ReturnType<typeof createDateChangeService>;
