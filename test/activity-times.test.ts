// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the dates the admin panel's Activity screen needs:
// when a car was added and when it first went on sale, and when a booking was
// cancelled, by whom, and why.
//
// Without them the screen could not list cars newest first, and put every
// cancellation under the day the booking was MADE, marked "time unknown".

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vehicles } from '../src/db/schema/index.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedProvider,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

const car = {
  make: 'Kia',
  model: 'Picanto',
  year: 2024,
  vehicleClass: 'economy',
  transmission: 'automatic',
  fuel: 'petrol',
  seats: 4,
  doors: 4,
  dailyRate: 45,
  depositAmount: 300,
  pickupTown: 'Simpson Bay',
  side: 'dutch',
  latitude: 18.03,
  longitude: -63.09,
};

async function aBusiness(ctx: TestContext) {
  const account = await createVerifiedAccount(ctx);
  const token = await signInMobile(ctx, account.email, account.password);
  await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/providers/apply',
    headers: { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
    remoteAddress: uniqueIp(),
    payload: {
      businessName: 'Activity Cars',
      legalName: 'Activity Cars N.V.',
      contactEmail: `hello${Math.floor(Math.random() * 1e6)}@activitycars.sx`,
      ownerName: 'Marie Richardson',
      ownerPhone: '+1 721 555 0188',
      town: 'Simpson Bay',
      side: 'dutch',
      operatingSide: 'dutch',
    },
  });
  return token;
}
const addCar = (ctx: TestContext, token: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/providers/me/vehicles',
    headers: { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
    remoteAddress: uniqueIp(),
    payload: car,
  });

describe('a car: when it was added, and when it went on sale', () => {
  let ctx: TestContext;
  let staffCookie: string;
  const asStaff = (method: 'GET' | 'POST', url: string, payload?: object) =>
    ctx.app.inject({
      method,
      url: `/api/v1/admin${url}`,
      headers: { cookie: staffCookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
      ...(payload ? { payload } : {}),
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    staffCookie = (await createSignedInStaff(ctx)).cookie;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('carries when it was added, and goes on sale at its first approval, which a later one never moves', async () => {
    const added = (await addCar(ctx, await aBusiness(ctx))).json();
    const listed = (await asStaff('GET', '/vehicles')).json();
    const waiting = (Array.isArray(listed) ? listed : listed.items).find((vehicle: { id: string }) => vehicle.id === added.id);
    expect(new Date(waiting.createdAt).toISOString()).toBe(waiting.createdAt);
    expect(waiting.listedAt).toBeNull();

    const approved = (await asStaff('POST', `/vehicles/${added.id}/listing`, { approve: true, reason: 'Papers checked.' })).json();
    expect(approved.listedAt).not.toBeNull();
    expect(new Date(approved.listedAt).getTime()).toBeGreaterThanOrEqual(new Date(approved.createdAt).getTime());

    await asStaff('POST', `/vehicles/${added.id}/listing`, { approve: false, reason: 'Insurance lapsed.' });
    const again = (await asStaff('POST', `/vehicles/${added.id}/listing`, { approve: true, reason: 'New insurance seen.' })).json();
    expect(again.listedAt).toBe(approved.listedAt);
  });
});

describe('a car added while approval is switched off', () => {
  it('is on sale from the moment it is added', async () => {
    const ctx = await createTestContext({ env: { VEHICLE_APPROVAL: 'off' } });
    try {
      const added = (await addCar(ctx, await aBusiness(ctx))).json();
      const [row] = await ctx.db.select().from(vehicles).where(eq(vehicles.id, added.id));
      expect(row!.listedAt).not.toBeNull();
      expect(Math.abs(row!.listedAt!.getTime() - row!.createdAt.getTime())).toBeLessThan(5_000);
    } finally {
      await ctx.close();
    }
  });
});

describe('a booking: when it was cancelled, by whom, and why', () => {
  let ctx: TestContext;
  let token: string;
  let staffCookie: string;
  let vehicleId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    const provider = await seedProvider(ctx.db);
    vehicleId = (await seedVehicle(ctx.db, provider.id)).id;
    const account = await createVerifiedAccount(ctx);
    token = await signInMobile(ctx, account.email, account.password);
    staffCookie = (await createSignedInStaff(ctx)).cookie;
  });
  afterAll(async () => {
    await ctx.close();
  });

  const asCustomer = (url: string, payload: object) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
      payload,
      remoteAddress: uniqueIp(),
    });
  const staffBookings = async () =>
    (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/bookings',
        headers: { cookie: staffCookie, origin: WEB_ORIGIN },
        remoteAddress: uniqueIp(),
      })
    ).json() as { id: string; cancelledAt: string | null; cancelledBy: string | null; cancellationReason: string | null }[];

  it('says when the renter cancelled, that it was the renter, and the reason they picked', async () => {
    const kept = (await asCustomer('/bookings', { vehicleId, startDate: dateIn(20), endDate: dateIn(22) })).json();
    const cancelled = (await asCustomer('/bookings', { vehicleId, startDate: dateIn(30), endDate: dateIn(32) })).json();
    const before = Date.now();
    await asCustomer(`/bookings/${cancelled.id}/cancel`, { reason: 'flight_changed' });

    const list = await staffBookings();
    const row = list.find((booking) => booking.id === cancelled.id)!;
    expect(row).toMatchObject({ cancelledBy: 'customer', cancellationReason: 'flight_changed' });
    expect(new Date(row.cancelledAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(list.find((booking) => booking.id === kept.id)).toMatchObject({
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
    });
  });
});
