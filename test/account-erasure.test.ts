// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what is left of a person once they close their
// account — and, just as importantly, what is not.
//
// Closing used to mark the row closed and leave everything on it: the name, the
// phone number, the email address. Two consequences, both real:
//
//   - the email address stayed taken for ever, because it is unique across open
//     and closed accounts alike. Somebody who closed their own account and
//     changed their mind was told "you already have an account", quietly, and
//     could never get back in;
//   - Apple (5.1.1(v)) and Google Play both expect closing to remove the personal
//     details that are not needed for legal or financial records, which matters
//     the day the phone app offers closing.
//
// The tests that matter most: the address really is free afterwards, the phone
// number is gone, and a past booking still adds up — because a payout to a rental
// business was calculated from it.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookings, customers } from '../src/db/schema/index.js';
import { anonymisedCustomer, closedAccountEmail } from '../src/lib/anonymise.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  dateIn,
  GOOD_PASSWORD,
  seedProvider,
  seedVehicle,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let vehicleId: string;

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload, headers, remoteAddress: uniqueIp() });
const asCustomer = (bearer: string) => ({ authorization: `Bearer ${bearer}`, origin: WEB_ORIGIN });

beforeAll(async () => {
  ctx = await createTestContext();
  const provider = await seedProvider(ctx.db, { isVerified: true });
  vehicleId = (await seedVehicle(ctx.db, provider.id)).id;
});
afterAll(async () => {
  await ctx.close();
});

describe('what the rule itself says', () => {
  it('keeps a first name and an initial, and frees the address', () => {
    const left = anonymisedCustomer({ id: '0b8c1d2e-0000-4000-8000-000000000001', lastName: 'Jones' });
    // "Benjamin J." is the name a rental business was ever shown anyway, and
    // enough for whoever reads a receipt next year.
    expect(left.lastName).toBe('J.');
    expect(left.phone).toBeNull();
    // The .invalid ending is reserved by the internet's own standards, so nothing
    // can be delivered there and nobody can claim the domain.
    expect(left.email).toContain('.invalid');
    expect(left.email).toBe(left.email.toLowerCase());
  });
});

describe('closing your own account', () => {
  it('lets the same person sign up again with the same address', async () => {
    const account = await createVerifiedAccount(ctx);
    const bearer = await signInMobile(ctx, account.email, account.password);

    const closed = await post('/customers/me/close', { password: account.password }, asCustomer(bearer));
    expect(closed.statusCode).toBe(204);

    // THE POINT OF FREEING THE ADDRESS. Before, this answered as though the
    // account still existed — so somebody who changed their mind was stuck.
    const again = await post('/auth/signup', {
      firstName: 'Aria',
      lastName: 'Duncan',
      email: account.email,
      password: GOOD_PASSWORD,
      accountType: 'tourist',
    });
    expect(again.statusCode).toBe(202);

    // And it is a genuinely new account, not the old one reopened.
    const rows = await ctx.db.select().from(customers).where(eq(customers.email, account.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it('erases the phone number and shortens the surname', async () => {
    const account = await createVerifiedAccount(ctx);
    const bearer = await signInMobile(ctx, account.email, account.password);
    const [before] = await ctx.db.select().from(customers).where(eq(customers.email, account.email));
    expect(before?.lastName).toBe('Duncan');

    await post('/customers/me/close', { password: account.password }, asCustomer(bearer));

    const [after] = await ctx.db.select().from(customers).where(eq(customers.id, before!.id));
    expect(after?.phone).toBeNull();
    expect(after?.lastName).toBe('D.');
    expect(after?.email).toBe(closedAccountEmail(before!.id));
    // The first name stays: a receipt has to name whoever paid.
    expect(after?.firstName).toBe('Aria');
  });

  it('still tells the person, at the address they actually had', async () => {
    const account = await createVerifiedAccount(ctx);
    const bearer = await signInMobile(ctx, account.email, account.password);

    await post('/customers/me/close', { password: account.password }, asCustomer(bearer));

    // Read before the row was rewritten, or the confirmation would go to an
    // address that can never receive it.
    const last = ctx.email.sent.at(-1);
    expect(last?.to).toBe(account.email);
    expect(last?.subject).toContain('closed');
  });

  it('leaves a past booking whole, because money was calculated from it', async () => {
    const account = await createVerifiedAccount(ctx);
    const bearer = await signInMobile(ctx, account.email, account.password);
    const booked = await post(
      '/bookings',
      { vehicleId, startDate: dateIn(300), endDate: dateIn(303) },
      asCustomer(bearer),
    );
    expect(booked.statusCode).toBe(201);
    // Finished, so closing is allowed.
    await ctx.db.update(bookings).set({ status: 'completed' }).where(eq(bookings.id, booked.json().id));

    await post('/customers/me/close', { password: account.password }, asCustomer(bearer));

    const [row] = await ctx.db.select().from(bookings).where(eq(bookings.id, booked.json().id));
    expect(row).toBeTruthy();
    // The figures a payout to the business was worked out from are untouched.
    expect(row?.grossCents).toBe(booked.json().totalDueToday * 100);
    expect(row?.customerId).toBeTruthy();
  });
});

describe('staff closing an account from the panel', () => {
  it('leaves exactly the same thing behind as closing it yourself', async () => {
    const staff = await createSignedInStaff(ctx);
    const account = await createVerifiedAccount(ctx);
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.email, account.email));

    const closed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${customer!.id}`,
      headers: { cookie: staff.cookie, origin: WEB_ORIGIN },
      remoteAddress: uniqueIp(),
      payload: { reason: 'The customer asked us to close it for them.' },
    });
    expect(closed.statusCode).toBe(204);

    const [after] = await ctx.db.select().from(customers).where(eq(customers.id, customer!.id));
    expect(after?.phone).toBeNull();
    expect(after?.lastName).toBe('D.');
    expect(after?.email).toBe(closedAccountEmail(customer!.id));
    // Which door was used must not decide what is kept.
    expect(after?.deletedAt).toBeTruthy();
  });
});
