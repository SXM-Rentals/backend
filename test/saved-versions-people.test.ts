// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests saved versions of customer accounts, rental
// businesses and cars — what makes "Clear everything" something that can be
// undone.
//
// The tests that matter most: a whole clear of everything goes back in one
// restore, in the order the database needs, each thing with what belongs to it
// (a business with its profile and the people who run it, a car with its
// photos, a customer with their points); a customer's password and sign-ins are
// NEVER in a version; and a record whose parent is gone, or whose email is now
// somebody else's, says why while the rest still go back.

import { eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookings,
  credentials,
  customers,
  dataVersionRecords,
  deposits,
  ledgerEntries,
  providerBusinessProfiles,
  providerMembers,
  providers,
  rewardLedger,
  vehicleAccidentRecords,
  vehiclePhotos,
  vehicles,
} from '../src/db/schema/index.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  seedBooking,
  seedCustomer,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

type Staff = Awaited<ReturnType<typeof createSignedInStaff>>;

let ctx: TestContext;
let godfather: Staff;
let account: Awaited<ReturnType<typeof createVerifiedAccount>>;

const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { cookie: godfather.cookie, origin: WEB_ORIGIN },
    ...(payload ? { payload } : {}),
    remoteAddress: uniqueIp(),
  });
const withCode = async (extra: object = {}) => ({ code: await generateOtp({ secret: godfather.secret }), ...extra });
const clearEverything = async () => call('POST', '/test-data/clear', await withCode({ what: 'everything', reason: 'Resetting.' }));
const restore = async (versionId: string, extra: object = {}) => call('POST', `/backups/${versionId}/restore`, await withCode(extra));
const count = async (table: PgTable) => (await ctx.db.select().from(table)).length;

let versionId = '';
let runsIt: Awaited<ReturnType<typeof seedCustomer>>;
let firstBusiness: Awaited<ReturnType<typeof seedBooking>>;

beforeAll(async () => {
  ctx = await createTestContext({ env: { ALLOW_TEST_RESET: 'on' } });
  godfather = await createSignedInStaff(ctx, 'Gio Godfather', 'godfather');

  // Two bookings, each with its own customer, business and car.
  firstBusiness = await seedBooking(ctx.db);
  const second = await seedBooking(ctx.db);
  await ctx.db.insert(deposits).values({ bookingId: firstBusiness.booking.id, amountCents: 50000 });
  await ctx.db.insert(ledgerEntries).values({
    bookingId: second.booking.id,
    kind: 'charge',
    amountCents: 19500,
    status: 'succeeded',
    stripeRef: 'pi_people_1',
    occurredAt: new Date(),
  });

  // What belongs to them: a business's private profile and the person who runs
  // it, a car's photo and accident history, a customer's points.
  runsIt = await seedCustomer(ctx.db);
  await ctx.db.insert(providerBusinessProfiles).values({
    providerId: firstBusiness.provider.id,
    legalName: 'Island Wheels N.V.',
    contactEmail: 'office@islandwheels.example',
    operatingSide: 'dutch',
    ownerName: 'Olga Owner',
    ownerPhone: '+1 721 555 0100',
  });
  await ctx.db.insert(providerMembers).values({ providerId: firstBusiness.provider.id, customerId: runsIt.id, role: 'owner' });
  await ctx.db.insert(vehiclePhotos).values({ vehicleId: firstBusiness.vehicle.id, storageKey: 'cars/jimny-1.jpg', position: 0 });
  await ctx.db
    .insert(vehicleAccidentRecords)
    .values({ vehicleId: firstBusiness.vehicle.id, occurredOn: '2025-05-01', description: 'A scrape.', repaired: true });
  await ctx.db.insert(rewardLedger).values({ customerId: firstBusiness.customer.id, bookingId: firstBusiness.booking.id, label: 'Rental', points: 195 });

  // A real sign-up, with a password.
  account = await createVerifiedAccount(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('what a version holds of customers, businesses and cars', () => {
  it('copies all three, each with what belongs to it', async () => {
    const res = await call('POST', '/backups', { note: 'Before clearing everything' });
    expect(res.statusCode).toBe(201);
    versionId = res.json().id;
    expect(res.json().counts).toMatchObject({ customers: 4, providers: 2, vehicles: 2, bookings: 2 });

    const records = await ctx.db.select().from(dataVersionRecords).where(eq(dataVersionRecords.versionId, versionId));
    const business = records.find((record) => record.recordId === firstBusiness.provider.id)!;
    // Only what exists is saved with it: this business has a profile and a person, no payout set-up or codes.
    expect(Object.keys(business.data.children as object).sort()).toEqual(['members', 'profile']);
    expect((business.data.children as Record<string, unknown[]>).profile).toHaveLength(1);
    expect((business.data.children as Record<string, unknown[]>).members).toHaveLength(1);
    const car = records.find((record) => record.recordId === firstBusiness.vehicle.id)!;
    expect((car.data.children as Record<string, unknown[]>).photos).toHaveLength(1);
    expect((car.data.children as Record<string, unknown[]>).accidents).toHaveLength(1);
    const person = records.find((record) => record.recordId === firstBusiness.customer.id)!;
    expect((person.data.children as Record<string, unknown[]>).points).toHaveLength(1);
  });

  it('never copies a password or a sign-in: only the account itself', async () => {
    const records = await ctx.db.select().from(dataVersionRecords).where(eq(dataVersionRecords.versionId, versionId));
    const signedUp = records.find((record) => (record.data.row as { email: string }).email === account.email)!;
    // The only thing that can belong to a customer in a version is their points.
    expect(Object.keys(signedUp.data.children as object).every((key) => key === 'points')).toBe(true);
    const everything = JSON.stringify(records.map((record) => record.data));
    expect(everything).not.toContain('hash');
    expect(everything).not.toContain(account.password);
    // Nothing of the sign-in tables is a kind at all.
    expect(records.some((record) => record.kind === 'credentials' || record.kind === 'sessions')).toBe(false);
    expect(await count(credentials)).toBeGreaterThan(0);
  });
});

describe('a record whose parent is gone', () => {
  it('says why, and does not take more than asked', async () => {
    expect((await clearEverything()).statusCode).toBe(200);
    for (const table of [customers, providers, vehicles, bookings, credentials]) expect(await count(table)).toBe(0);

    const cars = await restore(versionId, { kind: 'vehicles' });
    expect(cars.json()).toMatchObject({ restored: 0, failedCount: 2 });
    expect(cars.json().failed[0]).toMatchObject({ kind: 'vehicles', why: 'its business has since been deleted — put the business back first' });
    expect(await count(vehicles)).toBe(0);
  });

  it('brings a business back without the people who ran it when they no longer have accounts, and says so', async () => {
    const res = await restore(versionId, { kind: 'providers' });
    expect(res.json()).toMatchObject({ restored: 2, failedCount: 0 });
    expect(res.json().notes).toEqual([expect.stringContaining('no longer has an account')]);
    expect(res.json().detail).toContain('no longer has an account');
    expect(await count(providers)).toBe(2);
    expect(await count(providerBusinessProfiles)).toBe(1);
    expect(await count(providerMembers)).toBe(0);
  });

  it('then takes the cars, now that their business is back, with their photos and history', async () => {
    const res = await restore(versionId, { kind: 'vehicles' });
    expect(res.json()).toMatchObject({ restored: 2, failedCount: 0 });
    expect(await count(vehiclePhotos)).toBe(1);
    expect(await count(vehicleAccidentRecords)).toBe(1);
  });
});

describe('clearing everything and putting it all back', () => {
  it('goes back in one restore, in order, each with what belongs to it', async () => {
    expect((await clearEverything()).statusCode).toBe(200);
    for (const table of [customers, providers, vehicles, bookings, vehiclePhotos, providerBusinessProfiles, providerMembers, rewardLedger]) {
      expect(await count(table)).toBe(0);
    }

    const res = await restore(versionId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ failedCount: 0, failed: [], notes: [] });
    expect(res.json().byKind).toMatchObject({
      customers: { restored: 4 },
      providers: { restored: 2 },
      vehicles: { restored: 2 },
      bookings: { restored: 2 },
    });

    expect(await count(customers)).toBe(4);
    expect(await count(providers)).toBe(2);
    expect(await count(vehicles)).toBe(2);
    expect(await count(bookings)).toBe(2);
    // Each with what belongs to it: the business's profile and the person who
    // runs it, the car's photo and history, the customer's points.
    expect(await count(providerBusinessProfiles)).toBe(1);
    expect((await ctx.db.select().from(providerMembers))[0]).toMatchObject({ customerId: runsIt.id, providerId: firstBusiness.provider.id, role: 'owner' });
    expect(await count(vehiclePhotos)).toBe(1);
    expect(await count(vehicleAccidentRecords)).toBe(1);
    const [points] = await ctx.db.select().from(rewardLedger);
    expect(points).toMatchObject({ customerId: firstBusiness.customer.id, points: 195 });
    // The booking is linked to its car, customer and business again.
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.id, firstBusiness.booking.id));
    expect(booking).toMatchObject({
      customerId: firstBusiness.customer.id,
      vehicleId: firstBusiness.vehicle.id,
      providerId: firstBusiness.provider.id,
    });
  });

  it('puts a customer back without their password, who signs back in by resetting it', async () => {
    const [back] = await ctx.db.select().from(customers).where(eq(customers.email, account.email));
    expect(back).toBeDefined();
    expect(await count(credentials)).toBe(0);
  });
});

describe('a customer whose email address has been taken since', () => {
  it('says why, while everyone else goes back', async () => {
    expect((await clearEverything()).statusCode).toBe(200);
    // Somebody new signs up with the same address.
    await seedCustomer(ctx.db, { email: account.email });

    const res = await restore(versionId, { kind: 'customers' });
    expect(res.json()).toMatchObject({ restored: 3, failedCount: 1 });
    expect(res.json().failed[0]).toMatchObject({ kind: 'customers', why: 'another account uses that email address now' });
    expect(res.json().failed[0].summary).toContain(account.email);
  });
});
