// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests that two bookings drawing the same reference
// (SXM-1234) still both get made: the second simply draws again.
//
// Until this was fixed, the second booking failed with "something went wrong",
// because the retry ran inside a transaction Postgres had already given up on.
// There are only 9,000 four-digit references, so the more bookings there are,
// the more often this happens to a real customer.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
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

let ctx: TestContext;
let token: string;
let vehicleId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = await seedProvider(ctx.db);
  vehicleId = (await seedVehicle(ctx.db, provider.id)).id;
  const account = await createVerifiedAccount(ctx);
  token = await signInMobile(ctx, account.email, account.password);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await ctx.close();
});

// The address is chosen by the caller: making one draws Math.random too, which
// would use up the numbers planted for the reference.
const book = (startsIn: number, remoteAddress: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/bookings',
    payload: { vehicleId, startDate: dateIn(startsIn), endDate: dateIn(startsIn + 2) },
    headers: { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
    remoteAddress,
  });

describe('a booking reference drawn twice', () => {
  it('draws again, and both bookings are made', async () => {
    const [firstIp, secondIp] = [uniqueIp(), uniqueIp()];
    // Only the reference draw is steered — other code (the rate limiter, say)
    // uses Math.random too and keeps its real numbers. The first booking draws
    // 0.5; the second draws 0.5 as well (a clash), then 0.7.
    const planted = [0.5, 0.5, 0.7];
    const real = Math.random.bind(Math);
    const random = vi.spyOn(Math, 'random').mockImplementation(() =>
      (new Error().stack ?? '').includes('newReference') && planted.length > 0 ? planted.shift()! : real(),
    );

    const first = await book(30, firstIp);
    const second = await book(40, secondIp);
    random.mockRestore();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    // 0.5 draws SXM-5500 for both; the second draws again and gets SXM-7300.
    expect(first.json().reference).toBe('SXM-5500');
    expect(second.json().reference).toBe('SXM-7300');
  });
});
