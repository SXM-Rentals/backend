// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Everything a rental business sees and does about ITSELF:
// registering with SXM Rentals, its own record, its fleet, how each car is
// doing, the bookings across that fleet, what it has been paid, and setting up
// where the money goes.
//
// THE WALL BETWEEN BUSINESSES. Every function here starts from a membership —
// which signed-in person acts for which business — and every query is tied to
// that business's id. There is no way to ask about another business by changing
// a number: their cars and bookings simply are not found.
//
// WHAT A BUSINESS NEVER SEES. Bookings come back through the provider
// serializer, which has no field for a customer's phone number or email. A
// business gets a display name and whether the person has been verified, which
// is what is actually needed to hand over a car.
//
// EVERY FIGURE IS THEIR OWN SHARE, after SXM Rentals' commission, with the
// deduction shown beside it rather than hidden.

import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import {
  bookings,
  chatThreads,
  customers,
  deposits,
  payouts,
  providerBusinessProfiles,
  providerMembers,
  providerPayoutAccounts,
  providers,
  vehicleAccidentRecords,
  vehiclePhotos,
  vehicles,
} from '../../db/schema/index.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { exampleTowns, findTown } from '../../lib/towns.js';
import type { PhotoStorage } from '../../lib/storage.js';
import { threadIdsForBookings } from '../messaging/index.js';
import { latestDateChanges, providerDateChange } from '../date-changes/index.js';
import { carSummariesFor, carSummaryFor } from '../summaries/index.js';
import type { Actor } from '../../lib/ownership.js';
import { isUuid } from '../../lib/ownership.js';
import type { PaymentGateway } from '../../lib/stripe.js';
import { daysBetween, unavailableDatesFor } from '../availability-engine/index.js';
import { nextPayoutDate } from '../payment-splitting/index.js';
import { toBusinessProfile, toPayoutRecord, toVehiclePerformance } from '../serializers/business.js';
import { toProviderBooking } from '../serializers/bookings.js';
import { toVehicle } from '../serializers/vehicles.js';

// How far back the performance figures look.
const PERFORMANCE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ProviderContext = { providerId: string; role: 'owner' | 'staff' };

// ---- WHICH BUSINESS IS THIS PERSON ACTING FOR? ----
// Everything else in this file starts here. Somebody with no business linked to
// their account is told so plainly, rather than being shown an empty dashboard.
export async function requireProviderFor(db: Database, actor: Actor): Promise<ProviderContext> {
  // An OPEN business first. Somebody who closed one and opened another acts for
  // the one that still trades — and nobody acts for a closed business at all,
  // because before this check every /providers/me/ address kept working after
  // closing, including adding a car, which put new listings into the approval
  // queue for a business that no longer trades.
  const [open] = await db
    .select({ providerId: providerMembers.providerId, role: providerMembers.role })
    .from(providerMembers)
    .innerJoin(providers, eq(providers.id, providerMembers.providerId))
    .where(and(eq(providerMembers.customerId, actor.customerId), isNull(providers.deletedAt)))
    .limit(1);
  if (open) return open;

  // None open. Was there ever one? The two cases read differently to somebody
  // looking at the screen, so they are answered differently: a closed business
  // gets its own code, and the website shows it its own page rather than
  // pretending it never had a business.
  const [closed] = await db
    .select({ providerId: providerMembers.providerId })
    .from(providerMembers)
    .where(eq(providerMembers.customerId, actor.customerId))
    .limit(1);
  if (closed) {
    throw new AppError(403, 'business_closed', 'This business is closed, so it can no longer be changed.');
  }
  throw new AppError(403, 'not_a_provider', 'This account is not linked to a rental business.');
}

export type ApplyInput = {
  businessName: string;
  legalName: string;
  contactEmail: string;
  ownerName: string;
  ownerPhone: string;
  town: string;
  side: 'dutch' | 'french';
  operatingSide: 'dutch' | 'french' | 'both';
  phone?: string | undefined;
  description?: string | undefined;
  website?: string | undefined;
  registrationStatus?: 'registered' | 'not_registered' | 'pending' | undefined;
  registrationNumber?: string | undefined;
  registeredIn?: string | undefined;
  fleetSizeBand?: string | undefined;
  locations?: string[] | undefined;
  deliversVehicles?: boolean | undefined;
  airportPickup?: boolean | undefined;
};

// ---- REGISTERING A BUSINESS ----
// The business is created unverified: staff check its paperwork before the
// "SXM Verified" badge appears, and its cars wait for approval before any
// customer can see them.
export async function applyAsProvider(db: Database, actor: Actor, input: ApplyInput) {
  // Only an OPEN business makes somebody already a provider. A membership of a
  // closed one stays on the row so past bookings and payouts still point at
  // something real; counting it here would mean anybody who ever closed a
  // business could never open another, which is not what closing means.
  const [existing] = await db
    .select({ providerId: providerMembers.providerId })
    .from(providerMembers)
    .innerJoin(providers, eq(providers.id, providerMembers.providerId))
    .where(and(eq(providerMembers.customerId, actor.customerId), isNull(providers.deletedAt)))
    .limit(1);
  if (existing) {
    throw conflict('already_a_provider', 'This account is already linked to a rental business.');
  }

  return db.transaction(async (tx) => {
    const [provider] = await tx
      .insert(providers)
      .values({
        businessName: input.businessName,
        side: input.side,
        town: input.town,
        description: input.description ?? '',
        phone: input.phone ?? '',
        deliversVehicles: input.deliversVehicles ?? false,
        airportPickup: input.airportPickup ?? false,
        isVerified: false,
        verificationStatus: 'pending',
      })
      .returning();
    if (!provider) throw new Error('Business was not created');

    const [profile] = await tx
      .insert(providerBusinessProfiles)
      .values({
        providerId: provider.id,
        legalName: input.legalName,
        contactEmail: input.contactEmail.trim().toLowerCase(),
        website: input.website,
        registrationStatus: input.registrationStatus ?? 'pending',
        registrationNumber: input.registrationNumber,
        registeredIn: input.registeredIn,
        fleetSizeBand: input.fleetSizeBand ?? '',
        locations: input.locations ?? [],
        operatingSide: input.operatingSide,
        ownerName: input.ownerName,
        ownerPhone: input.ownerPhone,
      })
      .returning();

    // Whoever applied runs the business.
    await tx.insert(providerMembers).values({
      providerId: provider.id,
      customerId: actor.customerId,
      role: 'owner',
    });
    // Nothing can be paid out until they have given Stripe their details.
    await tx.insert(providerPayoutAccounts).values({ providerId: provider.id, status: 'not_started' });

    return toBusinessProfile(profile!, provider);
  });
}

// ---- THE BUSINESS'S OWN RECORD ----
export async function getBusinessProfile(db: Database, providerId: string) {
  const [row] = await db
    .select({ profile: providerBusinessProfiles, provider: providers })
    .from(providerBusinessProfiles)
    .innerJoin(providers, eq(providers.id, providerBusinessProfiles.providerId))
    .where(eq(providerBusinessProfiles.providerId, providerId))
    .limit(1);
  if (!row) throw notFound('We could not find that rental business.');
  return toBusinessProfile(row.profile, row.provider);
}

export type ProfilePatch = {
  // Shown to customers on the public page.
  description?: string | undefined;
  town?: string | undefined;
  phone?: string | undefined;
  deliversVehicles?: boolean | undefined;
  airportPickup?: boolean | undefined;
  // The private half.
  website?: string | undefined;
  legalName?: string | undefined;
  contactEmail?: string | undefined;
  ownerName?: string | undefined;
  ownerPhone?: string | undefined;
  fleetSizeBand?: string | undefined;
  locations?: string[] | undefined;
  operatingSide?: 'dutch' | 'french' | 'both' | undefined;
  // Moving the business's base to the other side. Needs a town on that side.
  side?: 'dutch' | 'french' | undefined;
};

// A business can edit its own description and details. It cannot make itself
// verified: that is a staff decision, so those fields are not touched here.
export async function updateBusinessProfile(db: Database, providerId: string, patch: ProfilePatch) {
  // MOVING SIDES. Allowed, because businesses do move — but only together with
  // a new base town that is actually on the new side, so the public page can
  // never say "French side, Philipsburg". Each car keeps its own pickup town:
  // a business moving its office does not mean every car moved with it.
  if (patch.side !== undefined) {
    if (!patch.town) {
      throw badRequest('town_required', 'Moving to the other side needs the new town as well.');
    }
    const town = findTown(patch.town, patch.side);
    if (!town || town.side !== patch.side) {
      const side = patch.side === 'dutch' ? 'Dutch' : 'French';
      throw badRequest('town_not_on_side', `That town is not on the ${side} side. For example: ${exampleTowns(patch.side)}.`);
    }
    patch = { ...patch, town: town.name };
  }
  const publicChanges = {
    ...(patch.side !== undefined ? { side: patch.side } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.town !== undefined ? { town: patch.town } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
    ...(patch.deliversVehicles !== undefined ? { deliversVehicles: patch.deliversVehicles } : {}),
    ...(patch.airportPickup !== undefined ? { airportPickup: patch.airportPickup } : {}),
  };
  const privateChanges = {
    ...(patch.website !== undefined ? { website: patch.website } : {}),
    ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
    ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail.trim().toLowerCase() } : {}),
    ...(patch.ownerName !== undefined ? { ownerName: patch.ownerName } : {}),
    ...(patch.ownerPhone !== undefined ? { ownerPhone: patch.ownerPhone } : {}),
    ...(patch.fleetSizeBand !== undefined ? { fleetSizeBand: patch.fleetSizeBand } : {}),
    ...(patch.locations !== undefined ? { locations: patch.locations } : {}),
    ...(patch.operatingSide !== undefined ? { operatingSide: patch.operatingSide } : {}),
  };

  if (Object.keys(publicChanges).length > 0) {
    await db.update(providers).set(publicChanges).where(eq(providers.id, providerId));
  }
  if (Object.keys(privateChanges).length > 0) {
    await db
      .update(providerBusinessProfiles)
      .set(privateChanges)
      .where(eq(providerBusinessProfiles.providerId, providerId));
  }
  return getBusinessProfile(db, providerId);
}

// ---- THE HEADLINE FIGURES ----
export async function getSummary(db: Database, providerId: string) {
  const since = new Date(Date.now() - PERFORMANCE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);

  const [fleet, payoutRows, bookingRows, [threads]] = await Promise.all([
    db
      .select({ rating: vehicles.rating, reviewCount: vehicles.reviewCount })
      .from(vehicles)
      .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt))),
    db.select().from(payouts).where(eq(payouts.providerId, providerId)),
    db
      .select({ status: bookings.status, startDate: bookings.startDate })
      .from(bookings)
      .where(eq(bookings.providerId, providerId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatThreads)
      .where(eq(chatThreads.providerId, providerId)),
  ]);

  const paidOutCents = payoutRows
    .filter((payout) => payout.status === 'paid')
    .reduce((sum, payout) => sum + payout.amountCents, 0);
  // ALL THREE FIGURES, FROM THE SAME ROWS. A business shown only the net has no
  // way to check the deduction was right, which is why the dashboard shows what
  // the customer paid, what was taken off, and what they receive, together.
  //
  // The website used to work the other two out backwards from its own copy of
  // the commission rate. The day that copy disagreed with the rate the backend
  // actually charges, the dashboard would have shown a business a commission it
  // was never charged, and nothing would have looked broken. These come off the
  // payout rows themselves, which the table already keeps consistent:
  // gross = amount + commission.
  const awaiting = payoutRows.filter((payout) => payout.status !== 'paid');
  const pendingCents = awaiting.reduce((sum, payout) => sum + payout.amountCents, 0);
  const pendingGrossCents = awaiting.reduce((sum, payout) => sum + payout.grossCents, 0);
  const pendingCommissionCents = awaiting.reduce((sum, payout) => sum + payout.commissionCents, 0);

  const rated = fleet.filter((vehicle) => vehicle.reviewCount > 0);
  const recentBookings = bookingRows.filter((booking) => booking.startDate >= since && booking.status !== 'cancelled');

  return {
    // Their share, after commission. Deposits are never counted here.
    paidOut: paidOutCents / 100,
    pending: pendingCents / 100,
    // What the customers paid, and what SXM Rentals took, for that same pending
    // money — so the three subtract exactly on screen.
    pendingGross: pendingGrossCents / 100,
    pendingCommission: pendingCommissionCents / 100,
    nextPayoutDate: nextPayoutDate(),
    activeBookings: bookingRows.filter((booking) => booking.status === 'active').length,
    upcomingBookings: bookingRows.filter((booking) => booking.status === 'upcoming').length,
    fleetSize: fleet.length,
    averageRating: rated.length > 0 ? rated.reduce((sum, v) => sum + v.rating, 0) / rated.length : 0,
    // NAMED FOR WHAT THEY ACTUALLY COUNT. These used to be called enquiries and
    // conversions, and the dashboard divided one by the other — which came out
    // at 300%, because most bookings never start with a conversation at all.
    // Counting them is useful; calling the result a conversion rate was not.
    //
    // Conversations ever, against bookings in the last 90 days: two different
    // windows, said out loud in the names rather than left to be discovered.
    totalConversations: threads?.count ?? 0,
    bookingsLast90Days: recentBookings.length,
    // The old names, kept for a release so the apps can move across without
    // breaking. Remove them once the website and phone app read the ones above.
    totalInquiries: threads?.count ?? 0,
    totalConversions: recentBookings.length,
  };
}

// ---- THE FLEET ----
// Every car the business has, including ones still waiting for staff approval —
// which is why this is not the same query as the public search.
export async function listFleet(db: Database, providerId: string) {
  const rows = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)))
    .orderBy(desc(vehicles.createdAt));
  return fleetView(db, rows);
}

// One car of the fleet, approved or not, in the same shape as the list.
export async function getFleetVehicle(db: Database, providerId: string, vehicleId: string) {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  const [view] = await fleetView(db, [vehicle]);
  return view!;
}

// The business's own view of some of its cars. Its unavailable days include
// days it blocked itself; the app takes the blocks away to show booked days.
async function fleetView(db: Database, rows: (typeof vehicles.$inferSelect)[]) {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [photos, accidents, taken] = await Promise.all([
    db.select().from(vehiclePhotos).where(inArray(vehiclePhotos.vehicleId, ids)),
    db.select().from(vehicleAccidentRecords).where(inArray(vehicleAccidentRecords.vehicleId, ids)),
    unavailableDatesFor(db, ids),
  ]);

  return rows.map((row) => ({
    ...toVehicle(
      row,
      photos.filter((photo) => photo.vehicleId === row.id),
      accidents.filter((accident) => accident.vehicleId === row.id),
      taken.get(row.id) ?? [],
    ),
    // Extra, for the business only: whether customers can see this car yet.
    ...businessExtras(row),
  }));
}

export type VehicleInput = {
  make: string;
  model: string;
  year: number;
  vehicleClass: 'economy' | 'compact' | 'suv' | 'van' | 'fourByFour' | 'luxury';
  transmission: 'automatic' | 'manual';
  fuel: 'petrol' | 'diesel' | 'hybrid' | 'electric';
  seats: number;
  doors: number;
  dailyRate: number;
  depositAmount: number;
  pickupTown: string;
  side: 'dutch' | 'french';
  latitude: number;
  longitude: number;
  trim?: string | undefined;
  weeklyRate?: number | undefined;
  minimumDays?: number | undefined;
  maximumDays?: number | undefined;
  airConditioning?: boolean | undefined;
  deliveryAvailable?: boolean | undefined;
  // Dollars, per rental. 0 or missing: free delivery.
  deliveryFee?: number | undefined;
  description?: string | undefined;
  registration?: string | undefined;
  accidentHistoryDeclared?: boolean | undefined;
  accidentHistory?: AccidentRecordInput[] | undefined;
};

// A number plate as it is stored: capitals, single spaces. "p 1234" and
// "P-1234" stay different — the dash is part of how the island writes them.
export function normaliseRegistration(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

// What only the business (and staff) see about its own car, on top of what a
// customer sees: whether it is on the site yet, its reference and its plate.
function businessExtras(vehicle: typeof vehicles.$inferSelect) {
  return { listingStatus: vehicle.listingStatus, reference: vehicle.reference, registration: vehicle.registration };
}

// Two cars in one fleet with the same plate is a mistake, answered in words.
function registrationTaken(error: unknown, registration: string | null | undefined): AppError | null {
  const cause = (error as { cause?: { code?: string; constraint?: string } })?.cause;
  if (cause?.code === '23505' && cause.constraint === 'vehicles_provider_registration_unique') {
    return new AppError(409, 'registration_taken', `Already in your fleet (registration ${registration}).`);
  }
  return null;
}

// What the business declares about the car's past. SXM Rentals does not check
// it, and the car's page says so.
//
// AN EMPTY LIST IS NOT THE SAME AS "NO ACCIDENTS", which is why this could not
// stay unsettable: every car had an empty history because there was no way to
// record one, and a customer reads an empty history as a clean one. The car page
// used to show a green tick for it.
export type AccidentRecordInput = { date: string; description: string; repaired: boolean };

// The declared history, replaced wholesale rather than merged: the form shows the
// whole list and sends the whole list back, so anything else would leave behind a
// row the business thought it had deleted.
async function replaceAccidentHistory(db: Database, vehicleId: string, records: AccidentRecordInput[]) {
  await db.delete(vehicleAccidentRecords).where(eq(vehicleAccidentRecords.vehicleId, vehicleId));
  if (records.length === 0) return;
  await db.insert(vehicleAccidentRecords).values(
    records.map((record) => ({
      vehicleId,
      // The API calls it "date"; the column is occurred_on.
      occurredOn: record.date,
      description: record.description,
      repaired: record.repaired,
    })),
  );
}

// A new car waits for staff approval before customers can see it.
// Normally a new car waits for staff approval before customers can see it.
// approvalRequired is false only while the owner has switched approval off
// (VEHICLE_APPROVAL=off), and then the car goes on the site straight away.
export async function addVehicle(db: Database, providerId: string, input: VehicleInput, approvalRequired = true) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // In its own savepoint, so a clash can be retried even when this runs
      // inside a larger transaction (a spreadsheet import).
      const [vehicle] = await db.transaction(async (attempt) =>
        attempt
        .insert(vehicles)
        .values({
          reference: `SXM-V-${100 + Math.floor(Math.random() * 9900)}`,
          providerId,
          make: input.make,
          model: input.model,
          year: input.year,
          trim: input.trim,
          vehicleClass: input.vehicleClass,
          transmission: input.transmission,
          fuel: input.fuel,
          seats: input.seats,
          doors: input.doors,
          airConditioning: input.airConditioning ?? true,
          dailyRateCents: Math.round(input.dailyRate * 100),
          weeklyRateCents: input.weeklyRate === undefined ? null : Math.round(input.weeklyRate * 100),
          minimumDays: input.minimumDays ?? 1,
          maximumDays: input.maximumDays ?? 30,
          depositAmountCents: Math.round(input.depositAmount * 100),
          depositIsVehicleSpecific: true,
          pickupTown: input.pickupTown,
          side: input.side,
          deliveryAvailable: input.deliveryAvailable ?? false,
          deliveryFeeCents: input.deliveryFee ? Math.round(input.deliveryFee * 100) : null,
          latitude: input.latitude,
          longitude: input.longitude,
          description: input.description ?? '',
          registration: input.registration ? normaliseRegistration(input.registration) : null,
          // Declaring accidents answers the question as surely as saying "none".
          accidentHistoryDeclared: input.accidentHistoryDeclared ?? Boolean(input.accidentHistory?.length),
          listingStatus: approvalRequired ? 'pending_review' : 'live',
          // On sale from the moment it is added, while approval is switched off.
          listedAt: approvalRequired ? null : new Date(),
        })
        .returning(),
      );
      if (vehicle) {
        if (input.accidentHistory?.length) await replaceAccidentHistory(db, vehicle.id, input.accidentHistory);
        const accidents = input.accidentHistory?.length
          ? await db.select().from(vehicleAccidentRecords).where(eq(vehicleAccidentRecords.vehicleId, vehicle.id))
          : [];
        return { ...toVehicle(vehicle, [], accidents, []), ...businessExtras(vehicle) };
      }
    } catch (error) {
      const taken = registrationTaken(error, input.registration && normaliseRegistration(input.registration));
      if (taken) throw taken;
      const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code;
      if (code !== '23505') throw error;
    }
  }
  throw new Error('Could not allocate a vehicle reference');
}

// One of this business's own cars, or "not found".
async function loadOwnVehicle(db: Database, providerId: string, vehicleId: string) {
  if (!isUuid(vehicleId)) throw notFound('We could not find that vehicle.');
  const [vehicle] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)))
    .limit(1);
  if (!vehicle) throw notFound('We could not find that vehicle.');
  return vehicle;
}

export type VehiclePatch = Omit<Partial<VehicleInput>, 'weeklyRate' | 'registration'> & {
  registration?: string | null | undefined;
  // A number sets it, null takes it away, missing leaves it alone. The three
  // have to be distinguishable or a weekly rate can never be removed.
  weeklyRate?: number | null | undefined;
};

// Fields that say WHICH CAR THIS IS. Changing them would turn one car into
// another while it kept its reviews, its bookings and its history — so they are
// refused outright rather than silently ignored, which is what happened before:
// the request was accepted, answered 200, and changed nothing.
const FIXED_VEHICLE_FIELDS = ['make', 'model', 'year', 'vehicleClass', 'transmission', 'fuel'] as const;

export async function updateVehicle(db: Database, providerId: string, vehicleId: string, patch: VehiclePatch) {
  const existing = await loadOwnVehicle(db, providerId, vehicleId);

  const fixed = FIXED_VEHICLE_FIELDS.filter((field) => patch[field] !== undefined);
  if (fixed.length > 0) {
    throw new AppError(
      400,
      'field_not_editable',
      `A car's ${fixed.join(', ')} cannot be changed — its reviews and past rentals belong to this car. Take it off the platform and add the new one instead.`,
    );
  }

  const changes = {
    ...(patch.dailyRate !== undefined ? { dailyRateCents: Math.round(patch.dailyRate * 100) } : {}),
    // null clears a weekly rate. A missing value means "no change", so without
    // this there was no way to take one away once it had been set.
    ...(patch.weeklyRate !== undefined
      ? { weeklyRateCents: patch.weeklyRate === null ? null : Math.round(patch.weeklyRate * 100) }
      : {}),
    ...(patch.depositAmount !== undefined ? { depositAmountCents: Math.round(patch.depositAmount * 100) } : {}),
    ...(patch.minimumDays !== undefined ? { minimumDays: patch.minimumDays } : {}),
    ...(patch.maximumDays !== undefined ? { maximumDays: patch.maximumDays } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    // THESE FOUR TRAVEL TOGETHER. A car moved from Simpson Bay to Marigot used to
    // say Marigot, sit on the map back in Simpson Bay, and still come up under
    // the Dutch side in search, because only the town was ever saved.
    ...(patch.pickupTown !== undefined ? { pickupTown: patch.pickupTown } : {}),
    ...(patch.side !== undefined ? { side: patch.side } : {}),
    ...(patch.latitude !== undefined ? { latitude: patch.latitude } : {}),
    ...(patch.longitude !== undefined ? { longitude: patch.longitude } : {}),
    ...(patch.deliveryAvailable !== undefined ? { deliveryAvailable: patch.deliveryAvailable } : {}),
    // 0 makes delivery free again; there is no separate "remove the fee".
    ...(patch.deliveryFee !== undefined
      ? { deliveryFeeCents: patch.deliveryFee ? Math.round(patch.deliveryFee * 100) : null }
      : {}),
    ...(patch.airConditioning !== undefined ? { airConditioning: patch.airConditioning } : {}),
    ...(patch.seats !== undefined ? { seats: patch.seats } : {}),
    ...(patch.doors !== undefined ? { doors: patch.doors } : {}),
    ...(patch.trim !== undefined ? { trim: patch.trim } : {}),
    ...(patch.registration !== undefined
      ? { registration: patch.registration === null ? null : normaliseRegistration(patch.registration) }
      : {}),
    ...(patch.accidentHistoryDeclared !== undefined ? { accidentHistoryDeclared: patch.accidentHistoryDeclared } : {}),
    // Sending a history with accidents in it answers the question too.
    ...(patch.accidentHistory?.length ? { accidentHistoryDeclared: true } : {}),
  };
  if (patch.accidentHistory !== undefined) {
    await replaceAccidentHistory(db, existing.id, patch.accidentHistory);
  }

  let updated: typeof vehicles.$inferSelect | undefined = existing;
  if (Object.keys(changes).length > 0) {
    try {
      [updated] = await db.update(vehicles).set(changes).where(eq(vehicles.id, existing.id)).returning();
    } catch (error) {
      throw registrationTaken(error, changes.registration) ?? error;
    }
  }
  // Answered with what the car now has, rather than an empty list, so the form
  // shows what it just saved instead of appearing to have lost it.
  const accidents = await db
    .select()
    .from(vehicleAccidentRecords)
    .where(eq(vehicleAccidentRecords.vehicleId, existing.id));
  return { ...toVehicle(updated!, [], accidents, []), ...businessExtras(updated!) };
}

// Taking a car off the platform. Refused while somebody is due to collect it:
// removing it then would strand a real booking.
export async function removeVehicle(db: Database, providerId: string, vehicleId: string) {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  const [liveBooking] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.vehicleId, vehicle.id),
        inArray(bookings.status, ['upcoming', 'active']),
      ),
    )
    .limit(1);
  if (liveBooking) {
    throw conflict('vehicle_has_bookings', 'This vehicle has a rental coming up, so it cannot be removed yet.');
  }
  await db
    .update(vehicles)
    .set({ deletedAt: new Date(), listingStatus: 'suspended' })
    .where(eq(vehicles.id, vehicle.id));
}

// ---- HOW EACH CAR IS DOING ----
export async function listPerformance(db: Database, providerId: string) {
  const windowStart = new Date(Date.now() - PERFORMANCE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  const [fleet, rows, threadRows] = await Promise.all([
    db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt))),
    db
      .select({
        vehicleId: bookings.vehicleId,
        payoutCents: bookings.payoutCents,
        grossCents: bookings.grossCents,
        commissionCents: bookings.commissionCents,
        startDate: bookings.startDate,
        endDate: bookings.endDate,
        // Both are needed to tell money that has been earned from money that is
        // only booked: a rental counts as earned when it is over AND paid for.
        status: bookings.status,
        paymentStatus: bookings.paymentStatus,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.providerId, providerId),
          ne(bookings.status, 'cancelled'),
          sql`${bookings.endDate} >= ${windowStart}`,
        ),
      ),
    db
      .select({ vehicleId: chatThreads.vehicleId, count: sql<number>`count(*)::int` })
      .from(chatThreads)
      .where(eq(chatThreads.providerId, providerId))
      .groupBy(chatThreads.vehicleId),
  ]);

  return fleet.map((vehicle) => {
    const forVehicle = rows.filter((row) => row.vehicleId === vehicle.id);
    // Days the car was actually out, counting only days inside the window.
    const daysOut = forVehicle.reduce(
      (sum, row) => sum + daysBetween(row.startDate, row.endDate).filter((day) => day >= windowStart && day <= todayIso).length,
      0,
    );
    // Earned is over and paid for. Everything else is booked: still to come, or
    // finished and not yet paid.
    const earned = forVehicle.filter((row) => row.status === 'completed' && row.paymentStatus === 'paid');
    const booked = forVehicle.filter((row) => !(row.status === 'completed' && row.paymentStatus === 'paid'));

    return toVehiclePerformance({
      vehicleId: vehicle.id,
      // Their share, after commission, in both cases — and what the renters
      // paid and the commission on it, from the bookings themselves, since the
      // rate can change and working them out from today's rate would be wrong.
      earnedCents: earned.reduce((sum, row) => sum + row.payoutCents, 0),
      bookedCents: booked.reduce((sum, row) => sum + row.payoutCents, 0),
      grossEarnedCents: earned.reduce((sum, row) => sum + row.grossCents, 0),
      commissionEarnedCents: earned.reduce((sum, row) => sum + row.commissionCents, 0),
      grossBookedCents: booked.reduce((sum, row) => sum + row.grossCents, 0),
      commissionBookedCents: booked.reduce((sum, row) => sum + row.commissionCents, 0),
      bookings: forVehicle.length,
      daysOut,
      daysInPeriod: PERFORMANCE_WINDOW_DAYS,
      conversations: threadRows.find((thread) => thread.vehicleId === vehicle.id)?.count ?? 0,
    });
  });
}

// ---- BOOKINGS ACROSS THE FLEET ----
// Built through the provider serializer, which has no field for a customer's
// phone number or email.
export async function listProviderBookings(db: Database, providerId: string) {
  const rows = await db
    .select({ booking: bookings, renter: customers })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(eq(bookings.providerId, providerId))
    .orderBy(desc(bookings.startDate));
  if (rows.length === 0) return [];

  const depositRows = await db
    .select()
    .from(deposits)
    .where(inArray(deposits.bookingId, rows.map((row) => row.booking.id)));

  const [cars, threads, changes] = await Promise.all([
    carSummariesFor(db, rows.map((row) => row.booking.vehicleId)),
    // The conversation about each booking, so the business can open it from the
    // booking. ProviderBooking has always had a place for this and no caller
    // ever filled it, so the field was permanently absent.
    threadIdsForBookings(db, rows.map((row) => row.booking.id)),
    latestDateChanges(db, rows.map((row) => row.booking.id)),
  ]);

  return rows.map((row) =>
    toProviderBooking(
      row.booking,
      depositRows.find((deposit) => deposit.bookingId === row.booking.id),
      {
        firstName: row.renter.firstName,
        lastName: row.renter.lastName,
        verificationStatus: row.renter.verificationStatus,
      },
      cars.get(row.booking.vehicleId) ?? null,
      threads.get(row.booking.id),
      changes.has(row.booking.id) ? providerDateChange(changes.get(row.booking.id)!) : null,
    ),
  );
}

export async function getProviderBooking(db: Database, providerId: string, bookingId: string) {
  if (!isUuid(bookingId)) throw notFound('We could not find that booking.');
  const [row] = await db
    .select({ booking: bookings, renter: customers })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, providerId)))
    .limit(1);
  if (!row) throw notFound('We could not find that booking.');

  const [[deposit], vehicle, threads, changes] = await Promise.all([
    db.select().from(deposits).where(eq(deposits.bookingId, row.booking.id)).limit(1),
    carSummaryFor(db, row.booking.vehicleId),
    threadIdsForBookings(db, [row.booking.id]),
    latestDateChanges(db, [row.booking.id]),
  ]);
  return toProviderBooking(
    row.booking,
    deposit,
    {
      firstName: row.renter.firstName,
      lastName: row.renter.lastName,
      verificationStatus: row.renter.verificationStatus,
    },
    vehicle,
    threads.get(row.booking.id),
    changes.has(row.booking.id) ? providerDateChange(changes.get(row.booking.id)!) : null,
  );
}

// ---- WHAT THEY HAVE BEEN PAID ----
export async function listPayouts(db: Database, providerId: string) {
  const rows = await db
    .select()
    .from(payouts)
    .where(eq(payouts.providerId, providerId))
    .orderBy(desc(payouts.periodEnd));
  return rows.map(toPayoutRecord);
}

// ---- WHERE THE MONEY GOES ----
// The business gives its bank details to Stripe directly, through a one-time
// link. Those details never pass through this server.
export async function startPayoutOnboarding(
  db: Database,
  gateway: PaymentGateway,
  config: Config,
  providerId: string,
  // Where Stripe sends the business when they finish. The website by default;
  // for the phone app, an https address on this API that hands over to the app
  // (Stripe will not send somebody to an app's own address directly).
  returnUrl?: string,
  // Where the business's bank account is. Stripe pays US and French-side banks
  // (the French side counts as France); it cannot pay Sint Maarten, so a
  // Dutch-side bank is paid by bank transfer from SXM Rentals instead.
  bankCountry?: 'US' | 'FR' | 'SX',
) {
  const [row] = await db
    .select({ account: providerPayoutAccounts, provider: providers, profile: providerBusinessProfiles })
    .from(providerPayoutAccounts)
    .innerJoin(providers, eq(providers.id, providerPayoutAccounts.providerId))
    .innerJoin(providerBusinessProfiles, eq(providerBusinessProfiles.providerId, providerPayoutAccounts.providerId))
    .where(eq(providerPayoutAccounts.providerId, providerId))
    .limit(1);
  if (!row) throw notFound('We could not find that rental business.');

  let accountId = row.account.stripeAccountId;
  if (!accountId) {
    // A French-side business banks in France unless it says otherwise. Anybody
    // else has to say: a Dutch-side business may bank in the US or locally.
    const country = bankCountry ?? (row.provider.side === 'french' ? 'FR' : undefined);
    if (!country) {
      throw badRequest(
        'bank_country_needed',
        'Tell us where your bank account is: in the United States, in France (the French side), or on the Dutch side.',
      );
    }
    if (country === 'SX') {
      await db
        .update(providerPayoutAccounts)
        .set({ country: 'SX', method: 'bank_transfer', status: 'pending' })
        .where(eq(providerPayoutAccounts.providerId, providerId));
      return {
        url: null,
        method: 'bank_transfer' as const,
        message:
          'Businesses banking on the Dutch side are paid by bank transfer from SXM Rentals. Our team will contact you for your bank details.',
      };
    }
    const created = await gateway.createConnectedAccount({
      providerId,
      businessName: row.provider.businessName,
      email: row.profile.contactEmail,
      country,
    });
    accountId = created.id;
    await db
      .update(providerPayoutAccounts)
      .set({ stripeAccountId: accountId, status: 'pending', country, method: 'stripe' })
      .where(eq(providerPayoutAccounts.providerId, providerId));
  }

  const back = returnUrl ?? `${config.appUrl}/provider/payouts`;
  const link = await gateway.createAccountOnboardingLink({ accountId, returnUrl: back, refreshUrl: back });
  return { url: link.url, method: 'stripe' as const, message: null };
}

export async function getPayoutAccount(db: Database, gateway: PaymentGateway, providerId: string) {
  const [account] = await db
    .select()
    .from(providerPayoutAccounts)
    .where(eq(providerPayoutAccounts.providerId, providerId))
    .limit(1);
  if (!account) throw notFound('We could not find that rental business.');

  // Ask Stripe for the current state where we can, so the dashboard is not
  // stale while a business is part-way through giving their details.
  if (account.stripeAccountId) {
    const live = await gateway.getConnectedAccount(account.stripeAccountId).catch(() => null);
    if (live) {
      const status = live.payoutsEnabled ? 'active' : live.outstanding.length > 0 ? 'pending' : account.status;
      await db
        .update(providerPayoutAccounts)
        .set({ payoutsEnabled: live.payoutsEnabled, outstanding: live.outstanding, status })
        .where(eq(providerPayoutAccounts.providerId, providerId));
      return {
        status,
        payoutsEnabled: live.payoutsEnabled,
        outstanding: live.outstanding,
        country: account.country,
        method: account.method,
      };
    }
  }

  return {
    status: account.status,
    payoutsEnabled: account.payoutsEnabled,
    outstanding: account.outstanding,
    country: account.country,
    // "stripe", or "bank_transfer" for a bank Stripe cannot pay (Dutch side).
    method: account.method,
  };
}

// ---- CLOSING THE BUSINESS ----
// What a business owner does when they stop renting cars out. It is refused
// while money is in the air, for the same reason a customer's account is: a
// closed business with a rental running, a deposit held on somebody's card, or
// a payout still owed leaves money nobody can chase.
//
// Every car is taken off the site and the business is marked closed. The rows
// stay: past bookings, the payouts already made and the audit trail all point
// at them, and every public query already hides a closed business.
//
// It does not close the owner's own customer account — they may still rent a
// car themselves.
export async function closeBusiness(
  db: Database,
  providerId: string,
  // Who will read the refusal. Staff are not the business, so "a payment to you
  // is still on its way" is wrong when the panel shows it to a staff member.
  audience: 'owner' | 'staff' = 'owner',
) {
  const them = audience === 'staff' ? 'them' : 'you';
  const [provider] = await db
    .select({ name: providers.businessName, deletedAt: providers.deletedAt })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  if (!provider) throw notFound();
  if (provider.deletedAt) throw conflict('already_closed', 'This business is already closed.');

  const [liveBooking] = await db
    .select({ reference: bookings.reference, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.providerId, providerId), inArray(bookings.status, ['upcoming', 'active'])))
    .limit(1);
  if (liveBooking) {
    throw conflict(
      'has_live_rental',
      `A rental is ${liveBooking.status} (${liveBooking.reference}). The business can be closed once it is finished.`,
    );
  }

  const [heldDeposit] = await db
    .select({ id: deposits.id })
    .from(deposits)
    .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
    .where(and(eq(bookings.providerId, providerId), eq(deposits.status, 'held')))
    .limit(1);
  if (heldDeposit) {
    throw conflict(
      'has_held_deposit',
      'A deposit is still being held on a customer\'s card. The business can be closed once it has been dealt with.',
    );
  }

  // Money still owed TO the business. Closing now would be closing over the
  // top of a payment that has not arrived.
  const [pendingPayout] = await db
    .select({ reference: payouts.reference })
    .from(payouts)
    .where(and(eq(payouts.providerId, providerId), inArray(payouts.status, ['pending', 'processing'])))
    .limit(1);
  if (pendingPayout) {
    throw conflict(
      'payout_pending',
      `A payment to ${them} is still on its way (${pendingPayout.reference}). The business can be closed once it has arrived.`,
    );
  }

  const closedAt = new Date();
  const delisted = await db.transaction(async (tx) => {
    // Suspended, not deleted: the cars keep their history, their reviews and
    // their place in past bookings, and staff can see what happened.
    const rows = await tx
      .update(vehicles)
      .set({ listingStatus: 'suspended' })
      .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)))
      .returning({ id: vehicles.id });
    await tx.update(providers).set({ deletedAt: closedAt }).where(eq(providers.id, providerId));
    return rows.length;
  });

  return { businessName: provider.name, closedAt: closedAt.toISOString(), vehiclesDelisted: delisted };
}

// ---- CAR PHOTOS ----
// A listing with no photo is not a listing anybody books, so this is the part of
// adding a car that actually sells it.
//
// The photo goes from the business's phone straight to Cloudinary, never through
// this server (see lib/storage.ts for why). Three steps:
//
//   1. ask for a ticket    POST /providers/me/vehicles/:id/photos/upload-ticket
//   2. upload to Cloudinary with the ticket's fields — the app does this itself
//   3. tell us the address POST /providers/me/vehicles/:id/photos
//
// Each car has its own folder, the ticket is only valid for that folder, and in
// step 3 an address outside it is refused — so one business cannot attach a
// photo to another's car, or point a listing at somewhere else on the internet.

// Enough for every angle of a car and the interior, without one business filling
// the storage on its own.
const MAX_PHOTOS_PER_VEHICLE = 12;

// Both the folder a ticket is signed for and the folder an address must sit in,
// worked out the same way each time so the two cannot disagree.
function photoFolder(providerId: string, vehicleId: string): string {
  return `sxm-rentals/vehicles/${providerId}/${vehicleId}`;
}

export async function photoUploadTicket(
  db: Database,
  storage: PhotoStorage,
  providerId: string,
  vehicleId: string,
) {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  const existing = await db
    .select({ id: vehiclePhotos.id })
    .from(vehiclePhotos)
    .where(eq(vehiclePhotos.vehicleId, vehicle.id));
  if (existing.length >= MAX_PHOTOS_PER_VEHICLE) {
    throw conflict(
      'too_many_photos',
      `This car already has ${MAX_PHOTOS_PER_VEHICLE} photos. Remove one before adding another.`,
    );
  }

  const ticket = storage.ticketFor(photoFolder(providerId, vehicle.id));
  return { ...ticket, photosAllowed: MAX_PHOTOS_PER_VEHICLE - existing.length };
}

// Step 3: the address the upload produced. The first photo added is the one
// shown in search results, until the business reorders them.
export async function attachVehiclePhoto(
  db: Database,
  storage: PhotoStorage,
  providerId: string,
  vehicleId: string,
  input: { url: string },
) {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  if (!storage.ownsAddress(input.url, photoFolder(providerId, vehicle.id))) {
    // Deliberately not "that address is not allowed because…": there is nothing
    // to learn here by trying variations.
    throw new AppError(
      400,
      'photo_not_recognised',
      'That photo was not uploaded for this car. Ask for a new upload ticket and try again.',
    );
  }

  const existing = await db
    .select({ id: vehiclePhotos.id, storageKey: vehiclePhotos.storageKey, position: vehiclePhotos.position })
    .from(vehiclePhotos)
    .where(eq(vehiclePhotos.vehicleId, vehicle.id));
  if (existing.length >= MAX_PHOTOS_PER_VEHICLE) {
    throw conflict('too_many_photos', `This car already has ${MAX_PHOTOS_PER_VEHICLE} photos.`);
  }
  // Uploading the same photo twice — a retry after a dropped connection — must
  // not leave the listing showing it twice.
  if (existing.some((photo) => photo.storageKey === input.url)) {
    return listVehiclePhotos(db, vehicle.id);
  }

  const nextPosition = existing.reduce((highest, photo) => Math.max(highest, photo.position), -1) + 1;
  await db.insert(vehiclePhotos).values({ vehicleId: vehicle.id, storageKey: input.url, position: nextPosition });
  return listVehiclePhotos(db, vehicle.id);
}

export async function removeVehiclePhoto(
  db: Database,
  storage: PhotoStorage,
  providerId: string,
  vehicleId: string,
  photoId: string,
) {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  if (!isUuid(photoId)) throw notFound();

  const [photo] = await db
    .select()
    .from(vehiclePhotos)
    .where(and(eq(vehiclePhotos.id, photoId), eq(vehiclePhotos.vehicleId, vehicle.id)))
    .limit(1);
  // Somebody else's photo id gets "not found", exactly like one that does not
  // exist — the same rule as everywhere else.
  if (!photo) throw notFound();

  await db.delete(vehiclePhotos).where(eq(vehiclePhotos.id, photo.id));
  // Close the gap it left, so positions stay 0,1,2… and "first" keeps meaning
  // the cover photo.
  const remaining = await db
    .select({ id: vehiclePhotos.id })
    .from(vehiclePhotos)
    .where(eq(vehiclePhotos.vehicleId, vehicle.id))
    .orderBy(vehiclePhotos.position, vehiclePhotos.createdAt);
  await Promise.all(
    remaining.map((row, index) =>
      db.update(vehiclePhotos).set({ position: index }).where(eq(vehiclePhotos.id, row.id)),
    ),
  );

  // The listing has already lost it; the file going too is best effort.
  await storage.remove(photo.storageKey);
  return listVehiclePhotos(db, vehicle.id);
}

// The order decides which photo sells the car, so a business can set it.
export async function reorderVehiclePhotos(
  db: Database,
  providerId: string,
  vehicleId: string,
  input: { order: string[] },
) {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  const photos = await db.select().from(vehiclePhotos).where(eq(vehiclePhotos.vehicleId, vehicle.id));

  // Every photo, each one once: a partial list would leave the rest in an order
  // nobody chose.
  const given = new Set(input.order);
  if (given.size !== input.order.length || given.size !== photos.length) {
    throw new AppError(400, 'incomplete_order', 'List every photo of this car exactly once, in the order you want.');
  }
  const known = new Set(photos.map((photo) => photo.id));
  if (input.order.some((id) => !known.has(id))) throw notFound();

  await Promise.all(
    input.order.map((id, index) =>
      db.update(vehiclePhotos).set({ position: index }).where(eq(vehiclePhotos.id, id)),
    ),
  );
  return listVehiclePhotos(db, vehicle.id);
}

// What the business's own screens show: the id is needed to remove or reorder,
// which is why this is not just the list of addresses customers get.
export async function listVehiclePhotos(db: Database, vehicleId: string) {
  const rows = await db
    .select()
    .from(vehiclePhotos)
    .where(eq(vehiclePhotos.vehicleId, vehicleId))
    .orderBy(vehiclePhotos.position, vehiclePhotos.createdAt);
  return rows.map((row, index) => ({
    id: row.id,
    url: row.storageKey,
    position: row.position,
    // The one customers see first in search results.
    isCover: index === 0,
  }));
}

// Confirms a car belongs to this business and returns its id, for the screens
// that only need to look. A car belonging to somebody else is "not found",
// never "not yours".
export async function ownVehicleId(db: Database, providerId: string, vehicleId: string): Promise<string> {
  const vehicle = await loadOwnVehicle(db, providerId, vehicleId);
  return vehicle.id;
}

// ---- OPENING A CLOSED BUSINESS AGAIN ----
// Staff only, from the admin panel. A business closed by mistake, or by the
// wrong person in a family argument, was otherwise a support call that needed
// somebody with database access.
//
// EVERY CAR STAYS SUSPENDED. Reopening says "this business may trade again", not
// "put its whole fleet back on the site": each car goes live again deliberately,
// through the approval that every listing goes through.
export async function reopenBusiness(db: Database, providerId: string) {
  const [provider] = await db
    .select({ name: providers.businessName, deletedAt: providers.deletedAt })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  if (!provider) throw notFound();
  if (!provider.deletedAt) throw conflict('not_closed', 'This business is not closed.');

  // Somebody has to be able to act for it. Closing an account removes its
  // memberships, so a business whose owner then closed their own account would
  // come back with nobody able to sign in for it — cars listed, nobody home.
  const [owner] = await db
    .select({ customerId: providerMembers.customerId })
    .from(providerMembers)
    .innerJoin(customers, eq(customers.id, providerMembers.customerId))
    .where(
      and(
        eq(providerMembers.providerId, providerId),
        eq(providerMembers.role, 'owner'),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  if (!owner) {
    throw conflict(
      'no_owner',
      'Nobody can act for this business any more — its owner closed their account. It cannot be opened again.',
    );
  }

  await db.update(providers).set({ deletedAt: null }).where(eq(providers.id, providerId));
  const suspended = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)));
  return { businessName: provider.name, vehiclesStillSuspended: suspended.length };
}
