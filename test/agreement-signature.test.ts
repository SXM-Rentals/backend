// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the signature a renter draws on the rental
// agreement: kept with the booking, with which wording and when, and shown back
// to the renter and to staff — never to the rental business.
//
// The tests that matter most: anything that is not plain lines (a <script>, any
// other SVG command) is refused, because staff see these on a web page; the
// time is the server's; the first signature stands; and an app that sends no
// drawing at all still books exactly as before.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings } from '../src/db/schema/index.js';
import {
  createSignedInStaff,
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
let customerToken: string;
let otherToken: string;
let vehicleId: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST', url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: auth(token), remoteAddress: '203.0.113.9', ...(payload ? { payload } : {}) });

// "JB", roughly: two lines well over the 60-point minimum.
const SIGNATURE = {
  width: 343,
  height: 180,
  strokes: ['M12.0,40.5 L13.5,41.0 L15.0,42.5 L40.0,90.0 L60.5,120.0', 'M60.0,30.0 L61.5,33.0 L63.0,36.5 L100.0,80.0'],
};

let nextStart = 10;
async function aBooking() {
  nextStart += 5;
  const res = await send('POST', '/bookings', customerToken, { vehicleId, startDate: dateIn(nextStart), endDate: dateIn(nextStart + 2) });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json() as { id: string };
}
const sign = (bookingId: string, body: object = {}, token = customerToken) => send('POST', `/bookings/${bookingId}/agreement`, token, body);

beforeAll(async () => {
  ctx = await createTestContext({ env: { FEATURES: 'agreementDrawing' } });
  const owner = await createVerifiedAccount(ctx);
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  const providerId = (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/providers/apply',
      headers: auth(ownerToken),
      remoteAddress: uniqueIp(),
      payload: {
        businessName: 'Signed Rentals',
        legalName: 'Signed Rentals N.V.',
        contactEmail: 'hello@signedrentals.sx',
        ownerName: 'Marie Richardson',
        ownerPhone: '+1 721 555 0188',
        town: 'Simpson Bay',
        side: 'dutch',
        operatingSide: 'dutch',
      },
    })
  ).json().providerId;
  vehicleId = (await seedVehicle(ctx.db, providerId)).id;
  const customer = await createVerifiedAccount(ctx);
  customerToken = await signInMobile(ctx, customer.email, customer.password);
  const other = await createVerifiedAccount(ctx);
  otherToken = await signInMobile(ctx, other.email, other.password);
});
afterAll(async () => {
  await ctx.close();
});

describe('signing', () => {
  it('still works with an empty body, as the app released before drawings sends', async () => {
    const booking = await aBooking();
    const signed = await sign(booking.id);
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ agreementSigned: true, agreement: { version: null, drawn: false } });
    const shown = (await send('GET', `/bookings/${booking.id}/agreement`, customerToken)).json();
    expect(shown.signature).toBeNull();
  });

  it('keeps the drawing, the wording and the server time, and shows it back to the renter', async () => {
    const booking = await aBooking();
    const before = Date.now();
    const signed = await sign(booking.id, {
      agreementVersion: '2026-09-draft',
      signature: SIGNATURE,
      platform: 'ios',
      // A time sent by the phone is ignored.
      signedAt: '1999-01-01T00:00:00Z',
    });
    expect(signed.json().agreement).toMatchObject({ version: '2026-09-draft', drawn: true });
    const signedAt = new Date(signed.json().agreement.signedAt).getTime();
    expect(signedAt).toBeGreaterThanOrEqual(before - 1000);

    const shown = (await send('GET', `/bookings/${booking.id}/agreement`, customerToken)).json();
    expect(shown).toEqual({ signedAt: signed.json().agreement.signedAt, version: '2026-09-draft', signature: SIGNATURE });
  });

  it('lets the first signature stand', async () => {
    const booking = await aBooking();
    const first = (await sign(booking.id, { agreementVersion: 'v1', signature: SIGNATURE })).json();
    const second = await sign(booking.id, {
      agreementVersion: 'v2',
      signature: { ...SIGNATURE, strokes: ['M1.0,1.0 L200.0,150.0'] },
    });
    expect(second.json().agreement).toEqual(first.agreement);
    const shown = (await send('GET', `/bookings/${booking.id}/agreement`, customerToken)).json();
    expect(shown.signature.strokes).toEqual(SIGNATURE.strokes);
  });

  it('refuses anything but plain lines inside the box, long enough to be a signature', async () => {
    const booking = await aBooking();
    const refused = [
      { ...SIGNATURE, strokes: ['<script>alert(1)</script>'] },
      { ...SIGNATURE, strokes: ['M10,10 C20,20 30,30 40,40'] },
      { ...SIGNATURE, strokes: ['M10,10 L20,20" onload="alert(1)'] },
      { ...SIGNATURE, strokes: ['M1.0,1.0 L2.0,2.0'] },
      { ...SIGNATURE, strokes: ['M10.0,10.0 L400.0,100.0'] },
      { ...SIGNATURE, width: 20 },
      { ...SIGNATURE, strokes: Array.from({ length: 201 }, () => 'M10,10 L20,20') },
      { ...SIGNATURE, strokes: [] },
      'M10,10 L20,20',
    ];
    for (const signature of refused) {
      const res = await sign(booking.id, { signature });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_signature');
      expect(res.json().error.message).toMatch(/\.$/);
    }
    // Nothing was signed by any of them: the renter just signs again.
    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row!.agreementSignedAt).toBeNull();
  });

  it('is refused on a cancelled booking, and belongs to the renter', async () => {
    const booking = await aBooking();
    expect((await send('GET', `/bookings/${booking.id}/agreement`, otherToken)).statusCode).toBe(404);
    expect((await sign(booking.id, { signature: SIGNATURE }, otherToken)).statusCode).toBe(404);
    await send('POST', `/bookings/${booking.id}/cancel`, customerToken, {});
    expect((await sign(booking.id, { signature: SIGNATURE })).json().error.code).toBe('booking_cancelled');
  });
});

describe('who sees the drawing', () => {
  it('shows the business that it was signed, when and which version, and never the drawing', async () => {
    const booking = await aBooking();
    await sign(booking.id, { agreementVersion: '2026-09-draft', signature: SIGNATURE, platform: 'android' });
    const theirs = await send('GET', `/providers/me/bookings/${booking.id}`, ownerToken);
    expect(theirs.json().agreement).toMatchObject({ version: '2026-09-draft', drawn: true });
    expect(theirs.body).not.toContain('M12.0,40.5');
  });

  it('shows staff the drawing, the platform and where it was signed from', async () => {
    const booking = await aBooking();
    await sign(booking.id, { agreementVersion: '2026-09-draft', signature: SIGNATURE, platform: 'ios' });
    const staff = await createSignedInStaff(ctx);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/bookings/${booking.id}/agreement`,
      headers: { cookie: staff.cookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
    });
    expect(res.json()).toMatchObject({
      version: '2026-09-draft',
      signature: SIGNATURE,
      platform: 'ios',
      ipAddress: '203.0.113.9',
    });
  });
});
