// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests a business taking one of its cars off sale for
// some days — servicing, a private hire, keeping it back.
//
// Before this, the only days SXM Rentals treated as taken were booked ones, so a
// car in the garage could still be booked. The tests that matter most prove a
// blocked day is unavailable EVERYWHERE a customer could meet it — the car's
// page, search, the quote and the booking itself — and that the customer is
// never told why.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createVerifiedAccount,
  dateIn,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let ownerToken: string;
let rivalToken: string;
let customerToken: string;
let vehicleId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: token ? auth(token) : {},
    remoteAddress: uniqueIp(),
    ...(payload ? { payload } : {}),
  });

const application = (businessName: string) => ({
  businessName,
  legalName: `${businessName} N.V.`,
  contactEmail: `hello@${businessName.toLowerCase().replace(/\W/g, '')}.sx`,
  ownerName: 'Marie Richardson',
  ownerPhone: '+1 721 555 0188',
  town: 'Simpson Bay',
  side: 'dutch' as const,
  operatingSide: 'dutch' as const,
});

async function block(startsIn: number, endsIn: number, reason = 'servicing') {
  return send('POST', `/providers/me/vehicles/${vehicleId}/blocks`, ownerToken, {
    startDate: dateIn(startsIn),
    endDate: dateIn(endsIn),
    reason,
  });
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { FEATURES: 'blockedDays' } });
  const owner = await createVerifiedAccount(ctx);
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  const providerId = (await send('POST', '/providers/apply', ownerToken, application('Garage Cars'))).json().providerId;
  vehicleId = (await seedVehicle(ctx.db, providerId, { make: 'Blockable' })).id;

  const rival = await createVerifiedAccount(ctx);
  rivalToken = await signInMobile(ctx, rival.email, rival.password);
  await send('POST', '/providers/apply', rivalToken, application('Rival Cars'));

  const customer = await createVerifiedAccount(ctx);
  customerToken = await signInMobile(ctx, customer.email, customer.password);
});
afterAll(async () => {
  await ctx.close();
});

describe('blocking days', () => {
  it('counts both dates, and shows them as taken on the car, to customers and the business', async () => {
    const created = await block(10, 12);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ startDate: dateIn(10), endDate: dateIn(12), reason: 'servicing' });

    const listed = (await send('GET', `/providers/me/vehicles/${vehicleId}/blocks`, ownerToken)).json();
    expect(listed).toHaveLength(1);

    const publicCar = await send('GET', `/vehicles/${vehicleId}`);
    expect(publicCar.json().unavailableDates).toEqual(expect.arrayContaining([dateIn(10), dateIn(11), dateIn(12)]));
    expect(publicCar.json().unavailableDates).not.toContain(dateIn(13));
    // Never why.
    expect(publicCar.body).not.toContain('servicing');

    const theirs = (await send('GET', `/providers/me/vehicles/${vehicleId}`, ownerToken)).json();
    expect(theirs.unavailableDates).toEqual(expect.arrayContaining([dateIn(10), dateIn(11), dateIn(12)]));
    expect(theirs).toMatchObject({ id: vehicleId, listingStatus: 'live' });
  });

  it('makes the car unavailable in quotes, search and booking', async () => {
    // Over the blocked days (10 to 12).
    const quote = await send('POST', '/bookings/quote', customerToken, {
      vehicleId,
      startDate: dateIn(9),
      endDate: dateIn(11),
    });
    expect(quote.json().available).toBe(false);

    const booking = await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(11), endDate: dateIn(14) });
    expect(booking.statusCode).toBe(409);
    expect(booking.json().error.code).toBe('vehicle_unavailable');
    expect(booking.body).not.toContain('booked');

    const search = (await send('GET', `/vehicles?search=Blockable&startDate=${dateIn(12)}&endDate=${dateIn(15)}`)).json();
    expect(search).toHaveLength(0);
    const later = (await send('GET', `/vehicles?search=Blockable&startDate=${dateIn(13)}&endDate=${dateIn(15)}`)).json();
    expect(later).toHaveLength(1);

    // Returned on the morning of the first blocked day: no night on it, so fine.
    const before = await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(7), endDate: dateIn(10) });
    expect(before.statusCode).toBe(201);
    // And collected the morning after the last blocked day.
    const after = await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(13), endDate: dateIn(15) });
    expect(after.statusCode).toBe(201);
  });

  it('refuses days already booked, naming the booking', async () => {
    const booked = await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(30), endDate: dateIn(33) });
    const reference = booked.json().reference as string;

    const clash = await block(32, 34);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('days_booked');
    expect(clash.json().error.message).toContain(reference);

    // The morning it comes back is not a booked night.
    expect((await block(33, 34)).statusCode).toBe(201);
  });

  it('refuses the past, and an end before the start', async () => {
    const past = await block(-2, 1);
    expect(past.json().error.code).toBe('invalid_dates');
    const backwards = await block(50, 48);
    expect(backwards.json().error.code).toBe('invalid_dates');
    const reason = await block(50, 51, 'because');
    expect(reason.statusCode).toBe(400);
  });

  it('can be removed, which frees the days again', async () => {
    const created = (await block(60, 60, 'private_hire')).json();
    expect((await send('GET', `/vehicles/${vehicleId}`)).json().unavailableDates).toContain(dateIn(60));

    const removed = await send('DELETE', `/providers/me/vehicles/${vehicleId}/blocks/${created.id}`, ownerToken);
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/vehicles/${vehicleId}`)).json().unavailableDates).not.toContain(dateIn(60));
    const again = await send('DELETE', `/providers/me/vehicles/${vehicleId}/blocks/${created.id}`, ownerToken);
    expect(again.statusCode).toBe(404);
  });
});

describe('whose car it is', () => {
  it('answers 404 to another business, and not_a_provider to a customer', async () => {
    expect((await send('GET', `/providers/me/vehicles/${vehicleId}/blocks`, rivalToken)).statusCode).toBe(404);
    expect((await send('GET', `/providers/me/vehicles/${vehicleId}`, rivalToken)).statusCode).toBe(404);
    const rivalBlock = await send('POST', `/providers/me/vehicles/${vehicleId}/blocks`, rivalToken, {
      startDate: dateIn(70),
      endDate: dateIn(71),
      reason: 'other',
    });
    expect(rivalBlock.statusCode).toBe(404);

    const customer = await send('GET', `/providers/me/vehicles/${vehicleId}/blocks`, customerToken);
    expect(customer.json().error.code).toBe('not_a_provider');
  });

  it('answers feature_off while switched off', async () => {
    const off = await createTestContext();
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const res = await off.app.inject({
        method: 'GET',
        url: `/api/v1/providers/me/vehicles/${vehicleId}/blocks`,
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
