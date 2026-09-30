// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The heart of a booking — working out what a rental
// costs, and then actually making the booking. Kept out of the route handlers
// so that a booking made through the API and one made later by a Stripe
// webhook go through exactly the same rules.
//
// WHAT A RENTAL COSTS:
//   - the rental itself: whole weeks at the weekly price where the business
//     offers one, then the remaining days at the daily price;
//   - the SXM Rentals service fee, 5% of the rental.
// Delivery is free: a car can be brought to the customer at no charge.
// Those lines added together are what the customer pays. SXM Rentals keeps 30%
// of it (the rate is a platform setting) and the rest is the business's.
//
// THE DEPOSIT IS NOT PART OF ANY OF THAT. It is written to its own table with
// its own life cycle and is never added into the total, the commission or the
// payout. The database itself refuses a booking whose figures do not add up.
//
// No money moves yet — Stripe arrives in Phase 3. A new booking's deposit is
// recorded as "not taken" and the booking as "authorized".

import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  bookingPriceLines,
  bookings,
  businessPromotions,
  deposits,
  platformSettings,
  refundRequests,
  vehicles,
  type customers,
} from '../../db/schema/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import type { Booking } from '../../types/api.js';
import { toCustomerBooking } from '../serializers/bookings.js';
import { customerDateChange, latestDateChanges, latestRefunds, refundView } from '../date-changes/index.js';
import { carSummariesFor, carSummaryFor, providerNameFor, providerNamesFor } from '../summaries/index.js';
import { countRentalDays, isVehicleFree, today } from '../availability-engine/index.js';
import { checkPromoCode, normaliseCode } from '../promotions/index.js';

type VehicleRow = typeof vehicles.$inferSelect;

// The SXM Rentals service fee, as a share of the rental itself.
export const SERVICE_FEE_RATE = 0.05;
// Used when the platform settings row has not been written yet: 30%.
export const DEFAULT_COMMISSION_RATE_BPS = 3000;

export type BookingRequest = {
  vehicleId: string;
  // A business's discount code the customer typed. See services/promotions.
  promoCode?: string | undefined;
  startDate: string;
  endDate: string;
  pickupTime: string;
  returnTime: string;
  collection: 'pickup' | 'delivery';
  location?: string | undefined;
};

export type PriceQuote = {
  days: number;
  lines: { label: string; amountCents: number; note?: string }[];
  grossCents: number;
  commissionCents: number;
  payoutCents: number;
  totalDueTodayCents: number;
  // Reported beside the total, never inside it.
  depositAmountCents: number;
};

// Cents to a readable "$65" or "$64.50" for a price line's label.
function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

// ---- WHAT THE PLATFORM KEEPS ----
export async function commissionRateBps(db: Database): Promise<number> {
  const [settings] = await db
    .select({ rate: platformSettings.commissionRateBps })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1);
  return settings?.rate ?? DEFAULT_COMMISSION_RATE_BPS;
}

// ---- WORKING OUT THE PRICE ----
// A business's discount code that has been checked and applies.
export type AppliedDiscount = { code: string; percentOff: number };

export function quoteBooking(
  vehicle: VehicleRow,
  input: { startDate: string; endDate: string; collection: 'pickup' | 'delivery' },
  rateBps: number,
  discount?: AppliedDiscount | null,
): PriceQuote {
  const days = countRentalDays(input.startDate, input.endDate);
  const lines: PriceQuote['lines'] = [];

  // The rental. Whole weeks first where a weekly price is offered, because it
  // is cheaper than the same days counted one by one.
  const weeks = vehicle.weeklyRateCents ? Math.floor(days / 7) : 0;
  const singleDays = days - weeks * 7;
  if (weeks > 0 && vehicle.weeklyRateCents) {
    lines.push({
      label: `Rental (${weeks} ${weeks === 1 ? 'week' : 'weeks'} x ${money(vehicle.weeklyRateCents)})`,
      amountCents: weeks * vehicle.weeklyRateCents,
    });
  }
  if (singleDays > 0) {
    lines.push({
      label: `Rental (${singleDays} ${singleDays === 1 ? 'day' : 'days'} x ${money(vehicle.dailyRateCents)})`,
      amountCents: singleDays * vehicle.dailyRateCents,
    });
  }

  // A DISCOUNT CODE comes off the rental lines only — never delivery, never
  // the deposit — as a line of its own so the renter sees exactly what it
  // saved. The service fee below is then worked out on the discounted price,
  // like everything else here: on what the renter actually pays.
  if (discount) {
    const rentalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
    const offCents = Math.round((rentalCents * discount.percentOff) / 100);
    if (offCents > 0) lines.push({ label: `Promotion ${discount.code}`, amountCents: -offCents });
  }

  // DELIVERY, WHEN IT WAS ASKED FOR AND THE BUSINESS CHARGES FOR IT. Each
  // business sets its own fee per car; no fee means it delivers for free, and
  // then there is no line at all rather than a line saying $0. It is part of
  // what the business sells, so commission is taken on it like the rental, and
  // the service fee is worked out on it too.
  if (input.collection === 'delivery' && vehicle.deliveryFeeCents && vehicle.deliveryFeeCents > 0) {
    lines.push({ label: 'Delivery', amountCents: vehicle.deliveryFeeCents });
  }
  const beforeFeeCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

  lines.push({ label: 'Service fee', amountCents: Math.round(beforeFeeCents * SERVICE_FEE_RATE) });

  const grossCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const commissionCents = Math.round((grossCents * rateBps) / 10_000);

  return {
    days,
    lines,
    grossCents,
    commissionCents,
    // Whatever is left after commission is the business's, to the cent.
    payoutCents: grossCents - commissionCents,
    totalDueTodayCents: grossCents,
    depositAmountCents: vehicle.depositAmountCents,
  };
}

// ---- CHECKING A REQUEST MAKES SENSE ----
async function loadBookableVehicle(db: Database, vehicleId: string): Promise<VehicleRow> {
  if (!isUuid(vehicleId)) throw notFound('We could not find that vehicle.');
  const [vehicle] = await db.select().from(vehicles).where(eq(vehicles.id, vehicleId)).limit(1);
  if (!vehicle || vehicle.deletedAt || vehicle.listingStatus !== 'live') {
    throw notFound('We could not find that vehicle.');
  }
  return vehicle;
}

function assertDatesMakeSense(vehicle: VehicleRow, input: { startDate: string; endDate: string; collection: string }) {
  const days = countRentalDays(input.startDate, input.endDate);
  if (days < 1) throw badRequest('invalid_dates', 'The return date has to be after the collection date.');
  if (input.startDate < today()) throw badRequest('invalid_dates', 'That collection date is in the past.');
  if (days < vehicle.minimumDays) {
    throw badRequest('below_minimum_days', `This vehicle is rented for at least ${vehicle.minimumDays} days.`);
  }
  if (days > vehicle.maximumDays) {
    throw badRequest('above_maximum_days', `This vehicle can be rented for at most ${vehicle.maximumDays} days.`);
  }
  if (input.collection === 'delivery' && !vehicle.deliveryAvailable) {
    throw badRequest('delivery_unavailable', 'This vehicle is not delivered; it has to be collected.');
  }
}

// ---- A PRICE PREVIEW, BEFORE ANYTHING IS BOOKED ----
export type PromoOutcome = { code: string; applied: boolean; message: string | null };

// What a typed code comes to, for the quote. Never throws: a bad code is a
// message beside a price, not a failed quote.
async function promoFor(
  db: Database,
  vehicle: VehicleRow,
  input: BookingRequest,
  promotionsOn: boolean,
): Promise<{ outcome: PromoOutcome | null; discount: AppliedDiscount | null }> {
  if (!input.promoCode) return { outcome: null, discount: null };
  const code = normaliseCode(input.promoCode);
  if (!promotionsOn) {
    return { outcome: { code, applied: false, message: 'Discount codes are not switched on yet.' }, discount: null };
  }
  const checked = await checkPromoCode(db, vehicle, code, input);
  return checked.applied
    ? { outcome: { code, applied: true, message: null }, discount: checked.discount }
    : { outcome: { code, applied: false, message: checked.message }, discount: null };
}

export async function quoteFor(
  db: Database,
  input: BookingRequest,
  promotionsOn = false,
): Promise<PriceQuote & { available: boolean; promo: PromoOutcome | null }> {
  const vehicle = await loadBookableVehicle(db, input.vehicleId);
  assertDatesMakeSense(vehicle, input);
  const { outcome, discount } = await promoFor(db, vehicle, input, promotionsOn);
  const quote = quoteBooking(vehicle, input, await commissionRateBps(db), discount);
  return { ...quote, available: await isVehicleFree(db, vehicle.id, input.startDate, input.endDate), promo: outcome };
}

// The short code the customer sees, e.g. SXM-4821.
function newReference(): string {
  return `SXM-${1000 + Math.floor(Math.random() * 9000)}`;
}

// Told about bookings as they are made and cancelled, so the customer hears
// about it. Optional: a booking is never failed because a message could not be
// sent (see services/notifications).
export type BookingNotifier = {
  bookingConfirmed(bookingId: string): Promise<void>;
  bookingCancelled(bookingId: string): Promise<void>;
};

// ---- MAKING THE BOOKING ----
export async function createBooking(
  db: Database,
  actor: Actor,
  input: BookingRequest,
  notifier?: BookingNotifier,
  promotionsOn = false,
): Promise<Booking> {
  const vehicle = await loadBookableVehicle(db, input.vehicleId);
  assertDatesMakeSense(vehicle, input);
  if (input.promoCode && !promotionsOn) {
    throw conflict('promo_not_applicable', 'Discount codes are not switched on yet.');
  }
  const rateBps = await commissionRateBps(db);

  const created = await db.transaction(async (tx) => {
    // THE CODE, CHECKED AGAIN, with its row locked: two bookings at the same
    // moment cannot both take its last use. If it no longer applies the booking
    // is refused — never made quietly at the full price.
    let promotionId: string | null = null;
    let discount: AppliedDiscount | null = null;
    if (input.promoCode) {
      await tx
        .select({ id: businessPromotions.id })
        .from(businessPromotions)
        .where(
          and(
            eq(businessPromotions.providerId, vehicle.providerId),
            eq(businessPromotions.code, normaliseCode(input.promoCode)),
          ),
        )
        .for('update');
      const checked = await checkPromoCode(tx, vehicle, input.promoCode, input);
      if (!checked.applied) throw conflict('promo_not_applicable', checked.message);
      promotionId = checked.promotion.id;
      discount = checked.discount;
    }
    const quote = quoteBooking(vehicle, input, rateBps, discount);

    // Hold the car's row for the rest of this transaction. Two people booking
    // the same car at the same instant now queue up here, and the second one
    // sees the first one's booking in the check below.
    await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, vehicle.id)).for('update');

    if (!(await isVehicleFree(tx, vehicle.id, input.startDate, input.endDate))) {
      // Booked by somebody else, or a day the business took it off sale — the
      // customer is not told which.
      throw conflict('vehicle_unavailable', 'Sorry — this vehicle is not available on all of those dates.');
    }

    // A reference clash is vanishingly unlikely, but retrying is cheap.
    let booking: typeof bookings.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5 && !booking; attempt += 1) {
      try {
        [booking] = await tx
          .insert(bookings)
          .values({
            reference: newReference(),
            customerId: actor.customerId,
            vehicleId: vehicle.id,
            providerId: vehicle.providerId,
            startDate: input.startDate,
            endDate: input.endDate,
            pickupTime: input.pickupTime,
            returnTime: input.returnTime,
            collection: input.collection,
            location: input.location?.trim() || vehicle.pickupTown,
            grossCents: quote.grossCents,
            commissionCents: quote.commissionCents,
            payoutCents: quote.payoutCents,
            totalDueTodayCents: quote.totalDueTodayCents,
            promotionId,
          })
          .returning();
      } catch (error) {
        const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code;
        if (code !== '23505') throw error;
      }
    }
    if (!booking) throw new Error('Could not allocate a booking reference');

    const lines = await tx
      .insert(bookingPriceLines)
      .values(
        quote.lines.map((line, position) => ({
          bookingId: booking!.id,
          label: line.label,
          amountCents: line.amountCents,
          note: line.note,
          position,
        })),
      )
      .returning();

    // The deposit: its own row, its own life cycle. Nothing is charged or held
    // until Stripe arrives in Phase 3.
    const [deposit] = quote.depositAmountCents
      ? await tx
          .insert(deposits)
          .values({ bookingId: booking.id, amountCents: quote.depositAmountCents, status: 'not_taken' })
          .returning()
      : [undefined];

    return toCustomerBooking(booking, lines, deposit, {
      // The car is already loaded here — it is what was just booked — so this
      // costs one more small query for the business's name and nothing else.
      vehicle: { id: vehicle.id, make: vehicle.make, model: vehicle.model, year: vehicle.year, photo: null },
      providerName: await providerNameFor(tx, booking.providerId),
      // Brand new: nothing refunded, no change asked for.
      refund: null,
      dateChange: null,
    });
  });

  // The booking is already made; telling the customer comes after.
  await notifier?.bookingConfirmed(created.id);
  return created;
}

// ---- READING YOUR OWN BOOKINGS ----
// Every query here is tied to the signed-in person, so there is no ID to
// tamper with: somebody else's booking is simply "not found".

export async function listBookingsFor(db: Database, actor: Actor): Promise<Booking[]> {
  const rows = await db
    .select()
    .from(bookings)
    .where(eq(bookings.customerId, actor.customerId))
    .orderBy(asc(bookings.startDate));

  // Gathered once for the whole list. This used to be one round of queries per
  // booking, which is the kind of thing that is invisible with three bookings
  // and unusable with three hundred.
  return listWithLinesAndDeposits(db, rows);
}

export async function getBookingFor(db: Database, actor: Actor, bookingId: string): Promise<Booking> {
  const booking = await loadOwnBooking(db, actor, bookingId);
  return withLinesAndDeposit(db, booking);
}

// ---- WHAT A CANCELLATION IS WORTH BACK ----
// The cancellation policy, in one place, so the figure a customer is shown
// before confirming and the figure that reaches the refunds queue can never be
// two different numbers.
//
//   more than 48 hours before pickup -> everything back
//   less than 48 hours before pickup -> half back
//   the rental has already started   -> nothing back
//
// The reasoning behind the middle band: a business that has turned other
// bookings away for those dates cannot fill them the night before. The
// security deposit is not part of this at all — a hold is released whenever a
// booking is cancelled, whatever the timing, because it was never revenue.
export const FREE_CANCELLATION_HOURS = 48;
export const LATE_CANCELLATION_REFUND = 0.5;

export type RefundDue = {
  amountCents: number;
  // For the sentence the app shows, and the reason written onto the request.
  rule: 'free' | 'late' | 'started';
  hoursBeforePickup: number;
};

// `paidCents` is what the customer actually handed over, which is not the same
// as what the booking is worth: nothing is refunded on a booking nobody paid.
export function refundDue(input: { startDate: string; pickupTime: string; paidCents: number }, now: Date): RefundDue {
  // The booking's own dates are island local time; the server may be anywhere,
  // so the comparison is made in UTC from the stored date and time.
  const pickup = new Date(`${input.startDate}T${input.pickupTime.padEnd(5, '0')}:00Z`);
  const hoursBeforePickup = (pickup.getTime() - now.getTime()) / (60 * 60 * 1000);

  if (hoursBeforePickup <= 0) return { amountCents: 0, rule: 'started', hoursBeforePickup };
  if (hoursBeforePickup >= FREE_CANCELLATION_HOURS) {
    return { amountCents: input.paidCents, rule: 'free', hoursBeforePickup };
  }
  // Rounded to the cent, and never more than was paid.
  return {
    amountCents: Math.min(input.paidCents, Math.round(input.paidCents * LATE_CANCELLATION_REFUND)),
    rule: 'late',
    hoursBeforePickup,
  };
}

// The sentence staff read in the refunds queue, and the app shows beforehand.
export function refundExplanation(due: RefundDue): string {
  const hours = Math.max(0, Math.round(due.hoursBeforePickup));
  if (due.rule === 'started') return 'Cancelled after the rental had started — nothing is refundable.';
  if (due.rule === 'free') {
    return `Cancelled ${hours} hours before pickup, more than ${FREE_CANCELLATION_HOURS} — a full refund under the cancellation policy.`;
  }
  return `Cancelled ${hours} hours before pickup, inside ${FREE_CANCELLATION_HOURS} — half back under the cancellation policy.`;
}

// ---- SIGNING THE RENTAL AGREEMENT ----
// The customer's own action, before pickup. A booking has always REPORTED
// whether the agreement was signed, and nothing ever set it, so the booking flow
// had a step that said the signature could not be recorded.
//
// It is the customer who signs, not the business marking that they did: if a
// deposit is disputed later, "the renter agreed to these terms at this time from
// their own account" is worth something, and "the business says they signed" is
// worth much less.
export async function signAgreement(db: Database, actor: Actor, bookingId: string): Promise<Booking> {
  const existing = await loadOwnBooking(db, actor, bookingId);
  if (existing.status === 'cancelled') {
    throw conflict('booking_cancelled', 'That booking is cancelled, so there is nothing to agree to.');
  }
  // Signing twice is the same as signing once — a double tap, or a page
  // reloaded — so the first time stands rather than being moved.
  if (existing.agreementSignedAt) return withLinesAndDeposit(db, existing);

  const [booking] = await db
    .update(bookings)
    .set({ agreementSignedAt: new Date() })
    .where(and(eq(bookings.id, existing.id), eq(bookings.customerId, actor.customerId), isNull(bookings.agreementSignedAt)))
    .returning();
  // Somebody signed in the moment between the two queries. Their signature
  // counts; this one changes nothing.
  return withLinesAndDeposit(db, booking ?? existing);
}

export async function cancelBooking(
  db: Database,
  actor: Actor,
  bookingId: string,
  notifier?: BookingNotifier,
  // Why, if they said. Shown to the business on the cancelled booking.
  reason?: string | undefined,
): Promise<Booking> {
  const existing = await loadOwnBooking(db, actor, bookingId);
  if (existing.status === 'cancelled') throw conflict('already_cancelled', 'That booking is already cancelled.');
  if (existing.status !== 'upcoming') {
    throw conflict('cannot_cancel', 'A rental that has already started cannot be cancelled here — please contact us.');
  }

  const [booking] = await db
    .update(bookings)
    .set({ status: 'cancelled', cancelledAt: new Date(), cancellationReason: reason ?? null })
    .where(and(eq(bookings.id, existing.id), eq(bookings.customerId, actor.customerId), ne(bookings.status, 'cancelled')))
    .returning();
  if (!booking) throw conflict('already_cancelled', 'That booking is already cancelled.');

  // ONLY A HOLD THAT EXISTED IS RELEASED. A deposit that was never taken stays
  // "not taken": the two mean different things to a customer — "the hold on
  // your card has been lifted" against "nothing was ever held" — and marking
  // both as released left the apps unable to say which.
  await db
    .update(deposits)
    .set({ status: 'released', releasedAt: new Date() })
    .where(and(eq(deposits.bookingId, booking.id), eq(deposits.status, 'held')));

  // WHAT THE CUSTOMER IS OWED. Nothing was refunded here before, so a customer
  // who cancelled a paid booking was owed money that nothing recorded and
  // nothing put in front of staff. The request goes into the refunds queue that
  // the admin panel already has; approving it there is what sends the money
  // back through Stripe, so one person still decides and it is on the record.
  if (booking.paymentStatus === 'paid') {
    const due = refundDue(
      { startDate: booking.startDate, pickupTime: booking.pickupTime, paidCents: booking.totalDueTodayCents },
      new Date(),
    );
    // The table refuses an amount of zero, which is the right shape for this:
    // no money owed, no request for anybody to read.
    if (due.amountCents > 0) {
      await db.insert(refundRequests).values({
        bookingId: booking.id,
        amountCents: due.amountCents,
        reasonGiven: refundExplanation(due),
      });
    }
  }

  await notifier?.bookingCancelled(booking.id);
  return withLinesAndDeposit(db, booking);
}

async function loadOwnBooking(db: Database, actor: Actor, bookingId: string) {
  if (!isUuid(bookingId)) throw notFound('We could not find that booking.');
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.customerId, actor.customerId)))
    .limit(1);
  if (!booking) throw notFound('We could not find that booking.');
  return booking;
}

async function withLinesAndDeposit(db: Database, booking: typeof bookings.$inferSelect): Promise<Booking> {
  const [lines, [deposit], vehicle, providerName, refunds, changes] = await Promise.all([
    db.select().from(bookingPriceLines).where(eq(bookingPriceLines.bookingId, booking.id)),
    db.select().from(deposits).where(eq(deposits.bookingId, booking.id)).limit(1),
    carSummaryFor(db, booking.vehicleId),
    providerNameFor(db, booking.providerId),
    latestRefunds(db, [booking.id]),
    latestDateChanges(db, [booking.id]),
  ]);
  const change = changes.get(booking.id);
  return toCustomerBooking(booking, lines, deposit, {
    vehicle,
    providerName,
    refund: refundView(refunds.get(booking.id)),
    dateChange: change ? customerDateChange(change) : null,
  });
}

// A whole list of bookings, with the cars and business names gathered ONCE
// rather than per booking. Everything that lists bookings goes through here.
async function listWithLinesAndDeposits(
  db: Database,
  rows: (typeof bookings.$inferSelect)[],
): Promise<Booking[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [lines, depositRows, cars, names, refunds, changes] = await Promise.all([
    db.select().from(bookingPriceLines).where(inArray(bookingPriceLines.bookingId, ids)),
    db.select().from(deposits).where(inArray(deposits.bookingId, ids)),
    carSummariesFor(db, rows.map((row) => row.vehicleId)),
    providerNamesFor(db, rows.map((row) => row.providerId)),
    latestRefunds(db, ids),
    latestDateChanges(db, ids),
  ]);

  return rows.map((row) =>
    toCustomerBooking(
      row,
      lines.filter((line) => line.bookingId === row.id),
      depositRows.find((deposit) => deposit.bookingId === row.id),
      {
        vehicle: cars.get(row.vehicleId) ?? null,
        providerName: names.get(row.providerId) ?? '',
        refund: refundView(refunds.get(row.id)),
        dateChange: changes.has(row.id) ? customerDateChange(changes.get(row.id)!) : null,
      },
    ),
  );
}

// Kept so a later phase can reuse the shape of a renter without reaching for
// the whole customer record. See the note on RenterSummary.
export type CustomerRow = typeof customers.$inferSelect;

// ---- "WHAT DO I GET BACK IF I CANCEL?" ----
// Read-only, so the cancel page can say the figure before somebody presses the
// button rather than working it out in the browser from a copy of the policy.
export async function cancellationTerms(db: Database, actor: Actor, bookingId: string) {
  const booking = await loadOwnBooking(db, actor, bookingId);
  const due = refundDue(
    { startDate: booking.startDate, pickupTime: booking.pickupTime, paidCents: booking.totalDueTodayCents },
    new Date(),
  );
  const [deposit] = await db.select().from(deposits).where(eq(deposits.bookingId, booking.id)).limit(1);

  return {
    cancellable: booking.status === 'upcoming',
    // Zero when nothing was paid, which is the true answer either way.
    refundAmount: booking.paymentStatus === 'paid' ? due.amountCents / 100 : 0,
    rule: due.rule,
    explanation: refundExplanation(due),
    freeUntilHoursBeforePickup: FREE_CANCELLATION_HOURS,
    // Said separately, because a deposit is not revenue and is given back
    // whatever the timing.
    depositHeld: deposit?.status === 'held',
    depositAmount: (deposit?.amountCents ?? 0) / 100,
  };
}
