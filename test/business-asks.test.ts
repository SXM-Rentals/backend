// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the smaller things the phone app asked for on a
// business's own screens: where its application stands, a registration number
// on each car, whether the accident question was answered, how quickly it
// replies as a code, gross and commission beside each car's figures, and moving
// the business to the other side of the island.
//
// The one that matters most is privacy: a car's registration is for the
// business and staff, and must never reach a customer.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, customers, providerMembers, vehicles } from '../src/db/schema/index.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  dateIn,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let ownerToken: string;
let providerId: string;
let customerToken: string;
let staffCookie: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: token ? auth(token) : {},
    remoteAddress: uniqueIp(),
    ...(payload ? { payload } : {}),
  });
const asStaff = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: staffCookie, origin: WEB_ORIGIN },
    remoteAddress: uniqueIp(),
    ...(payload ? { payload } : {}),
  });

const car = (overrides: object = {}) => ({
  make: 'Kia',
  model: 'Picanto',
  year: 2023,
  vehicleClass: 'economy',
  transmission: 'automatic',
  fuel: 'petrol',
  seats: 4,
  doors: 4,
  dailyRate: 40,
  depositAmount: 300,
  pickupTown: 'Simpson Bay',
  side: 'dutch',
  latitude: 18.035,
  longitude: -63.09,
  ...overrides,
});
const addCar = (overrides: object = {}) => send('POST', '/providers/me/vehicles', ownerToken, car(overrides));
const goLive = (id: string) => ctx.db.update(vehicles).set({ listingStatus: 'live' }).where(eq(vehicles.id, id));

beforeAll(async () => {
  ctx = await createTestContext();
  const owner = await createVerifiedAccount(ctx);
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  providerId = (
    await send('POST', '/providers/apply', ownerToken, {
      businessName: 'Plate Rentals',
      legalName: 'Plate Rentals N.V.',
      contactEmail: 'hello@platerentals.sx',
      ownerName: 'Marie Richardson',
      ownerPhone: '+1 721 555 0188',
      town: 'Simpson Bay',
      side: 'dutch',
      operatingSide: 'dutch',
    })
  ).json().providerId;
  const customer = await createVerifiedAccount(ctx);
  customerToken = await signInMobile(ctx, customer.email, customer.password);
  staffCookie = (await createSignedInStaff(ctx)).cookie;
});
afterAll(async () => {
  await ctx.close();
});

describe('where the application stands', () => {
  it('says waiting, turned down with the reason, or approved', async () => {
    expect((await send('GET', '/providers/me', ownerToken)).json()).toMatchObject({
      verificationStatus: 'pending',
      verificationReason: null,
    });

    await asStaff('POST', `/admin/providers/${providerId}/verification`, {
      approve: false,
      reason: 'The trade licence you sent has expired.',
    });
    expect((await send('GET', '/providers/me', ownerToken)).json()).toMatchObject({
      verificationStatus: 'rejected',
      verificationReason: 'The trade licence you sent has expired.',
    });

    await asStaff('POST', `/admin/providers/${providerId}/verification`, {
      approve: true,
      reason: 'New licence checked against the register.',
    });
    expect((await send('GET', '/providers/me', ownerToken)).json()).toMatchObject({
      verificationStatus: 'approved',
      verificationReason: null,
    });
  });
});

describe('a registration number on each car', () => {
  it('is stored in capitals and shown to the business and staff, never to a customer', async () => {
    const added = await addCar({ registration: ' p  1234 ' });
    expect(added.statusCode).toBe(201);
    expect(added.json().registration).toBe('P 1234');
    await goLive(added.json().id);

    const fleet = (await send('GET', '/providers/me/vehicles', ownerToken)).json();
    expect(fleet.find((vehicle: { id: string }) => vehicle.id === added.json().id).registration).toBe('P 1234');
    const staffView = (await asStaff('GET', '/admin/vehicles')).json();
    const listed = (Array.isArray(staffView) ? staffView : staffView.items ?? staffView.vehicles).find(
      (vehicle: { id: string }) => vehicle.id === added.json().id,
    );
    expect(listed.registration).toBe('P 1234');

    const publicCar = await send('GET', `/vehicles/${added.json().id}`);
    expect(publicCar.json()).not.toHaveProperty('registration');
    expect(publicCar.body).not.toContain('P 1234');
    const search = await send('GET', '/vehicles?search=Picanto');
    expect(search.body).not.toContain('P 1234');
  });

  it('refuses a second car with the same plate in one fleet, in words', async () => {
    await addCar({ registration: 'M-777' });
    const again = await addCar({ registration: 'm-777' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      code: 'registration_taken',
      message: 'Already in your fleet (registration M-777).',
    });

    const other = (await addCar({ registration: 'M-778' })).json();
    const clash = await send('PATCH', `/providers/me/vehicles/${other.id}`, ownerToken, { registration: 'M-777' });
    expect(clash.json().error.code).toBe('registration_taken');
    const cleared = await send('PATCH', `/providers/me/vehicles/${other.id}`, ownerToken, { registration: null });
    expect(cleared.json().registration).toBeNull();
  });
});

describe('whether the accident question was answered', () => {
  it('is false until answered, and true for "none" as well as for a history', async () => {
    const unanswered = (await addCar()).json();
    expect(unanswered.accidentHistoryDeclared).toBe(false);

    const none = await send('PATCH', `/providers/me/vehicles/${unanswered.id}`, ownerToken, {
      accidentHistoryDeclared: true,
      accidentHistory: [],
    });
    expect(none.json()).toMatchObject({ accidentHistoryDeclared: true, accidentHistory: [] });
    await goLive(unanswered.id);
    expect((await send('GET', `/vehicles/${unanswered.id}`)).json().accidentHistoryDeclared).toBe(true);

    const withHistory = (
      await addCar({ accidentHistory: [{ date: '2025-03-02', description: 'Rear bumper, repaired', repaired: true }] })
    ).json();
    expect(withHistory.accidentHistoryDeclared).toBe(true);
  });
});

describe('how quickly a business replies', () => {
  it('is a code, never free English', async () => {
    const words = await asStaff('PATCH', `/admin/providers/${providerId}`, {
      field: 'respondsIn',
      value: 'within an hour',
      reason: 'Owner asked us to set it.',
    });
    expect(words.statusCode).toBe(400);

    const code = await asStaff('PATCH', `/admin/providers/${providerId}`, {
      field: 'respondsIn',
      value: 'within_hours',
      reason: 'Owner asked us to set it.',
    });
    expect(code.statusCode).toBe(200);
    expect((await send('GET', `/providers/${providerId}`)).json().respondsIn).toBe('within_hours');
  });
});

describe('gross and commission beside each car', () => {
  it('come from the bookings, and gross less commission is the business share', async () => {
    const vehicle = (await addCar()).json();
    await goLive(vehicle.id);
    const booked = (
      await send('POST', '/bookings', customerToken, { vehicleId: vehicle.id, startDate: dateIn(5), endDate: dateIn(8) })
    ).json();
    const done = (
      await send('POST', '/bookings', customerToken, { vehicleId: vehicle.id, startDate: dateIn(20), endDate: dateIn(22) })
    ).json();
    // One rental over and paid for; the other still to come.
    await ctx.db
      .update(bookings)
      .set({ status: 'completed', paymentStatus: 'paid', startDate: dateIn(-6), endDate: dateIn(-4) })
      .where(eq(bookings.id, done.id));

    const performance = (await send('GET', '/providers/me/performance', ownerToken)).json();
    const figures = performance.find((row: { vehicleId: string }) => row.vehicleId === vehicle.id);
    const cents = (amount: number) => Math.round(amount * 100);
    expect(cents(figures.grossEarned) - cents(figures.commissionEarned)).toBe(cents(figures.revenueEarned));
    expect(cents(figures.grossBooked) - cents(figures.commissionBooked)).toBe(cents(figures.revenueBooked));
    expect(figures.grossBooked).toBe(booked.totalDueToday);
    expect(figures.grossEarned).toBeGreaterThan(0);
  });
});

describe('moving to the other side of the island', () => {
  it('needs a town on the new side, and takes its proper name', async () => {
    const noTown = await send('PATCH', '/providers/me', ownerToken, { side: 'french' });
    expect(noTown.json().error.code).toBe('town_required');

    const wrongSide = await send('PATCH', '/providers/me', ownerToken, { side: 'french', town: 'Philipsburg' });
    expect(wrongSide.json().error.code).toBe('town_not_on_side');
    expect(wrongSide.json().error.message).toContain('Marigot');

    const moved = await send('PATCH', '/providers/me', ownerToken, { side: 'french', town: 'quartier dorleans' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ side: 'french', town: 'Quartier d’Orléans' });
    expect((await send('GET', `/providers/${providerId}`)).json()).toMatchObject({ side: 'french' });
  });

  it('is the owner’s to do, not a colleague’s', async () => {
    const colleague = await createVerifiedAccount(ctx);
    const token = await signInMobile(ctx, colleague.email, colleague.password);
    const [person] = await ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.email, colleague.email));
    await ctx.db.insert(providerMembers).values({ providerId, customerId: person!.id, role: 'staff' });

    const res = await send('PATCH', '/providers/me', token, { side: 'dutch', town: 'Simpson Bay' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('owner_only');
    // A colleague can still change the everyday details.
    expect((await send('PATCH', '/providers/me', token, { description: 'Family run since 1998.' })).statusCode).toBe(200);
  });
});
