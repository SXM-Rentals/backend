// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what a rental business does with its own cars and
// its own figures — declaring a car's accident history, moving a car to the other
// side of the island, clearing a weekly rate, writing to a renter first, and
// being shown all three money figures rather than only the net.
//
// The tests that matter most:
//
//   - a car moved to another town takes its side and its map position with it.
//     Only the town used to be saved, so a car moved to Marigot said Marigot, sat
//     on the map back in Simpson Bay, and still came up under the Dutch side;
//   - a field that cannot be edited is REFUSED rather than quietly ignored. It
//     used to answer 200 and change nothing, which is the worst of both;
//   - the pending money figures come off the payout rows, so gross minus
//     commission is exactly the net. The website used to work two of the three
//     out backwards from its own copy of the commission rate.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { payouts, vehicleAccidentRecords, vehicles } from '../src/db/schema/index.js';
import {
  createTestContext,
  createVerifiedAccount,
  dateIn,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let owner: string;
let providerId: string;

const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const get = (url: string, bearer = owner) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(bearer), remoteAddress: uniqueIp() });
const post = (url: string, payload: object, bearer = owner) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: auth(bearer), remoteAddress: uniqueIp() });
const patch = (url: string, payload: object, bearer = owner) =>
  ctx.app.inject({ method: 'PATCH', url: `/api/v1${url}`, payload, headers: auth(bearer), remoteAddress: uniqueIp() });

const car = (make: string) => ({
  make,
  model: 'Picanto',
  year: 2024,
  vehicleClass: 'economy' as const,
  transmission: 'automatic' as const,
  fuel: 'petrol' as const,
  seats: 4,
  doors: 4,
  dailyRate: 45,
  depositAmount: 300,
  pickupTown: 'Simpson Bay',
  side: 'dutch' as const,
  latitude: 18.03,
  longitude: -63.09,
});

// A new listing waits for staff approval, so tests that need a customer to see a
// car approve it the way staff would.
const approve = (vehicleId: string) =>
  ctx.db.update(vehicles).set({ listingStatus: 'live' }).where(eq(vehicles.id, vehicleId));

beforeAll(async () => {
  ctx = await createTestContext();
  const account = await createVerifiedAccount(ctx);
  owner = await signInMobile(ctx, account.email, account.password);
  const applied = await post('/providers/apply', {
    businessName: 'Fleet Figures Rentals',
    legalName: 'Fleet Figures Rentals N.V.',
    contactEmail: 'hello@fleetfigures.sx',
    ownerName: 'Marie Richardson',
    ownerPhone: '+1 721 555 0188',
    town: 'Simpson Bay',
    side: 'dutch',
    operatingSide: 'dutch',
    description: 'Family run.',
    deliversVehicles: false,
  });
  if (applied.statusCode !== 201) throw new Error(`Registering failed: ${applied.body}`);
  providerId = applied.json().providerId;
});
afterAll(async () => {
  await ctx.close();
});

describe('the accident history a business declares', () => {
  it('is saved when the car is added, and comes back with it', async () => {
    const added = await post('/providers/me/vehicles', {
      ...car('Suzuki'),
      accidentHistory: [
        { date: '2025-03-14', description: 'Rear bumper, parked. Repaired at the dealer.', repaired: true },
      ],
    });
    expect(added.statusCode).toBe(201);
    // Answered with what was saved, rather than an empty list the form would
    // read as having lost it.
    expect(added.json().accidentHistory).toMatchObject([{ date: '2025-03-14', repaired: true }]);

    const rows = await ctx.db
      .select()
      .from(vehicleAccidentRecords)
      .where(eq(vehicleAccidentRecords.vehicleId, added.json().id));
    expect(rows).toHaveLength(1);
  });

  it('is replaced wholesale when edited, so a deleted entry stays deleted', async () => {
    const added = await post('/providers/me/vehicles', {
      ...car('Toyota'),
      accidentHistory: [
        { date: '2024-01-05', description: 'Wing mirror.', repaired: true },
        { date: '2025-06-20', description: 'Scratch along the door.', repaired: false },
      ],
    });

    const edited = await patch(`/providers/me/vehicles/${added.json().id}`, {
      accidentHistory: [{ date: '2025-06-20', description: 'Scratch along the door.', repaired: true }],
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().accidentHistory).toHaveLength(1);
    expect(edited.json().accidentHistory[0]).toMatchObject({ date: '2025-06-20', repaired: true });

    // An empty list clears it, which is a statement the business made rather
    // than the absence of one.
    const cleared = await patch(`/providers/me/vehicles/${added.json().id}`, { accidentHistory: [] });
    expect(cleared.json().accidentHistory).toEqual([]);
  });

  it('reaches the customer on the car page, which is the whole point', async () => {
    const added = await post('/providers/me/vehicles', {
      ...car('Hyundai'),
      accidentHistory: [{ date: '2025-02-02', description: 'Front panel.', repaired: true }],
    });
    await approve(added.json().id);

    const publicly = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/${added.json().id}`,
      remoteAddress: uniqueIp(),
    });
    expect(publicly.statusCode).toBe(200);
    expect(publicly.json().accidentHistory).toMatchObject([{ date: '2025-02-02', repaired: true }]);
  });
});

describe('moving and repricing a car', () => {
  it('takes its side and its place on the map with its town', async () => {
    const added = await post('/providers/me/vehicles', car('Kia'));

    const moved = await patch(`/providers/me/vehicles/${added.json().id}`, {
      pickupTown: 'Marigot',
      side: 'french',
      latitude: 18.0706,
      longitude: -63.0847,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ pickupTown: 'Marigot', side: 'french' });

    // And search agrees it is a French-side car now, rather than still answering
    // under the Dutch side.
    await approve(added.json().id);
    const french = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/vehicles?side=french',
      remoteAddress: uniqueIp(),
    });
    expect(french.json().some((v: { id: string }) => v.id === added.json().id)).toBe(true);
    const dutch = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/vehicles?side=dutch',
      remoteAddress: uniqueIp(),
    });
    expect(dutch.json().some((v: { id: string }) => v.id === added.json().id)).toBe(false);
  });

  it('refuses to change which car it is, instead of ignoring it', async () => {
    const added = await post('/providers/me/vehicles', car('Nissan'));

    const refused = await patch(`/providers/me/vehicles/${added.json().id}`, { make: 'Ferrari', year: 2026 });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('field_not_editable');
    // It names the fields, so the form can say why.
    expect(refused.json().error.message).toContain('make');

    const fleet = await get('/providers/me/vehicles');
    expect(fleet.json().find((v: { id: string }) => v.id === added.json().id).make).toBe('Nissan');
  });

  it('lets a weekly rate be taken away once it has been set', async () => {
    const added = await post('/providers/me/vehicles', { ...car('Honda'), weeklyRate: 250 });
    expect(added.json().weeklyRate).toBe(250);

    // A missing value means "no change", which is why null had to be allowed.
    const kept = await patch(`/providers/me/vehicles/${added.json().id}`, { dailyRate: 50 });
    expect(kept.json().weeklyRate).toBe(250);

    const removed = await patch(`/providers/me/vehicles/${added.json().id}`, { weeklyRate: null });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().weeklyRate ?? null).toBeNull();
  });
});

describe('asking for the cars of one business', () => {
  it('answers with that business only, and an unknown id shows nothing', async () => {
    const mine = await post('/providers/me/vehicles', car('Mazda'));
    await approve(mine.json().id);

    const asked = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicles?providerId=${providerId}`,
      remoteAddress: uniqueIp(),
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().some((v: { id: string }) => v.id === mine.json().id)).toBe(true);

    // A nonsense id shows an empty page rather than an error, because a bad link
    // is a bad link, not a fault.
    const nonsense = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/vehicles?providerId=not-an-id',
      remoteAddress: uniqueIp(),
    });
    expect(nonsense.statusCode).toBe(200);
    expect(nonsense.json()).toEqual([]);
  });
});

describe('the record and figures a business sees about itself', () => {
  it('returns the contact details it is allowed to change', async () => {
    const profile = await get('/providers/me');
    expect(profile.statusCode).toBe(200);
    // PATCH has always accepted these three; the page could not show them.
    expect(profile.json()).toMatchObject({
      contactEmail: 'hello@fleetfigures.sx',
      ownerName: 'Marie Richardson',
      ownerPhone: '+1 721 555 0188',
    });
  });

  it('shows what customers paid, what was deducted, and what it receives', async () => {
    await ctx.db.insert(payouts).values([
      {
        reference: 'SXM-PO-5001',
        providerId,
        amountCents: 13_650,
        grossCents: 19_500,
        commissionCents: 5_850,
        bookingCount: 1,
        status: 'pending',
        periodStart: dateIn(-14),
        periodEnd: dateIn(-7),
      },
      {
        reference: 'SXM-PO-5002',
        providerId,
        amountCents: 7_000,
        grossCents: 10_000,
        commissionCents: 3_000,
        bookingCount: 1,
        status: 'paid',
        periodStart: dateIn(-30),
        periodEnd: dateIn(-21),
      },
    ]);

    const summary = await get('/providers/me/summary');
    expect(summary.statusCode).toBe(200);
    // Only the pending payout counts towards these three, and they subtract
    // exactly — no commission rate is applied anywhere to get them.
    expect(summary.json()).toMatchObject({
      pending: 136.5,
      pendingGross: 195,
      pendingCommission: 58.5,
      paidOut: 70,
    });
    expect(summary.json().pendingGross - summary.json().pendingCommission).toBeCloseTo(summary.json().pending, 2);
  });

  it('names the counts after what they actually count', async () => {
    const summary = await get('/providers/me/summary');
    // Conversations ever against bookings in 90 days: two different windows, said
    // out loud instead of hidden behind "enquiries" and "conversions", which the
    // dashboard was dividing into a 300% conversion rate.
    expect(summary.json()).toHaveProperty('totalConversations');
    expect(summary.json()).toHaveProperty('bookingsLast90Days');
  });
});

describe('a business writing first', () => {
  it('starts the conversation about one of its own bookings', async () => {
    const renterAccount = await createVerifiedAccount(ctx);
    const renter = await signInMobile(ctx, renterAccount.email, renterAccount.password);
    const listed = await post('/providers/me/vehicles', car('Fiat'));
    await approve(listed.json().id);

    const booking = await post(
      '/bookings',
      { vehicleId: listed.json().id, startDate: dateIn(10), endDate: dateIn(12) },
      renter,
    );
    expect(booking.statusCode).toBe(201);

    // Impossible before: a business with a booking tomorrow had to wait for the
    // renter to write first.
    const written = await post(`/providers/me/bookings/${booking.json().id}/messages`, {
      body: 'We are at the Simpson Bay office — ask for Marie.',
    });
    expect(written.statusCode).toBe(201);
    expect(written.json().messages.at(-1)).toMatchObject({ from: 'provider' });

    // The customer has it in their own conversations.
    const theirs = await get('/messages/threads', renter);
    expect(
      theirs.json().some((thread: { messages: { body: string }[] }) =>
        thread.messages.some((message) => message.body.includes('ask for Marie')),
      ),
    ).toBe(true);

    // Writing again continues the same conversation rather than starting a second.
    const second = await post(`/providers/me/bookings/${booking.json().id}/messages`, { body: 'Bring your licence.' });
    expect(second.json().id).toBe(written.json().id);
    expect(second.json().messages).toHaveLength(2);

    // And the booking links to it, which it never did before.
    const fleetBooking = await get(`/providers/me/bookings/${booking.json().id}`);
    expect(fleetBooking.json().threadId).toBe(written.json().id);
  });

  it('cannot write about a booking that is not theirs', async () => {
    const rivalAccount = await createVerifiedAccount(ctx);
    const rival = await signInMobile(ctx, rivalAccount.email, rivalAccount.password);
    const registered = await post(
      '/providers/apply',
      {
        businessName: 'Rival Rentals',
        legalName: 'Rival Rentals N.V.',
        contactEmail: 'hello@rival.sx',
        ownerName: 'Someone Else',
        ownerPhone: '+1 721 555 0199',
        town: 'Cole Bay',
        side: 'dutch',
        operatingSide: 'dutch',
        description: 'Rival.',
        deliversVehicles: false,
      },
      rival,
    );
    expect(registered.statusCode).toBe(201);

    const renterAccount = await createVerifiedAccount(ctx);
    const renter = await signInMobile(ctx, renterAccount.email, renterAccount.password);
    const listed = await post('/providers/me/vehicles', car('Peugeot'));
    await approve(listed.json().id);
    const booking = await post(
      '/bookings',
      { vehicleId: listed.json().id, startDate: dateIn(20), endDate: dateIn(22) },
      renter,
    );

    // Told it does not exist, not that it is not theirs — the same rule as
    // everywhere else, so nobody learns which references exist.
    const refused = await post(
      `/providers/me/bookings/${booking.json().id}/messages`,
      { body: 'Hello there.' },
      rival,
    );
    expect(refused.statusCode).toBe(404);
  });
});
