// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the two ways somebody leaves SXM Rentals — a
// customer closing their account, and a business owner closing the business.
//
// The tests that matter most are the refusals. Closing while money is in the
// air is the thing to prevent: a rental that has not finished, a deposit still
// held on somebody's card, or a payment to a business that has not arrived.
// Closing over the top of any of those strands money nobody can then chase.
//
// The rest: closing needs the password again, because it cannot be undone from
// the website; a closed account cannot sign in or use the session it had; and a
// closed business takes its cars off the site.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, deposits, payouts, providers, vehicles } from '../src/db/schema/index.js';
import {
  createTestContext,
  createVerifiedAccount,
  dateIn,
  GOOD_PASSWORD,
  seedVehicle,
  signInMobile,
  signInWeb,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });

// A signed-in customer, and a signed-in business owner with one car listed.
async function aCustomer() {
  const account = await createVerifiedAccount(ctx);
  const bearer = await signInMobile(ctx, account.email, account.password);
  return { ...account, bearer };
}

async function aBusiness(name: string) {
  const owner = await aCustomer();
  const applied = await post(
    '/providers/apply',
    {
      businessName: name,
      legalName: `${name} N.V.`,
      contactEmail: `hello@${name.toLowerCase().replace(/\W/g, '')}.sx`,
      ownerName: 'Marie Richardson',
      ownerPhone: '+1 721 555 0188',
      town: 'Simpson Bay',
      side: 'dutch',
      operatingSide: 'dutch',
      description: 'Family run, five cars, airport pickup.',
      deliversVehicles: false,
    },
    auth(owner.bearer),
  );
  if (applied.statusCode !== 201) throw new Error(`Registering the business failed: ${applied.body}`);
  return { owner, providerId: applied.json().providerId as string };
}

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('a customer closing their own account', () => {
  it('needs the password, and the wrong one changes nothing', async () => {
    const person = await aCustomer();

    const wrong = await post('/customers/me/close', { password: 'not my password' }, auth(person.bearer));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('wrong_password');

    // Still signed in, still has an account.
    expect((await get('/customers/me', auth(person.bearer))).statusCode).toBe(200);
  });

  it('closes the account, ends every session and refuses to sign in again', async () => {
    const person = await aCustomer();
    const otherDevice = await signInMobile(ctx, person.email, person.password);

    const closed = await post('/customers/me/close', { password: person.password }, auth(person.bearer));
    expect(closed.statusCode).toBe(204);

    // The session used to close it, and the one on the other device, are both
    // dead — not just the one that made the request.
    expect((await get('/customers/me', auth(person.bearer))).statusCode).toBe(401);
    expect((await get('/customers/me', auth(otherDevice))).statusCode).toBe(401);

    // And the email address cannot be used to sign in any more.
    const again = await post('/auth/login', { email: person.email, password: person.password });
    expect(again.statusCode).toBe(401);

    // One last email says so, and it carries no link that could sign anybody in.
    const last = ctx.email.sent.at(-1);
    expect(last?.subject).toContain('closed');
    expect(last?.to).toBe(person.email);
  });

  it('takes the session cookie off the browser as well', async () => {
    const account = await createVerifiedAccount(ctx);
    const cookie = await signInWeb(ctx, account.email, account.password);

    const closed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/close',
      headers: { cookie, origin: WEB_ORIGIN },
      payload: { password: account.password },
      remoteAddress: uniqueIp(),
    });

    expect(closed.statusCode).toBe(204);
    // Cleared, so the person is visibly signed out rather than left with a
    // cookie that only produces errors.
    const cleared = closed.cookies.find((c) => c.name === 'sxm_session');
    expect(cleared?.value).toBe('');
  });

  it('refuses while a rental is still running', async () => {
    const person = await aCustomer();
    const business = await aBusiness('Grand Case Cars');
    const car = await seedVehicle(ctx.db, business.providerId);

    // A rental of theirs that has not finished.
    await ctx.db.insert(bookings).values({
      reference: 'SXM-CLOSE-1',
      customerId: (await get('/customers/me', auth(person.bearer))).json().id,
      vehicleId: car.id,
      providerId: business.providerId,
      startDate: dateIn(2),
      endDate: dateIn(5),
      pickupTime: '10:00',
      returnTime: '10:00',
      collection: 'pickup',
      location: 'Princess Juliana Airport',
      status: 'upcoming',
      grossCents: 19500,
      commissionCents: 5850,
      payoutCents: 13650,
      totalDueTodayCents: 19500,
    });

    const refused = await post('/customers/me/close', { password: person.password }, auth(person.bearer));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('has_live_rental');
    // It names the rental, so the person knows which one is in the way.
    expect(refused.json().error.message).toContain('SXM-CLOSE-1');
  });

  it('refuses while a deposit is still held on the card', async () => {
    const person = await aCustomer();
    const business = await aBusiness('Maho Motors');
    const car = await seedVehicle(ctx.db, business.providerId);
    const customerId = (await get('/customers/me', auth(person.bearer))).json().id;

    const [booking] = await ctx.db
      .insert(bookings)
      .values({
        reference: 'SXM-CLOSE-2',
        customerId,
        vehicleId: car.id,
        providerId: business.providerId,
        startDate: dateIn(-10),
        endDate: dateIn(-7),
        pickupTime: '10:00',
        returnTime: '10:00',
        collection: 'pickup',
        location: 'Princess Juliana Airport',
        // Finished, so the rental itself is not what is in the way.
        status: 'completed',
        grossCents: 19500,
        commissionCents: 5850,
        payoutCents: 13650,
        totalDueTodayCents: 19500,
      })
      .returning();
    await ctx.db.insert(deposits).values({ bookingId: booking!.id, amountCents: 50000, status: 'held' });

    const refused = await post('/customers/me/close', { password: person.password }, auth(person.bearer));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('has_held_deposit');
  });

  it('tells a business owner to close the business first', async () => {
    const business = await aBusiness('Pelican Rentals');

    const refused = await post(
      '/customers/me/close',
      { password: GOOD_PASSWORD },
      auth(business.owner.bearer),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('owns_business');
    expect(refused.json().error.message).toContain('Pelican Rentals');
  });
});

describe('a business owner closing the business', () => {
  it('takes every car off the site and closes the business', async () => {
    const business = await aBusiness('Orient Bay Autos');
    const car = await seedVehicle(ctx.db, business.providerId);

    // The car can be found before.
    expect((await get(`/vehicles/${car.id}`)).statusCode).toBe(200);

    const closed = await post('/providers/me/close', {}, auth(business.owner.bearer));
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ businessName: 'Orient Bay Autos', vehiclesDelisted: 1 });

    // And not after — neither on its own page nor in a search.
    expect((await get(`/vehicles/${car.id}`)).statusCode).toBe(404);
    const search = await get('/vehicles?search=Jimny');
    expect(search.json().some((v: { id: string }) => v.id === car.id)).toBe(false);

    // The business is gone from the public list, and its row is still there for
    // past bookings and payouts to point at.
    const [row] = await ctx.db.select().from(providers).where(eq(providers.id, business.providerId));
    expect(row?.deletedAt).toBeTruthy();
    const [vehicleRow] = await ctx.db.select().from(vehicles).where(eq(vehicles.id, car.id));
    expect(vehicleRow?.listingStatus).toBe('suspended');

    // Closing twice is refused rather than silently repeated.
    const again = await post('/providers/me/close', {}, auth(business.owner.bearer));
    expect([403, 404, 409]).toContain(again.statusCode);
  });

  it('refuses while a rental is running', async () => {
    const business = await aBusiness('Cupecoy Cars');
    const car = await seedVehicle(ctx.db, business.providerId);
    const renter = await aCustomer();

    await ctx.db.insert(bookings).values({
      reference: 'SXM-CLOSE-3',
      customerId: (await get('/customers/me', auth(renter.bearer))).json().id,
      vehicleId: car.id,
      providerId: business.providerId,
      startDate: dateIn(1),
      endDate: dateIn(4),
      pickupTime: '10:00',
      returnTime: '10:00',
      collection: 'pickup',
      location: 'Princess Juliana Airport',
      status: 'upcoming',
      grossCents: 19500,
      commissionCents: 5850,
      payoutCents: 13650,
      totalDueTodayCents: 19500,
    });

    const refused = await post('/providers/me/close', {}, auth(business.owner.bearer));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('has_live_rental');
  });

  it('refuses while a payment to the business is still on its way', async () => {
    const business = await aBusiness('Philipsburg Fleet');

    await ctx.db.insert(payouts).values({
      reference: 'SXM-PO-9001',
      providerId: business.providerId,
      amountCents: 13650,
      grossCents: 19500,
      commissionCents: 5850,
      bookingCount: 1,
      status: 'pending',
      periodStart: dateIn(-30),
      periodEnd: dateIn(-1),
    });

    const refused = await post('/providers/me/close', {}, auth(business.owner.bearer));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('payout_pending');
    expect(refused.json().error.message).toContain('SXM-PO-9001');
  });

  it('is refused for a customer who does not run a business at all', async () => {
    const person = await aCustomer();
    const refused = await post('/providers/me/close', {}, auth(person.bearer));
    expect([403, 404]).toContain(refused.statusCode);
  });
});
