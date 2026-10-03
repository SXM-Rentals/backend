// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the switch that lets newly added cars skip staff
// approval while the owner is testing before launch (VEHICLE_APPROVAL=off), and
// that approval is still required whenever the switch is not set.

import { describe, expect, it } from 'vitest';
import { createTestContext, createVerifiedAccount, signInMobile, uniqueIp, WEB_ORIGIN } from './helpers.js';

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

async function addACar(env: Record<string, string>) {
  const ctx = await createTestContext({ env });
  try {
    const account = await createVerifiedAccount(ctx);
    const token = await signInMobile(ctx, account.email, account.password);
    const headers = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/providers/apply',
      headers,
      remoteAddress: uniqueIp(),
      payload: {
        businessName: 'Approval Cars',
        legalName: 'Approval Cars N.V.',
        contactEmail: 'hello@approvalcars.sx',
        ownerName: 'Marie Richardson',
        ownerPhone: '+1 721 555 0188',
        town: 'Simpson Bay',
        side: 'dutch',
        operatingSide: 'dutch',
      },
    });
    const added = await ctx.app.inject({ method: 'POST', url: '/api/v1/providers/me/vehicles', headers, remoteAddress: uniqueIp(), payload: car });
    const publicCar = await ctx.app.inject({ method: 'GET', url: `/api/v1/vehicles/${added.json().id}`, remoteAddress: uniqueIp() });
    return { listingStatus: added.json().listingStatus as string, publicStatus: publicCar.statusCode };
  } finally {
    await ctx.close();
  }
}

describe('car approval', () => {
  it('is required unless switched off: a new car waits, unseen by customers', async () => {
    expect(await addACar({})).toEqual({ listingStatus: 'pending_review', publicStatus: 404 });
  });

  it('when switched off, puts a new car on the site straight away', async () => {
    expect(await addACar({ VEHICLE_APPROVAL: 'off' })).toEqual({ listingStatus: 'live', publicStatus: 200 });
  });
});
