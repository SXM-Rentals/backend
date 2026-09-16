// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the rental business's own dashboard — registering,
// its record, its fleet, the bookings across that fleet, and being paid.
//
// The tests that matter most here are the ones about walls: that one business
// cannot see or change another's cars and bookings, that a business never
// receives a customer's phone number or email, that its public page never
// carries its private details, and that a booking can only ever be paid out
// once and never includes a security deposit.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, deposits, providerPayoutAccounts, vehicles } from '../src/db/schema/index.js';
import { buildPayout, nextPayoutDate, sendPayout } from '../src/services/payment-splitting/index.js';
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
// The business we are, and a second one that must never see our things.
let owner: string;
let rival: string;
let renter: string;
let providerId: string;

const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const patch = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'PATCH', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const del = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'DELETE', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });

const application = (businessName: string) => ({
  businessName,
  legalName: `${businessName} N.V.`,
  contactEmail: `hello@${businessName.toLowerCase().replace(/\W/g, '')}.sx`,
  ownerName: 'Marie Richardson',
  ownerPhone: '+1 721 555 0188',
  town: 'Simpson Bay',
  side: 'dutch' as const,
  operatingSide: 'dutch' as const,
  description: 'Family run, five cars, airport pickup.',
  deliversVehicles: true,
});

const carDetails = (make: string) => ({
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

beforeAll(async () => {
  ctx = await createTestContext();

  const ownerAccount = await createVerifiedAccount(ctx);
  owner = await signInMobile(ctx, ownerAccount.email, ownerAccount.password);
  const rivalAccount = await createVerifiedAccount(ctx);
  rival = await signInMobile(ctx, rivalAccount.email, rivalAccount.password);
  const renterAccount = await createVerifiedAccount(ctx);
  renter = await signInMobile(ctx, renterAccount.email, renterAccount.password);

  const applied = await post('/providers/apply', application('Simpson Bay Auto'), auth(owner));
  providerId = applied.json().providerId;
  await post('/providers/apply', application('Cole Bay Wheels'), auth(rival));
});
afterAll(async () => {
  await ctx.close();
});

describe('registering a business', () => {
  it('creates it unverified, and links it to whoever applied', async () => {
    const profile = await get('/providers/me', auth(owner));
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      providerId,
      legalName: 'Simpson Bay Auto N.V.',
      operatingSide: 'dutch',
      apiConnected: false,
    });

    // Staff decide whether a business is verified — it cannot claim it itself.
    const publicPage = await get(`/providers/${providerId}`);
    expect(publicPage.json().isVerified).toBe(false);
  });

  it('refuses a second business on the same account', async () => {
    const again = await post('/providers/apply', application('Another Company'), auth(owner));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_a_provider');
  });

  it('tells an ordinary customer plainly that they have no business', async () => {
    const res = await get('/providers/me', auth(renter));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_a_provider');
  });
});

describe('the business record', () => {
  it('edits its own details, and keeps the private half off the public page', async () => {
    const updated = await patch(
      '/providers/me',
      { description: 'Six cars, free delivery to the airport.', ownerPhone: '+1 721 555 0900' },
      auth(owner),
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.json().legalName).toBe('Simpson Bay Auto N.V.');

    const publicPage = await get(`/providers/${providerId}`);
    expect(publicPage.json().description).toBe('Six cars, free delivery to the airport.');
    // None of the private half reaches a customer.
    expect(publicPage.body).not.toContain('N.V.');
    expect(publicPage.body).not.toContain('0900');
    expect(publicPage.body).not.toContain('Marie Richardson');
  });
});

describe('the fleet', () => {
  it('adds a car that waits for staff approval before customers see it', async () => {
    const added = await post('/providers/me/vehicles', carDetails('Kia'), auth(owner));
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ dailyRate: 45, depositAmount: 300, listingStatus: 'pending_review' });

    // Its owner sees it...
    const fleet = await get('/providers/me/vehicles', auth(owner));
    expect(fleet.json().some((car: { id: string }) => car.id === added.json().id)).toBe(true);

    // ...but a customer searching cannot, until staff approve it.
    const search = await get('/vehicles?search=Kia');
    expect(search.json()).toEqual([]);
  });

  it("will not let one business touch another's cars", async () => {
    const mine = (await post('/providers/me/vehicles', carDetails('Suzuki'), auth(owner))).json();

    expect((await patch(`/providers/me/vehicles/${mine.id}`, { dailyRate: 1 }, auth(rival))).statusCode).toBe(404);
    expect((await del(`/providers/me/vehicles/${mine.id}`, auth(rival))).statusCode).toBe(404);

    const rivalFleet = await get('/providers/me/vehicles', auth(rival));
    expect(rivalFleet.json().some((car: { id: string }) => car.id === mine.id)).toBe(false);

    // Untouched.
    const [row] = await ctx.db.select().from(vehicles).where(eq(vehicles.id, mine.id));
    expect(row!.dailyRateCents).toBe(4500);
  });

  it('changes its own prices, and removes a car only when nobody is due to collect it', async () => {
    const car = (await post('/providers/me/vehicles', carDetails('Toyota'), auth(owner))).json();

    const repriced = await patch(`/providers/me/vehicles/${car.id}`, { dailyRate: 52.5 }, auth(owner));
    expect(repriced.json().dailyRate).toBe(52.5);

    // Approve it and let somebody book it.
    await ctx.db.update(vehicles).set({ listingStatus: 'live' }).where(eq(vehicles.id, car.id));
    const booked = await post(
      '/bookings',
      { vehicleId: car.id, startDate: dateIn(15), endDate: dateIn(18) },
      auth(renter),
    );
    expect(booked.statusCode).toBe(201);

    const refused = await del(`/providers/me/vehicles/${car.id}`, auth(owner));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('vehicle_has_bookings');

    // A car nobody has booked can be taken off.
    const spare = (await post('/providers/me/vehicles', carDetails('Nissan'), auth(owner))).json();
    expect((await del(`/providers/me/vehicles/${spare.id}`, auth(owner))).statusCode).toBe(204);
    expect((await get('/providers/me/vehicles', auth(owner))).json().some((c: { id: string }) => c.id === spare.id)).toBe(
      false,
    );
  });
});

describe('bookings across the fleet', () => {
  it("shows who is collecting the car, and never the customer's contact details", async () => {
    const list = await get('/providers/me/bookings', auth(owner));
    expect(list.statusCode).toBe(200);
    const [booking] = list.json();
    expect(booking).toBeTruthy();

    // A display name and whether they are verified — that is all.
    expect(booking.renterDisplayName).toMatch(/^\w+ \w\.$/);
    expect(Object.keys(booking).sort()).toEqual(
      [
        'id',
        'reference',
        'vehicleId',
        'status',
        'renterDisplayName',
        'renterVerified',
        'startDate',
        'endDate',
        'pickupTime',
        'returnTime',
        'collection',
        'location',
        'grossAmount',
        'commission',
        'netAmount',
        'depositAmount',
        'depositStatus',
      ].sort(),
    );
    expect(list.body).not.toMatch(/@example\.com/);

    // Every figure adds up, with the deduction visible.
    expect(booking.commission + booking.netAmount).toBe(booking.grossAmount);

    const one = await get(`/providers/me/bookings/${booking.id}`, auth(owner));
    expect(one.json().reference).toBe(booking.reference);
    // The other business cannot open it.
    expect((await get(`/providers/me/bookings/${booking.id}`, auth(rival))).statusCode).toBe(404);
  });
});

describe('being paid', () => {
  it('gathers finished bookings into one payout, once, and never includes a deposit', async () => {
    const [booking] = await ctx.db.select().from(bookings).where(eq(bookings.providerId, providerId));
    expect(booking).toBeTruthy();
    // The rental has happened and the customer's payment arrived.
    await ctx.db
      .update(bookings)
      .set({ status: 'completed', paymentStatus: 'paid' })
      .where(eq(bookings.id, booking!.id));

    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, booking!.id));
    expect(deposit!.amountCents).toBeGreaterThan(0);

    const payout = await buildPayout(ctx.db, providerId, { start: booking!.endDate, end: booking!.endDate });
    expect(payout).toBeTruthy();
    // The deposit is nowhere in it: gross is the rental money alone.
    expect(payout!.grossCents).toBe(booking!.grossCents);
    expect(payout!.amountCents).toBe(booking!.payoutCents);
    expect(payout!.amountCents + payout!.commissionCents).toBe(payout!.grossCents);
    expect(payout!.grossCents).not.toBe(booking!.grossCents + deposit!.amountCents);

    // Running it again pays nothing: the booking is already stamped.
    const again = await buildPayout(ctx.db, providerId, { start: booking!.endDate, end: booking!.endDate });
    expect(again).toBeNull();
  });

  it('cannot send money until the business has given Stripe its details', async () => {
    const [payout] = (await get('/providers/me/payouts', auth(owner))).json();
    expect(payout).toMatchObject({ status: 'pending' });
    // Gross, commission and what reaches the bank, all shown together.
    expect(payout.amount + payout.commission).toBe(payout.grossAmount);

    await expect(sendPayout(ctx.db, ctx.gateway, payout.id)).rejects.toMatchObject({ code: 'payouts_not_enabled' });
  });

  it('sets up the Stripe account, and pays out once Stripe says it can', async () => {
    const start = await post('/providers/me/payout-account', {}, auth(owner));
    expect(start.statusCode).toBe(200);
    expect(start.json().url).toContain('https://');

    const [account] = await ctx.db
      .select()
      .from(providerPayoutAccounts)
      .where(eq(providerPayoutAccounts.providerId, providerId));
    const accountId = account!.stripeAccountId!;
    expect(accountId).toBeTruthy();

    // Still waiting on details.
    const pending = await get('/providers/me/payout-account', auth(owner));
    expect(pending.json()).toMatchObject({ payoutsEnabled: false });
    expect(pending.json().outstanding).toContain('bank_account');

    // Stripe says the business is ready.
    const event = ctx.gateway.accountEventFor(accountId, true, []);
    const delivered = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'test-signature' },
      payload: JSON.stringify(event),
      remoteAddress: uniqueIp(),
    });
    expect(delivered.statusCode).toBe(200);

    const ready = await get('/providers/me/payout-account', auth(owner));
    expect(ready.json()).toMatchObject({ payoutsEnabled: true, status: 'active' });

    const [payout] = (await get('/providers/me/payouts', auth(owner))).json();
    await sendPayout(ctx.db, ctx.gateway, payout.id);

    // Stripe was asked to send exactly the business's share.
    expect(ctx.gateway.transfers).toContainEqual({
      accountId,
      amountCents: Math.round(payout.amount * 100),
      reference: payout.reference,
    });
    const [paid] = (await get('/providers/me/payouts', auth(owner))).json();
    expect(paid).toMatchObject({ status: 'paid' });
  });
});

describe('the dashboard figures', () => {
  it('counts its own fleet and bookings, and says when the next payout runs', async () => {
    const summary = (await get('/providers/me/summary', auth(owner))).json();

    expect(summary.fleetSize).toBeGreaterThan(0);
    expect(summary.paidOut).toBeGreaterThan(0);
    expect(typeof summary.averageRating).toBe('number');
    // Payouts run on a Monday.
    expect(new Date(`${summary.nextPayoutDate}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(summary.nextPayoutDate).toBe(nextPayoutDate());

    // The other business's dashboard is its own, and empty of ours.
    const rivalSummary = (await get('/providers/me/summary', auth(rival))).json();
    expect(rivalSummary.fleetSize).toBe(0);
    expect(rivalSummary.paidOut).toBe(0);

    const performance = (await get('/providers/me/performance', auth(owner))).json();
    expect(performance.length).toBe(summary.fleetSize);
    for (const row of performance) {
      expect(row.occupancyRate).toBeGreaterThanOrEqual(0);
      expect(row.occupancyRate).toBeLessThanOrEqual(1);
      // Enquiries are conversations started with this business. Nobody has
      // messaged this one, so it is 0 here — see messaging.test.ts for the
      // case where somebody has.
      expect(row.inquiries).toBe(0);
    }
  });
});
