// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the three things staff can now do to a rental
// business from the admin panel — see that it has closed, close it, open it
// again, and correct one of its details.
//
// The tests that matter most:
//
//   - a business that closed itself shows as closed to staff. Before this it
//     appeared as an ordinary open business with a fleet of suspended cars and
//     no reason anywhere, which is a false statement on a screen;
//   - closing is refused while money is in the air, and NOTHING is changed when
//     it is refused — a half-done closure is worse than none;
//   - a wrong authenticator code is 400, never 401. The panel treats any 401 as
//     "your session has ended" and throws a signed-in person back to sign-in;
//   - every one of them writes exactly one audit entry, with the reason. A
//     business closing itself leaves no staff record, so a closure by staff has
//     to leave one.

import { eq } from 'drizzle-orm';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, bookings, providers, vehicles } from '../src/db/schema/index.js';
import {
  ADMIN_COOKIE,
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  dateIn,
  GOOD_PASSWORD,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let staff: Awaited<ReturnType<typeof createSignedInStaff>>;

const asStaff = () => ({ cookie: staff.cookie, origin: WEB_ORIGIN });
const code = () => generateOtp({ secret: staff.secret });

const get = (url: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: asStaff(), remoteAddress: uniqueIp() });
const post = (url: string, payload: object) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers: asStaff(), remoteAddress: uniqueIp() });
const patch = (url: string, payload: object) =>
  ctx.app.inject({ method: 'PATCH', url: `/api/v1${url}`, payload, headers: asStaff(), remoteAddress: uniqueIp() });

// A business with an owner who can act for it, and one car.
async function aBusiness(name: string) {
  const account = await createVerifiedAccount(ctx);
  const bearer = await signInMobile(ctx, account.email, account.password);
  const applied = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/providers/apply',
    headers: { authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN },
    remoteAddress: uniqueIp(),
    payload: {
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
  });
  if (applied.statusCode !== 201) throw new Error(`Registering the business failed: ${applied.body}`);
  const providerId = applied.json().providerId as string;
  const car = await seedVehicle(ctx.db, providerId);
  return { bearer, providerId, carId: car.id, name };
}

const auditFor = async (providerId: string) =>
  ctx.db.select().from(auditLog).where(eq(auditLog.subjectId, providerId));

beforeAll(async () => {
  ctx = await createTestContext();
  staff = await createSignedInStaff(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('a business that closed itself', () => {
  it('shows as closed to staff, and stays in the list', async () => {
    const business = await aBusiness('Self Closing Cars');

    const open = await get(`/admin/providers/${business.providerId}`);
    expect(open.json().closedAt).toBeNull();

    // The business closes itself, from its own account.
    const closed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/providers/me/close',
      headers: { authorization: `Bearer ${business.bearer}`, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
      payload: { password: GOOD_PASSWORD },
    });
    expect(closed.statusCode).toBe(200);

    const after = await get(`/admin/providers/${business.providerId}`);
    expect(after.json().closedAt).toEqual(expect.any(String));

    // STILL IN THE LIST, not filtered out: staff look a business up after it has
    // gone, because past bookings and payouts still point at it. The same way a
    // closed customer account stays in the customer list.
    const list = await get('/admin/providers?limit=200');
    expect(list.json().some((p: { id: string }) => p.id === business.providerId)).toBe(true);
  });
});

describe('staff closing a business', () => {
  it('needs a reason and a fresh code, and a wrong code is 400 not 401', async () => {
    const business = await aBusiness('Code Needed Cars');

    const noReason = await post(`/admin/providers/${business.providerId}/close`, { code: await code() });
    expect(noReason.statusCode).toBe(400);

    const noCode = await post(`/admin/providers/${business.providerId}/close`, { reason: 'Owner asked us to.' });
    expect(noCode.statusCode).toBe(400);

    // The panel reads any 401 as "your session has ended" and covers the screen
    // with a sign-in. A mistyped code inside a live session is a typo, not that.
    const wrongCode = await post(`/admin/providers/${business.providerId}/close`, {
      reason: 'Owner asked us to.',
      code: '000000',
    });
    expect(wrongCode.statusCode).toBe(400);
    expect(wrongCode.json().error.code).toBe('wrong_code');

    // Nothing was changed by any of those.
    const [row] = await ctx.db.select().from(providers).where(eq(providers.id, business.providerId));
    expect(row?.deletedAt).toBeNull();
    expect(await auditFor(business.providerId)).toHaveLength(0);
  });

  it('closes it, suspends every car, and writes one audit entry with the reason', async () => {
    const business = await aBusiness('Properly Closed Cars');

    const closed = await post(`/admin/providers/${business.providerId}/close`, {
      reason: 'Licence revoked by the authorities.',
      code: await code(),
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().closedAt).toEqual(expect.any(String));

    const [car] = await ctx.db.select().from(vehicles).where(eq(vehicles.id, business.carId));
    expect(car?.listingStatus).toBe('suspended');

    const entries = await auditFor(business.providerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'business_closed',
      subjectType: 'provider',
      field: 'Status',
      before: 'Open',
      after: 'Closed',
      reason: 'Licence revoked by the authorities.',
      staffId: staff.staffId,
    });
    // Named so somebody reading the log next year knows which business.
    expect(entries[0]?.subjectLabel).toContain('Properly Closed Cars');

    // The second attempt is refused rather than repeated.
    const again = await post(`/admin/providers/${business.providerId}/close`, {
      reason: 'Trying again.',
      code: await code(),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_closed');
    expect(await auditFor(business.providerId)).toHaveLength(1);
  });

  it('refuses while a rental is running, and changes nothing', async () => {
    const business = await aBusiness('Busy Fleet Cars');
    const renter = await createVerifiedAccount(ctx);
    const renterBearer = await signInMobile(ctx, renter.email, renter.password);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/customers/me',
      headers: { authorization: `Bearer ${renterBearer}` },
      remoteAddress: uniqueIp(),
    });

    await ctx.db.insert(bookings).values({
      reference: 'SXM-ADM-1',
      customerId: me.json().id,
      vehicleId: business.carId,
      providerId: business.providerId,
      startDate: dateIn(1),
      endDate: dateIn(4),
      pickupTime: '10:00',
      returnTime: '10:00',
      collection: 'pickup',
      location: 'Princess Juliana Airport',
      status: 'active',
      grossCents: 19500,
      commissionCents: 5850,
      payoutCents: 13650,
      totalDueTodayCents: 19500,
    });

    const refused = await post(`/admin/providers/${business.providerId}/close`, {
      reason: 'Owner asked us to.',
      code: await code(),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('has_live_rental');
    // The message names the rental, so the staff member knows what to wait for.
    expect(refused.json().error.message).toContain('SXM-ADM-1');

    // NOTHING CHANGED: the cars are still live and no entry was written. A
    // half-done closure is worse than none.
    const [car] = await ctx.db.select().from(vehicles).where(eq(vehicles.id, business.carId));
    expect(car?.listingStatus).toBe('live');
    const [row] = await ctx.db.select().from(providers).where(eq(providers.id, business.providerId));
    expect(row?.deletedAt).toBeNull();
    expect(await auditFor(business.providerId)).toHaveLength(0);
  });
});

describe('staff opening a business again', () => {
  it('clears the closure but leaves every car suspended', async () => {
    const business = await aBusiness('Second Chance Cars');
    await post(`/admin/providers/${business.providerId}/close`, { reason: 'Closed in error.', code: await code() });

    const reopened = await post(`/admin/providers/${business.providerId}/reopen`, {
      reason: 'Closed by mistake — the owner rang.',
      code: await code(),
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().closedAt).toBeNull();

    // EVERY CAR STAYS SUSPENDED. Opening a business again says it may trade, not
    // that its whole fleet goes back on the site unchecked.
    const [car] = await ctx.db.select().from(vehicles).where(eq(vehicles.id, business.carId));
    expect(car?.listingStatus).toBe('suspended');

    const entries = await auditFor(business.providerId);
    expect(entries).toHaveLength(2);
    const reopen = entries.find((entry) => entry.action === 'business_reopened');
    expect(reopen?.before).toBe('Closed');
    // The log says the part people are surprised by out loud.
    expect(reopen?.after).toContain('still suspended');

    // Its owner can act for it again.
    const profile = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/providers/me',
      headers: { authorization: `Bearer ${business.bearer}` },
      remoteAddress: uniqueIp(),
    });
    expect(profile.statusCode).toBe(200);

    // And opening an open business is refused.
    const again = await post(`/admin/providers/${business.providerId}/reopen`, {
      reason: 'Again.',
      code: await code(),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('not_closed');
  });

  it('refuses when nobody is left who could act for it', async () => {
    const business = await aBusiness('No Owner Cars');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/providers/me/close',
      headers: { authorization: `Bearer ${business.bearer}`, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
      payload: { password: GOOD_PASSWORD },
    });
    // The owner then closes their own account, which removes their membership.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/close',
      headers: { authorization: `Bearer ${business.bearer}`, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
      payload: { password: GOOD_PASSWORD },
    });

    const refused = await post(`/admin/providers/${business.providerId}/reopen`, {
      reason: 'The owner asked.',
      code: await code(),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('no_owner');
  });
});

describe('staff correcting a business detail', () => {
  it('changes one field and records what it was before', async () => {
    const business = await aBusiness('Misspelt Cars');

    const fixed = await patch(`/admin/providers/${business.providerId}`, {
      field: 'legalName',
      value: 'Misspelled Cars N.V.',
      reason: 'Spelled wrong on their payout paperwork.',
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().legalName).toBe('Misspelled Cars N.V.');

    const entries = await auditFor(business.providerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'business_updated',
      // Words, not a column name.
      field: 'Legal name',
      before: 'Misspelt Cars N.V.',
      after: 'Misspelled Cars N.V.',
      reason: 'Spelled wrong on their payout paperwork.',
    });
  });

  it('changes the public listing too, including a yes-or-no field', async () => {
    const business = await aBusiness('Delivery Cars');

    const delivers = await patch(`/admin/providers/${business.providerId}`, {
      field: 'deliversVehicles',
      value: true,
      reason: 'They told us on the phone that they deliver.',
    });
    expect(delivers.statusCode).toBe(200);
    expect(delivers.json().deliversVehicles).toBe(true);

    const side = await patch(`/admin/providers/${business.providerId}`, {
      field: 'side',
      value: 'french',
      reason: 'They moved to Marigot.',
    });
    expect(side.json().side).toBe('french');
  });

  it('refuses what has its own decision, and a value of the wrong kind', async () => {
    const business = await aBusiness('Not Yours Cars');

    // Verification has its own address, its own decision and its own audit
    // entry. Two ways to set one thing is how an audit log stops being trusted.
    for (const field of ['verificationStatus', 'isVerified', 'rating', 'reviewCount', 'deletedAt']) {
      const refused = await patch(`/admin/providers/${business.providerId}`, {
        field,
        value: 'approved',
        reason: 'Trying it on.',
      });
      expect(refused.statusCode).toBe(400);
    }

    // A yes-or-no field given words is refused here, rather than reaching the
    // database and failing as something nobody can read.
    const wrongType = await patch(`/admin/providers/${business.providerId}`, {
      field: 'deliversVehicles',
      value: 'yes',
      reason: 'Trying it on.',
    });
    expect(wrongType.statusCode).toBe(400);

    expect(await auditFor(business.providerId)).toHaveLength(0);
  });

  it('is refused for a customer, and for somebody not signed in at all', async () => {
    const business = await aBusiness('Locked Cars');
    const account = await createVerifiedAccount(ctx);
    const bearer = await signInMobile(ctx, account.email, account.password);

    const asCustomer = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/providers/${business.providerId}`,
      headers: { authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
      payload: { field: 'town', value: 'Marigot', reason: 'Trying it on.' },
    });
    expect(asCustomer.statusCode).toBe(401);

    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${business.providerId}/close`,
      headers: { origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
      payload: { reason: 'Trying it on.', code: '123456' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(ADMIN_COOKIE).toBe('sxm_admin');
  });
});
