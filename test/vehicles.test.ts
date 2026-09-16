// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests browsing and searching for a car, the way the
// Search screen does it — every filter and sort order the apps offer, the
// dates a car is already taken, and that a car waiting for staff approval
// never appears. Also checks reviews show a first name and an initial and
// nothing more.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, reviews, vehicleAccidentRecords, vehiclePhotos } from '../src/db/schema/index.js';
import {
  createTestContext,
  dateIn,
  seedCustomer,
  seedProvider,
  seedVehicle,
  uniqueIp,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let providerId: string;
let jimnyId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = await seedProvider(ctx.db, { businessName: 'Island Wheels', rating: 4.9, reviewCount: 40 });
  providerId = provider.id;

  // A small fleet to search through.
  const jimny = await seedVehicle(ctx.db, providerId, {
    make: 'Suzuki',
    model: 'Jimny',
    vehicleClass: 'fourByFour',
    dailyRateCents: 6500,
    seats: 4,
    transmission: 'manual',
    fuel: 'petrol',
    side: 'dutch',
    pickupTown: 'Philipsburg',
    rating: 4.8,
    deliveryAvailable: true,
    deliveryFeeCents: 2500,
    weeklyRateCents: 39000,
  });
  jimnyId = jimny.id;

  await seedVehicle(ctx.db, providerId, {
    make: 'Kia',
    model: 'Picanto',
    vehicleClass: 'economy',
    dailyRateCents: 3800,
    seats: 4,
    transmission: 'automatic',
    fuel: 'petrol',
    side: 'french',
    pickupTown: 'Marigot',
    rating: 4.2,
  });
  await seedVehicle(ctx.db, providerId, {
    make: 'Toyota',
    model: 'Hiace',
    vehicleClass: 'van',
    dailyRateCents: 9500,
    seats: 9,
    transmission: 'automatic',
    fuel: 'diesel',
    side: 'dutch',
    pickupTown: 'Cole Bay',
    rating: 4.5,
  });
  // Waiting for staff approval — must never show up.
  await seedVehicle(ctx.db, providerId, { make: 'Hidden', model: 'Draft', listingStatus: 'pending_review' });

  await ctx.db.insert(vehiclePhotos).values([
    { vehicleId: jimnyId, storageKey: 'jimny-front.jpg', position: 1 },
    { vehicleId: jimnyId, storageKey: 'jimny-side.jpg', position: 0 },
  ]);
  await ctx.db.insert(vehicleAccidentRecords).values({
    vehicleId: jimnyId,
    occurredOn: '2025-04-02',
    description: 'Scraped rear bumper, repaired',
    repaired: true,
  });
});
afterAll(async () => {
  await ctx.close();
});

const search = (query = '') =>
  ctx.app.inject({ method: 'GET', url: `/api/v1/vehicles${query}`, remoteAddress: uniqueIp() });

describe('searching for a car', () => {
  it('returns only approved listings, best rated first, in the apps\' Vehicle shape', async () => {
    const res = await search();
    expect(res.statusCode).toBe(200);
    const list = res.json();

    expect(list.map((v: { make: string }) => v.make)).toEqual(['Suzuki', 'Toyota', 'Kia']);
    expect(list.some((v: { make: string }) => v.make === 'Hidden')).toBe(false);

    const jimny = list[0];
    expect(jimny).toMatchObject({
      id: jimnyId,
      make: 'Suzuki',
      model: 'Jimny',
      providerId,
      // Prices come back in dollars, not cents.
      dailyRate: 65,
      weeklyRate: 390,
      depositAmount: 500,
      vehicleClass: 'fourByFour',
      seats: 4,
      unavailableDates: [],
    });
    // Delivery is free, so no fee is ever reported to a screen.
    expect(jimny.deliveryFee).toBeUndefined();
    expect(jimny.deliveryAvailable).toBe(true);
    // Photos come in the order the business set.
    expect(jimny.photos).toEqual(['jimny-side.jpg', 'jimny-front.jpg']);
    expect(jimny.accidentHistory).toEqual([
      { date: '2025-04-02', description: 'Scraped rear bumper, repaired', repaired: true },
    ]);
  });

  it('narrows the list down by every filter the Search screen offers', async () => {
    const makes = async (query: string) =>
      (await search(query)).json().map((v: { make: string }) => v.make);

    expect(await makes('?search=jimny')).toEqual(['Suzuki']);
    expect(await makes('?search=marigot')).toEqual(['Kia']); // matches the town too
    expect(await makes('?classes=economy,van')).toEqual(['Toyota', 'Kia']);
    expect(await makes('?minPrice=60')).toEqual(['Suzuki', 'Toyota']);
    expect(await makes('?maxPrice=40')).toEqual(['Kia']);
    expect(await makes('?seats=9')).toEqual(['Toyota']);
    expect(await makes('?transmission=manual')).toEqual(['Suzuki']);
    expect(await makes('?fuel=diesel')).toEqual(['Toyota']);
    expect(await makes('?side=french')).toEqual(['Kia']);
    expect(await makes('?deliveryOnly=true')).toEqual(['Suzuki']);
    expect(await makes('?sort=price_low')).toEqual(['Kia', 'Suzuki', 'Toyota']);
    expect(await makes('?sort=price_high')).toEqual(['Toyota', 'Suzuki', 'Kia']);
  });

  it('caps how much can be pulled down in one request', async () => {
    const res = await search('?limit=500');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_input');

    const paged = await search('?limit=2&offset=2');
    expect(paged.json()).toHaveLength(1);
  });
});

describe('a car that is already booked', () => {
  it('lists the taken days and drops out of a search for those dates', async () => {
    const start = dateIn(10);
    const end = dateIn(13);
    await ctx.db.insert(bookings).values({
      reference: 'SXM-9001',
      customerId: (await seedCustomer(ctx.db)).id,
      vehicleId: jimnyId,
      providerId,
      startDate: start,
      endDate: end,
      pickupTime: '10:00',
      returnTime: '10:00',
      collection: 'pickup',
      location: 'Philipsburg',
      grossCents: 19500,
      commissionCents: 5850,
      payoutCents: 13650,
      totalDueTodayCents: 19500,
    });

    const one = await ctx.app.inject({ method: 'GET', url: `/api/v1/vehicles/${jimnyId}`, remoteAddress: uniqueIp() });
    // Three nights taken; the car is handed back on the morning of the 4th day.
    expect(one.json().unavailableDates).toEqual([dateIn(10), dateIn(11), dateIn(12)]);

    const clashing = await search(`?startDate=${start}&endDate=${end}`);
    expect(clashing.json().map((v: { make: string }) => v.make)).not.toContain('Suzuki');

    // The day it comes back is free for the next person to collect.
    const after = await search(`?startDate=${end}&endDate=${dateIn(15)}`);
    expect(after.json().map((v: { make: string }) => v.make)).toContain('Suzuki');
  });
});

describe('one car, and its reviews', () => {
  it('answers "not found" for a draft listing or a made-up address', async () => {
    const draft = (await search('?search=Hidden')).json();
    expect(draft).toEqual([]);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/vehicles/00000000-0000-4000-8000-000000000000',
      remoteAddress: uniqueIp(),
    });
    const nonsense = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/vehicles/not-an-id',
      remoteAddress: uniqueIp(),
    });
    expect(missing.statusCode).toBe(404);
    expect(nonsense.statusCode).toBe(404);
    expect(nonsense.json().error.message).toBe(missing.json().error.message);
  });

  it('shows a reviewer as a first name and an initial, with no contact details', async () => {
    const author = await seedCustomer(ctx.db, {
      firstName: 'Aria',
      lastName: 'Duncan',
      email: 'aria.duncan@example.com',
      phone: '+1 721 555 0199',
    });
    const { booking } = await (await import('./helpers.js')).seedBooking(ctx.db);
    await ctx.db.insert(reviews).values({
      bookingId: booking.id,
      vehicleId: jimnyId,
      customerId: author.id,
      rating: 5,
      body: 'Perfect little car for the island roads.',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicles/${jimnyId}/reviews`,
      remoteAddress: uniqueIp(),
    });
    expect(res.statusCode).toBe(200);
    const [review] = res.json();
    expect(review).toMatchObject({ vehicleId: jimnyId, rating: 5, authorName: 'Aria D.' });
    expect(res.body).not.toContain('aria.duncan@example.com');
    expect(res.body).not.toContain('0199');
    expect(res.body).not.toContain('Duncan');
  });
});

describe('rental businesses', () => {
  it('shows only the public half of a business', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/providers/${providerId}`, remoteAddress: uniqueIp() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: providerId, businessName: 'Island Wheels', side: 'dutch' });
    // Nothing private: no legal name, registration, owner's mobile or earnings.
    expect(Object.keys(res.json()).sort()).toEqual(
      [
        'id',
        'businessName',
        'side',
        'town',
        'rating',
        'reviewCount',
        'isVerified',
        'respondsIn',
        'phone',
        'description',
        'deliversVehicles',
        'airportPickup',
        'memberSince',
      ].sort(),
    );

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/providers', remoteAddress: uniqueIp() });
    expect(list.json().length).toBeGreaterThan(0);
  });
});
