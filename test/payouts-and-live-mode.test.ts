// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests what had to be right before taking real money:
// forgetting Stripe's test-mode records when the keys go live, paying each
// business by the route that actually reaches its bank, and staff sending a
// payout (or recording a bank transfer) from the admin panel.
//
// The tests that matter most: going live forgets test records but never a paid
// booking's, and going BACK to test keys forgets nothing; a Dutch-side bank is
// never handed to Stripe, which cannot pay it; and real money leaving SXM
// Rentals needs Owner access, the authenticator code and an audit row.

import { and, eq } from 'drizzle-orm';
import { generate as generateOtp } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  bookings,
  customers,
  deposits,
  ledgerEntries,
  payouts,
  providerPayoutAccounts,
} from '../src/db/schema/index.js';
import { buildPayout } from '../src/services/payment-splitting/index.js';
import { recordedStripeMode, settleStripeMode, stripeKeyMode } from '../src/services/payments/stripe-mode.js';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  seedBooking,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

const quiet = { info: () => {}, warn: () => {} };

describe('going live with Stripe', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('tells test keys from live ones', () => {
    expect(stripeKeyMode('sk_test_abc')).toBe('test');
    expect(stripeKeyMode('sk_live_abc')).toBe('live');
    expect(stripeKeyMode('rk_live_abc')).toBe('live');
  });

  it('forgets test-mode records on the first start with live keys, never a paid booking, and never on the way back', async () => {
    const unpaid = await seedBooking(ctx.db);
    const paid = await seedBooking(ctx.db);
    await ctx.db.update(customers).set({ stripeCustomerId: 'cus_test_1' }).where(eq(customers.id, unpaid.customer.id));
    await ctx.db.update(bookings).set({ stripePaymentIntentId: 'pi_test_unpaid' }).where(eq(bookings.id, unpaid.booking.id));
    await ctx.db
      .update(bookings)
      .set({ stripePaymentIntentId: 'pi_test_paid', paymentStatus: 'paid' })
      .where(eq(bookings.id, paid.booking.id));
    await ctx.db.insert(deposits).values({
      bookingId: unpaid.booking.id,
      amountCents: 50000,
      paymentMethodId: 'pm_test_1',
      holdConsentAt: new Date(),
    });
    await ctx.db.insert(providerPayoutAccounts).values({
      providerId: unpaid.provider.id,
      stripeAccountId: 'acct_test_1',
      status: 'active',
      payoutsEnabled: true,
    });

    // Testing: the mode is remembered, nothing forgotten.
    expect((await settleStripeMode(ctx.db, 'sk_test_abc', quiet)).forgotten).toBeNull();
    expect(await recordedStripeMode(ctx.db)).toBe('test');

    // Live: the test records go.
    const live = await settleStripeMode(ctx.db, 'sk_live_abc', quiet);
    expect(live.forgotten).toMatchObject({ customers: 1, payoutAccounts: 1, unpaidBookings: 1, deposits: 1 });
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, unpaid.customer.id));
    expect(customer!.stripeCustomerId).toBeNull();
    const [account] = await ctx.db.select().from(providerPayoutAccounts).where(eq(providerPayoutAccounts.providerId, unpaid.provider.id));
    expect(account).toMatchObject({ stripeAccountId: null, status: 'not_started', payoutsEnabled: false });
    const [deposit] = await ctx.db.select().from(deposits).where(eq(deposits.bookingId, unpaid.booking.id));
    expect(deposit).toMatchObject({ paymentMethodId: null, holdConsentAt: null });
    expect((await ctx.db.select().from(bookings).where(eq(bookings.id, unpaid.booking.id)))[0]!.stripePaymentIntentId).toBeNull();
    // The paid booking keeps its record.
    expect((await ctx.db.select().from(bookings).where(eq(bookings.id, paid.booking.id)))[0]!.stripePaymentIntentId).toBe('pi_test_paid');

    // Starting again with live keys changes nothing more.
    await ctx.db.update(customers).set({ stripeCustomerId: 'cus_live_1' }).where(eq(customers.id, unpaid.customer.id));
    expect((await settleStripeMode(ctx.db, 'sk_live_abc', quiet)).forgotten).toBeNull();
    // Test keys on a live database: nothing forgotten, and it stays live.
    expect((await settleStripeMode(ctx.db, 'sk_test_abc', quiet)).forgotten).toBeNull();
    expect(await recordedStripeMode(ctx.db)).toBe('live');
    const [still] = await ctx.db.select().from(customers).where(eq(customers.id, unpaid.customer.id));
    expect(still!.stripeCustomerId).toBe('cus_live_1');
  });
});

describe('where a business is paid', () => {
  let ctx: TestContext;
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
  async function aBusiness(side: 'dutch' | 'french') {
    const account = await createVerifiedAccount(ctx);
    const token = await signInMobile(ctx, account.email, account.password);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/providers/apply',
      headers: auth(token),
      remoteAddress: uniqueIp(),
      payload: {
        businessName: `${side} Wheels`,
        legalName: `${side} Wheels N.V.`,
        contactEmail: `hello@${side}${Math.floor(Math.random() * 1e6)}.sx`,
        ownerName: 'Marie Richardson',
        ownerPhone: '+1 721 555 0188',
        town: side === 'french' ? 'Marigot' : 'Simpson Bay',
        side,
        operatingSide: side,
      },
    });
    return token;
  }
  const setUp = (token: string, body: object) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/providers/me/payout-account', headers: auth(token), payload: body, remoteAddress: uniqueIp() });

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('asks a Dutch-side business where its bank is', async () => {
    const res = await setUp(await aBusiness('dutch'), {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bank_country_needed');
  });

  it('pays a Dutch-side bank by bank transfer, and never hands it to Stripe', async () => {
    const token = await aBusiness('dutch');
    const accountsBefore = ctx.gateway.accounts.size;
    const res = await setUp(token, { bankCountry: 'SX' });
    expect(res.json()).toMatchObject({ url: null, method: 'bank_transfer' });
    expect(ctx.gateway.accounts.size).toBe(accountsBefore);
    const state = await ctx.app.inject({ method: 'GET', url: '/api/v1/providers/me/payout-account', headers: auth(token), remoteAddress: uniqueIp() });
    expect(state.json()).toMatchObject({ method: 'bank_transfer', country: 'SX' });
  });

  it('opens a US account for a US bank, and a French one for the French side by default', async () => {
    const us = await setUp(await aBusiness('dutch'), { bankCountry: 'US' });
    expect(us.json()).toMatchObject({ method: 'stripe', url: expect.stringContaining('connect.stripe.test') });
    const french = await setUp(await aBusiness('french'), {});
    expect(french.json().method).toBe('stripe');
    const countries = [...ctx.gateway.accounts.values()].map((account) => account.country);
    expect(countries).toEqual(expect.arrayContaining(['US', 'FR']));
    expect(countries).not.toContain('SX');
  });
});

describe('staff paying a business its share', () => {
  let ctx: TestContext;
  let owner: Awaited<ReturnType<typeof createSignedInStaff>>;
  let administrator: Awaited<ReturnType<typeof createSignedInStaff>>;

  // A business with one finished, paid rental, gathered into a payout.
  async function aPayout(method: 'stripe' | 'bank_transfer') {
    const { provider, booking } = await seedBooking(ctx.db);
    await ctx.db.update(bookings).set({ status: 'completed', paymentStatus: 'paid' }).where(eq(bookings.id, booking.id));
    await ctx.db.insert(providerPayoutAccounts).values({
      providerId: provider.id,
      method,
      ...(method === 'stripe' ? { stripeAccountId: `acct_ready_${provider.id.slice(0, 8)}`, payoutsEnabled: true, status: 'active' } : {}),
    });
    const payout = await buildPayout(ctx.db, provider.id, { start: '2026-09-01', end: '2026-12-31' });
    return payout!;
  }
  const asStaff = (who: typeof owner, url: string, body: object) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/admin${url}`,
      headers: { cookie: who.cookie, origin: WEB_ORIGIN },
      payload: body,
      remoteAddress: uniqueIp(),
    });
  const code = async (who: typeof owner) => generateOtp({ secret: who.secret });

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await createSignedInStaff(ctx, 'Olivia Owner', 'owner');
    administrator = await createSignedInStaff(ctx, 'Adam Admin', 'administrator');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('sends a payout through Stripe: Owner access, the code, a reason, and on the books', async () => {
    const payout = await aPayout('stripe');
    const reason = 'Weekly payout, checked against the bookings.';

    const notOwner = await asStaff(administrator, `/payouts/${payout.id}/send`, { reason, code: await code(administrator) });
    expect(notOwner.statusCode).toBe(403);
    const wrongCode = await asStaff(owner, `/payouts/${payout.id}/send`, { reason, code: '000000' });
    expect(wrongCode.json().error.code).toBe('wrong_code');

    const sent = await asStaff(owner, `/payouts/${payout.id}/send`, { reason, code: await code(owner) });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: 'paid', method: 'stripe' });
    expect(ctx.gateway.transfers.some((transfer) => transfer.reference === payout.reference)).toBe(true);

    const books = await ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.kind, 'payout'));
    expect(books.some((line) => line.amountCents === payout.amountCents)).toBe(true);
    const audit = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'payout_sent'), eq(auditLog.subjectId, payout.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe(reason);
  });

  it('records a bank transfer for a business Stripe cannot pay, once', async () => {
    const payout = await aPayout('bank_transfer');
    const viaStripe = await asStaff(owner, `/payouts/${payout.id}/send`, { reason: 'Trying Stripe first.', code: await code(owner) });
    expect(viaStripe.json().error.code).toBe('paid_by_bank_transfer');

    const body = { reason: 'Sent from the business account at WIB.', bankReference: 'WIB-2026-1001' };
    const marked = await asStaff(owner, `/payouts/${payout.id}/mark-paid`, { ...body, code: await code(owner) });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ status: 'paid', method: 'bank_transfer', bankReference: 'WIB-2026-1001' });
    const [row] = await ctx.db.select().from(payouts).where(eq(payouts.id, payout.id));
    expect(row!.paidByStaffId).toBe(owner.staffId);

    const twice = await asStaff(owner, `/payouts/${payout.id}/mark-paid`, { ...body, code: await code(owner) });
    expect(twice.json().error.code).toBe('already_paid');
    const audit = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'payout_marked_paid'), eq(auditLog.subjectId, payout.id)));
    expect(audit).toHaveLength(1);
  });
});
