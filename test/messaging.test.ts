// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests conversations between a customer and a rental
// business — starting one, replying, unread counts, and attaching a car.
//
// The test that matters most is the privacy one: a business answering a
// customer is never handed their phone number or email address. That is the
// whole reason the messages live inside SXM Rentals rather than being a mailto
// link. The others guard the walls: one customer cannot read another's
// conversation, and neither can one business read another's.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatMessages, customers } from '../src/db/schema/index.js';
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
let customerToken: string;
let customerEmail: string;
let ownerToken: string;
let rivalToken: string;
let providerId: string;
let vehicleId: string;
let rivalVehicleId: string;

const auth = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });
const get = (url: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers, remoteAddress: uniqueIp() });
const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });

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

const car = (make: string) => ({
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
  ownerToken = await signInMobile(ctx, ownerAccount.email, ownerAccount.password);
  providerId = (await post('/providers/apply', application('Simpson Bay Auto'), auth(ownerToken))).json().providerId;
  vehicleId = (await post('/providers/me/vehicles', car('Kia'), auth(ownerToken))).json().id;

  const rivalAccount = await createVerifiedAccount(ctx);
  rivalToken = await signInMobile(ctx, rivalAccount.email, rivalAccount.password);
  await post('/providers/apply', application('Cole Bay Wheels'), auth(rivalToken));
  rivalVehicleId = (await post('/providers/me/vehicles', car('Suzuki'), auth(rivalToken))).json().id;

  const account = await createVerifiedAccount(ctx);
  customerEmail = account.email;
  customerToken = await signInMobile(ctx, account.email, account.password);
  // A recognisable name, so the privacy test can look for it.
  await ctx.db
    .update(customers)
    .set({ firstName: 'Benjamin', lastName: 'Jonesworth', phone: '+1 721 555 0142' })
    .where(eq(customers.email, account.email));
});
afterAll(async () => {
  await ctx.close();
});

describe('a customer asking a business a question', () => {
  it('starts a conversation, and continues the same one next time', async () => {
    const started = await post(
      '/messages/threads',
      { providerId, body: 'Is there a child seat available for the Picanto?' },
      auth(customerToken),
    );
    expect(started.statusCode).toBe(201);
    expect(started.json().providerId).toBe(providerId);
    expect(started.json().messages).toHaveLength(1);
    expect(started.json().messages[0]).toMatchObject({ from: 'customer', read: false });

    // Asking again continues the conversation rather than starting a second.
    const again = await post('/messages/threads', { providerId, body: 'Also, is it automatic?' }, auth(customerToken));
    expect(again.json().id).toBe(started.json().id);
    expect(again.json().messages).toHaveLength(2);

    const list = await get('/messages/threads', auth(customerToken));
    expect(list.json()).toHaveLength(1);
  });

  it('refuses a message that says nothing at all', async () => {
    const empty = await post('/messages/threads', { providerId, body: '   ' }, auth(customerToken));
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('empty_message');
  });

  it('needs you to be signed in', async () => {
    expect((await get('/messages/threads')).statusCode).toBe(401);
    expect((await post('/messages/threads', { providerId, body: 'Hello' })).statusCode).toBe(401);
  });
});

describe('the business answering', () => {
  it('sees who is asking and whether they are verified — never how to contact them', async () => {
    const threads = await get('/providers/me/messages', auth(ownerToken));
    expect(threads.statusCode).toBe(200);
    const [thread] = threads.json();

    expect(thread.renterDisplayName).toBe('Benjamin J.');
    expect(thread.renterVerified).toBe(false);
    expect(thread.unreadCount).toBe(2);

    // Nothing that could be used to contact them directly.
    expect(threads.body).not.toContain(customerEmail);
    expect(threads.body).not.toContain('0142');
    expect(threads.body).not.toContain('Jonesworth');
    expect(Object.keys(thread).sort()).toEqual(
      ['id', 'renterDisplayName', 'renterVerified', 'messages', 'unreadCount'].sort(),
    );
  });

  it('replies, and can suggest one of its own cars', async () => {
    const [thread] = (await get('/providers/me/messages', auth(ownerToken))).json();

    const replied = await post(
      `/providers/me/messages/${thread.id}/messages`,
      { body: 'Yes to both. This one is cheaper for town driving:', vehicleId },
      auth(ownerToken),
    );
    expect(replied.statusCode).toBe(201);
    const last = replied.json().messages.at(-1);
    expect(last).toMatchObject({ from: 'provider', vehicleId });

    // It cannot advertise somebody else's fleet.
    const notTheirs = await post(
      `/providers/me/messages/${thread.id}/messages`,
      { body: 'Try this one', vehicleId: rivalVehicleId },
      auth(ownerToken),
    );
    expect(notTheirs.statusCode).toBe(404);
  });

  it('marks what the customer sent as read, and the customer sees the reply', async () => {
    const [thread] = (await get('/providers/me/messages', auth(ownerToken))).json();
    expect((await post(`/providers/me/messages/${thread.id}/read`, {}, auth(ownerToken))).statusCode).toBe(204);
    expect((await get('/providers/me/messages', auth(ownerToken))).json()[0].unreadCount).toBe(0);

    // The customer now has one unread: the business's reply.
    const customerView = (await get('/messages/threads', auth(customerToken))).json()[0];
    expect(customerView.unreadCount).toBe(1);

    await post(`/messages/threads/${customerView.id}/read`, {}, auth(customerToken));
    expect((await get('/messages/threads', auth(customerToken))).json()[0].unreadCount).toBe(0);
  });
});

describe('the walls around a conversation', () => {
  it("keeps one business out of another's conversations", async () => {
    const [thread] = (await get('/providers/me/messages', auth(ownerToken))).json();

    expect((await get(`/providers/me/messages/${thread.id}`, auth(rivalToken))).statusCode).toBe(404);
    expect(
      (await post(`/providers/me/messages/${thread.id}/messages`, { body: 'Hello' }, auth(rivalToken))).statusCode,
    ).toBe(404);
    expect((await get('/providers/me/messages', auth(rivalToken))).json()).toEqual([]);
  });

  it("keeps one customer out of another's conversations", async () => {
    const other = await createVerifiedAccount(ctx);
    const otherToken = await signInMobile(ctx, other.email, other.password);
    const [mine] = (await get('/messages/threads', auth(customerToken))).json();

    expect((await get(`/messages/threads/${mine.id}`, auth(otherToken))).statusCode).toBe(404);
    expect((await post(`/messages/threads/${mine.id}/messages`, { body: 'Hi' }, auth(otherToken))).statusCode).toBe(404);
    expect((await get('/messages/threads', auth(otherToken))).json()).toEqual([]);

    // Nothing was written to the conversation by the attempts above.
    const messages = await ctx.db.select().from(chatMessages).where(eq(chatMessages.threadId, mine.id));
    expect(messages).toHaveLength(3);
  });
});

describe('a conversation about a particular booking', () => {
  it('carries the booking reference, and is its own thread', async () => {
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/me/vehicles/${vehicleId}`,
      headers: auth(ownerToken),
      payload: { dailyRate: 45 },
      remoteAddress: uniqueIp(),
    });
    // The car has to be approved before anyone can book it.
    const { vehicles } = await import('../src/db/schema/index.js');
    await ctx.db.update(vehicles).set({ listingStatus: 'live' }).where(eq(vehicles.id, vehicleId));

    const booking = (
      await post('/bookings', { vehicleId, startDate: dateIn(20), endDate: dateIn(23) }, auth(customerToken))
    ).json();

    const thread = await post(
      '/messages/threads',
      { providerId, bookingId: booking.id, body: 'Our flight lands at 11:05 — will someone be there?' },
      auth(customerToken),
    );
    expect(thread.statusCode).toBe(201);
    expect(thread.json().bookingRef).toBe(booking.reference);

    // Two conversations now: the general one and this one.
    expect((await get('/messages/threads', auth(customerToken))).json()).toHaveLength(2);
    // And the business sees the reference too, still without contact details.
    const businessSide = (await get('/providers/me/messages', auth(ownerToken))).json();
    expect(businessSide.some((t: { bookingRef?: string }) => t.bookingRef === booking.reference)).toBe(true);
  });
});
