// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests that a booking and a conversation carry enough of
// the car and the business to be drawn, and that asking for more of them does
// not cost more queries.
//
// WHY THE SECOND HALF MATTERS MORE THAN IT LOOKS: the apps used to fetch the
// WHOLE catalogue to put a car's name on a booking card, because a booking only
// carried an id. The fix is only a fix if the server does the gathering once for
// the whole list — so one of these tests counts the queries behind a list of one
// booking against a list of several, and fails if the number grows with the
// length of the list. That is the kind of thing that quietly comes back the next
// time somebody adds a field.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vehiclePhotos } from '../src/db/schema/index.js';
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
let customer: string;
let cars: string[] = [];

const asCustomer = () => ({ authorization: `Bearer ${customer}`, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });

// Counts the queries a piece of work runs, by watching the database itself.
async function countingQueries<T>(work: () => Promise<T>): Promise<{ result: T; queries: number }> {
  let queries = 0;
  const original = ctx.db.execute.bind(ctx.db);
  // Drizzle funnels everything through the session, so counting there catches
  // every read whichever helper made it.
  const session = (ctx.db as unknown as { session: { prepareQuery: unknown } }).session as {
    prepareQuery: (...args: unknown[]) => { execute: (...args: unknown[]) => Promise<unknown> };
  };
  const prepare = session.prepareQuery.bind(session);
  session.prepareQuery = (...args: unknown[]) => {
    const prepared = prepare(...args);
    const execute = prepared.execute.bind(prepared);
    prepared.execute = (...executeArgs: unknown[]) => {
      queries += 1;
      return execute(...executeArgs);
    };
    return prepared;
  };
  try {
    const result = await work();
    return { result, queries };
  } finally {
    session.prepareQuery = prepare;
    ctx.db.execute = original;
  }
}

beforeAll(async () => {
  ctx = await createTestContext();
  const account = await createVerifiedAccount(ctx);
  customer = await signInMobile(ctx, account.email, account.password);

  const provider = await seedProvider(ctx.db, { businessName: 'Summary Wheels', isVerified: true });
  for (const make of ['Suzuki', 'Kia', 'Toyota']) {
    const car = await seedVehicle(ctx.db, provider.id, { make, model: 'Test', year: 2024 });
    cars.push(car.id);
  }
  // Two photos on the first car, so "the cover is the first one" is actually
  // being tested rather than assumed.
  await ctx.db.insert(vehiclePhotos).values([
    { vehicleId: cars[0]!, storageKey: 'https://example.test/cover.jpg', position: 0 },
    { vehicleId: cars[0]!, storageKey: 'https://example.test/second.jpg', position: 1 },
  ]);
});
afterAll(async () => {
  await ctx.close();
});

describe('a booking names its car and its business', () => {
  it('carries the make, model, year and cover photo, and keeps the ids', async () => {
    const created = await post(
      '/bookings',
      { vehicleId: cars[0], startDate: dateIn(30), endDate: dateIn(33) },
      asCustomer(),
    );
    expect(created.statusCode).toBe(201);

    const one = await get(`/bookings/${created.json().id}`, asCustomer());
    expect(one.json()).toMatchObject({
      vehicleId: cars[0],
      vehicle: { id: cars[0], make: 'Suzuki', model: 'Test', year: 2024, photo: 'https://example.test/cover.jpg' },
      providerName: 'Summary Wheels',
    });
  });

  it('says photo is null for a car with no photos yet, rather than inventing one', async () => {
    const created = await post(
      '/bookings',
      { vehicleId: cars[1], startDate: dateIn(40), endDate: dateIn(42) },
      asCustomer(),
    );
    const one = await get(`/bookings/${created.json().id}`, asCustomer());
    expect(one.json().vehicle).toMatchObject({ make: 'Kia', photo: null });
  });

  // The test that keeps the fix a fix.
  it('costs no more queries for three bookings than for one', async () => {
    await post('/bookings', { vehicleId: cars[2], startDate: dateIn(50), endDate: dateIn(52) }, asCustomer());

    const { result: all, queries: forThree } = await countingQueries(() => get('/bookings', asCustomer()));
    expect(all.statusCode).toBe(200);
    expect(all.json().length).toBeGreaterThanOrEqual(3);
    // Every booking in the list is named, not just the first.
    for (const booking of all.json()) {
      expect(booking.vehicle).not.toBeNull();
      expect(booking.providerName).toBe('Summary Wheels');
    }

    // A single booking, through the same code path.
    const oneId = all.json()[0].id;
    const { queries: forOne } = await countingQueries(() => get(`/bookings/${oneId}`, asCustomer()));

    // The list is allowed to cost a little more than one booking — it has its
    // own query for the bookings themselves — but not three times as much, and
    // not more with every booking added.
    // The counter is doing something: a vacuous zero would make the comparison
    // above meaningless.
    expect(forOne).toBeGreaterThan(0);
    expect(forThree).toBeGreaterThan(0);
    expect(forThree).toBeLessThanOrEqual(forOne + 2);
  });
});

describe('a conversation names its car and its business', () => {
  it('carries both on the customer side', async () => {
    const started = await post(
      '/messages/threads',
      { providerId: (await get(`/bookings`, asCustomer())).json()[0].providerId, body: 'Is it automatic?', vehicleId: cars[0] },
      asCustomer(),
    );
    expect(started.statusCode).toBe(201);

    const threads = await get('/messages/threads', asCustomer());
    const thread = threads.json()[0];
    expect(thread.providerName).toBe('Summary Wheels');
    expect(thread.vehicle).toMatchObject({ id: cars[0], make: 'Suzuki', photo: 'https://example.test/cover.jpg' });

    const one = await get(`/messages/threads/${thread.id}`, asCustomer());
    expect(one.json().vehicle).toMatchObject({ make: 'Suzuki' });
  });
});
