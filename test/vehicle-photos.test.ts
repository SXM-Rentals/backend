// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests how a business puts photos on one of its cars.
//
// The photo itself never passes through the API — the app uploads it straight to
// Cloudinary with a signed ticket — so what these tests actually check is the
// part that can be abused: WHICH addresses the backend will accept afterwards.
//
// The test that matters most: a business cannot attach a photo to another
// business's car, and cannot point a listing at an address we did not issue a
// ticket for. Without that check, "the photo is at this address" would be a
// business's word for it, and a listing could show anything on the internet.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhotoStorage } from '../src/lib/storage.js';
import {
  createTestContext,
  createVerifiedAccount,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

// Stands in for Cloudinary: issues tickets, accepts only the addresses it would
// really have produced, and remembers what it was asked to delete.
function fakeStorage(): PhotoStorage & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    ticketFor(folder) {
      return {
        uploadUrl: 'https://api.cloudinary.test/upload',
        fields: { folder, timestamp: '1700000000', api_key: 'test-key', signature: 'test-signature' },
        maxBytes: 8 * 1024 * 1024,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    },
    ownsAddress(url, folder) {
      return url.startsWith('https://res.cloudinary.test/') && url.includes(`/${folder}/`);
    },
    async remove(url) {
      removed.push(url);
    },
  };
}

let ctx: TestContext;
let storage: ReturnType<typeof fakeStorage>;

const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const patch = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'PATCH', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const del = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'DELETE', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });

async function aBusiness(name: string) {
  const account = await createVerifiedAccount(ctx);
  const bearer = await signInMobile(ctx, account.email, account.password);
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
    auth(bearer),
  );
  if (applied.statusCode !== 201) throw new Error(`Registering the business failed: ${applied.body}`);
  const providerId = applied.json().providerId as string;
  const car = await seedVehicle(ctx.db, providerId);
  return { bearer, providerId, carId: car.id };
}

// The address an upload to that car's folder would really produce.
const addressFor = (providerId: string, carId: string, name: string) =>
  `https://res.cloudinary.test/image/upload/v1700000000/sxm-rentals/vehicles/${providerId}/${carId}/${name}.jpg`;

beforeAll(async () => {
  storage = fakeStorage();
  ctx = await createTestContext({ storage });
});
afterAll(async () => {
  await ctx.close();
});

describe('putting photos on a car', () => {
  it('gives a ticket for that car only, and says how many more are allowed', async () => {
    const business = await aBusiness('Simpson Bay Snaps');

    const ticket = await post(`/providers/me/vehicles/${business.carId}/photos/upload-ticket`, {}, auth(business.bearer));
    expect(ticket.statusCode).toBe(200);
    // The folder is per car, which is what stops one ticket being used for
    // another car or another business.
    expect(ticket.json().fields.folder).toBe(`sxm-rentals/vehicles/${business.providerId}/${business.carId}`);
    expect(ticket.json().photosAllowed).toBe(12);
    expect(ticket.json().maxBytes).toBeGreaterThan(0);
  });

  it('accepts the address the upload produced, and shows the first as the cover', async () => {
    const business = await aBusiness('Cole Bay Cameras');
    const first = addressFor(business.providerId, business.carId, 'front');
    const second = addressFor(business.providerId, business.carId, 'interior');

    const added = await post(`/providers/me/vehicles/${business.carId}/photos`, { url: first }, auth(business.bearer));
    expect(added.statusCode).toBe(201);
    await post(`/providers/me/vehicles/${business.carId}/photos`, { url: second }, auth(business.bearer));

    const photos = await get(`/providers/me/vehicles/${business.carId}/photos`, auth(business.bearer));
    expect(photos.json()).toMatchObject([
      { url: first, position: 0, isCover: true },
      { url: second, position: 1, isCover: false },
    ]);

    // And customers see them on the car, in the same order.
    const car = await get(`/vehicles/${business.carId}`);
    expect(car.json().photos).toEqual([first, second]);
  });

  // The one that matters: the address is the business's word for it, so it is
  // checked rather than believed.
  it('refuses an address that was never uploaded for this car', async () => {
    const mine = await aBusiness('Maho Media');
    const theirs = await aBusiness('Orient Optics');

    const somewhereElse = 'https://res.cloudinary.test/image/upload/v1/somebody-else/car.jpg';
    const theirCarsFolder = addressFor(theirs.providerId, theirs.carId, 'front');
    const offTheInternet = 'https://example.com/a-nicer-car.jpg';

    for (const url of [somewhereElse, theirCarsFolder, offTheInternet]) {
      const refused = await post(`/providers/me/vehicles/${mine.carId}/photos`, { url }, auth(mine.bearer));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('photo_not_recognised');
    }

    expect((await get(`/providers/me/vehicles/${mine.carId}/photos`, auth(mine.bearer))).json()).toEqual([]);
  });

  it('will not let one business touch another business\'s car at all', async () => {
    const mine = await aBusiness('Philipsburg Photos');
    const theirs = await aBusiness('Grand Case Gallery');

    // Not 403: a car that is not yours is simply not found, so nobody can learn
    // which ids exist by asking.
    expect((await post(`/providers/me/vehicles/${theirs.carId}/photos/upload-ticket`, {}, auth(mine.bearer))).statusCode).toBe(404);
    expect((await get(`/providers/me/vehicles/${theirs.carId}/photos`, auth(mine.bearer))).statusCode).toBe(404);
  });

  it('does not show the same photo twice when an upload is retried', async () => {
    const business = await aBusiness('Dawn Beach Digital');
    const url = addressFor(business.providerId, business.carId, 'front');

    await post(`/providers/me/vehicles/${business.carId}/photos`, { url }, auth(business.bearer));
    const again = await post(`/providers/me/vehicles/${business.carId}/photos`, { url }, auth(business.bearer));

    expect(again.statusCode).toBe(201);
    expect(again.json()).toHaveLength(1);
  });

  it('reorders them, so the business chooses which photo sells the car', async () => {
    const business = await aBusiness('Cupecoy Captures');
    const front = addressFor(business.providerId, business.carId, 'front');
    const back = addressFor(business.providerId, business.carId, 'back');
    await post(`/providers/me/vehicles/${business.carId}/photos`, { url: front }, auth(business.bearer));
    const after = await post(`/providers/me/vehicles/${business.carId}/photos`, { url: back }, auth(business.bearer));
    const [frontPhoto, backPhoto] = after.json();

    const reordered = await patch(
      `/providers/me/vehicles/${business.carId}/photos`,
      { order: [backPhoto.id, frontPhoto.id] },
      auth(business.bearer),
    );
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json()[0]).toMatchObject({ url: back, isCover: true });

    // A partial list is refused rather than leaving the rest in an order
    // nobody chose.
    const partial = await patch(
      `/providers/me/vehicles/${business.carId}/photos`,
      { order: [backPhoto.id] },
      auth(business.bearer),
    );
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error.code).toBe('incomplete_order');
  });

  it('removes one, closes the gap, and asks for the file to go too', async () => {
    const business = await aBusiness('Airport Angles');
    const first = addressFor(business.providerId, business.carId, 'one');
    const second = addressFor(business.providerId, business.carId, 'two');
    await post(`/providers/me/vehicles/${business.carId}/photos`, { url: first }, auth(business.bearer));
    const both = await post(`/providers/me/vehicles/${business.carId}/photos`, { url: second }, auth(business.bearer));
    const [firstPhoto] = both.json();

    const removed = await del(`/providers/me/vehicles/${business.carId}/photos/${firstPhoto.id}`, auth(business.bearer));
    expect(removed.statusCode).toBe(200);
    // The remaining photo becomes the cover, with no gap left in the order.
    expect(removed.json()).toMatchObject([{ url: second, position: 0, isCover: true }]);
    expect(storage.removed).toContain(first);

    // Somebody else's photo id reads as "not found", like an id that never was.
    const other = await aBusiness('Bay Views');
    expect(
      (await del(`/providers/me/vehicles/${business.carId}/photos/${firstPhoto.id}`, auth(other.bearer))).statusCode,
    ).toBe(404);
  });
});

describe('before Cloudinary is connected', () => {
  it('says photo uploads are not switched on, rather than losing a photo', async () => {
    // A context with no storage configured at all — what production looked like
    // until the account existed.
    const plain = await createTestContext();
    try {
      const account = await createVerifiedAccount(plain);
      const bearer = await signInMobile(plain, account.email, account.password);
      const applied = await plain.app.inject({
        method: 'POST',
        url: '/api/v1/providers/apply',
        headers: { authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN },
        remoteAddress: uniqueIp(),
        payload: {
          businessName: 'No Cloud Cars',
          legalName: 'No Cloud Cars N.V.',
          contactEmail: 'hello@nocloudcars.sx',
          ownerName: 'Marie Richardson',
          ownerPhone: '+1 721 555 0188',
          town: 'Simpson Bay',
          side: 'dutch',
          operatingSide: 'dutch',
          description: 'Family run.',
          deliversVehicles: false,
        },
      });
      const car = await seedVehicle(plain.db, applied.json().providerId);

      const ticket = await plain.app.inject({
        method: 'POST',
        url: `/api/v1/providers/me/vehicles/${car.id}/photos/upload-ticket`,
        headers: { authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN },
        remoteAddress: uniqueIp(),
        payload: {},
      });

      expect(ticket.statusCode).toBe(503);
      expect(ticket.json().error.code).toBe('uploads_unavailable');
    } finally {
      await plain.close();
    }
  });
});
