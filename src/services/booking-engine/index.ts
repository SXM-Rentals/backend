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
//   - delivery, when the car is being brought to the customer;
//   - the SXM Rentals service fee, 5% of the rental.
// Those lines added together are what the customer pays. SXM Rentals keeps 30%
// of it (the rate is a platform setting) and the rest is the business's.
//
// THE DEPOSIT IS NOT PART OF ANY OF THAT. It is written to its own table with
// its own life cycle and is never added into the total, the commission or the
// payout. The database itself refuses a booking whose figures do not add up.
//
// No money moves yet — Stripe arrives in Phase 3. A new booking's deposit is
// recorded as "not taken" and the booking as "authorized".

import { and, asc, eq, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  bookingPriceLines,
  bookings,
  deposits,
  platformSettings,
  vehicles,
  type customers,
} from '../../db/schema/index.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import type { Booking } from '../../types/api.js';
import { toCustomerBooking } from '../serializers/bookings.js';
import { countRentalDays, isVehicleFree, today } from '../availability-engine/index.js';

type VehicleRow = typeof vehicles.$inferSelect;

// The SXM Rentals service fee, as a share of the rental itself.
export const SERVICE_FEE_RATE = 0.05;
// Used when the platform settings row has not been written yet: 30%.
export const DEFAULT_COMMISSION_RATE_BPS = 3000;

export type BookingRequest = {
  vehicleId: string;
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
export function quoteBooking(
  vehicle: VehicleRow,
  input: { startDate: string; endDate: string; collection: 'pickup' | 'delivery' },
  rateBps: number,
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

  // The service fee is worked out on the rental itself, before delivery is
  // added: delivery is the business's own cost being passed on, and charging a
  // platform fee on top of it would quietly inflate it.
  const rentalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

  // Delivery, when the car is being brought to the customer.
  if (input.collection === 'delivery' && vehicle.deliveryFeeCents) {
    lines.push({ label: 'Delivery', amountCents: vehicle.deliveryFeeCents });
  }

  lines.push({ label: 'Service fee', amountCents: Math.round(rentalCents * SERVICE_FEE_RATE) });

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
export async function quoteFor(db: Database, input: BookingRequest): Promise<PriceQuote & { available: boolean }> {
  const vehicle = await loadBookableVehicle(db, input.vehicleId);
  assertDatesMakeSense(vehicle, input);
  const quote = quoteBooking(vehicle, input, await commissionRateBps(db));
  return { ...quote, available: await isVehicleFree(db, vehicle.id, input.startDate, input.endDate) };
}

// The short code the customer sees, e.g. SXM-4821.
function newReference(): string {
  return `SXM-${1000 + Math.floor(Math.random() * 9000)}`;
}

// ---- MAKING THE BOOKING ----
export async function createBooking(db: Database, actor: Actor, input: BookingRequest): Promise<Booking> {
  const vehicle = await loadBookableVehicle(db, input.vehicleId);
  assertDatesMakeSense(vehicle, input);
  const quote = quoteBooking(vehicle, input, await commissionRateBps(db));

  return db.transaction(async (tx) => {
    // Hold the car's row for the rest of this transaction. Two people booking
    // the same car at the same instant now queue up here, and the second one
    // sees the first one's booking in the check below.
    await tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, vehicle.id)).for('update');

    if (!(await isVehicleFree(tx, vehicle.id, input.startDate, input.endDate))) {
      throw conflict('vehicle_unavailable', 'Sorry — this vehicle has just been booked for those dates.');
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

    return toCustomerBooking(booking, lines, deposit);
  });
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

  return Promise.all(rows.map((booking) => withLinesAndDeposit(db, booking)));
}

export async function getBookingFor(db: Database, actor: Actor, bookingId: string): Promise<Booking> {
  const booking = await loadOwnBooking(db, actor, bookingId);
  return withLinesAndDeposit(db, booking);
}

export async function cancelBooking(db: Database, actor: Actor, bookingId: string): Promise<Booking> {
  const existing = await loadOwnBooking(db, actor, bookingId);
  if (existing.status === 'cancelled') throw conflict('already_cancelled', 'That booking is already cancelled.');
  if (existing.status !== 'upcoming') {
    throw conflict('cannot_cancel', 'A rental that has already started cannot be cancelled here — please contact us.');
  }

  const [booking] = await db
    .update(bookings)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(and(eq(bookings.id, existing.id), eq(bookings.customerId, actor.customerId), ne(bookings.status, 'cancelled')))
    .returning();
  if (!booking) throw conflict('already_cancelled', 'That booking is already cancelled.');

  // A deposit that was never taken simply stops being expected.
  await db
    .update(deposits)
    .set({ status: 'released', releasedAt: new Date() })
    .where(and(eq(deposits.bookingId, booking.id), ne(deposits.status, 'claimed')));

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
  const [lines, [deposit]] = await Promise.all([
    db.select().from(bookingPriceLines).where(eq(bookingPriceLines.bookingId, booking.id)),
    db.select().from(deposits).where(eq(deposits.bookingId, booking.id)).limit(1),
  ]);
  return toCustomerBooking(booking, lines, deposit);
}

// Kept so a later phase can reuse the shape of a renter without reaching for
// the whole customer record. See the note on RenterSummary.
export type CustomerRow = typeof customers.$inferSelect;
