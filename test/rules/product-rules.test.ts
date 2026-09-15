// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Stands guard over the three product rules shared by every
// SXM Rentals app. If one of these tests fails, a real rule has been broken —
// do not "fix" the test.
//
// 1. A security deposit is never revenue.
// 2. A rental business never sees a customer's phone number or email.
// 3. Every figure shown to a business is its own share, with gross, commission
//    and net shown together — and the three always add up.

import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookingPriceLines, bookings, deposits, payouts } from '../../src/db/schema/index.js';
import { toCustomerBooking, toProviderBooking } from '../../src/services/serializers/bookings.js';
import { createTestContext, seedBooking, type TestContext } from '../helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

// Postgres refused the write because of a named rule (check constraint).
const violates = (constraint: string) => expect.objectContaining({ cause: expect.objectContaining({ constraint }) });

describe('rule 1: a security deposit is never revenue', () => {
  it('has no deposit column anywhere on a booking, so it cannot be summed into one', () => {
    const columns = Object.values(getTableColumns(bookings)).map((column) => column.name);
    expect(columns.filter((name) => /deposit/i.test(name))).toEqual([]);
  });

  it("keeps the deposit out of the customer's total and price lines", async () => {
    const { booking } = await seedBooking(ctx.db);
    const lines = await ctx.db
      .insert(bookingPriceLines)
      .values([
        { bookingId: booking.id, label: '3 days × $65', amountCents: 19500, position: 0 },
      ])
      .returning();
    const [deposit] = await ctx.db
      .insert(deposits)
      .values({ bookingId: booking.id, amountCents: 50000, status: 'held' })
      .returning();

    const view = toCustomerBooking(booking, lines, deposit);
    expect(view.totalDueToday).toBe(195);
    expect(view.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(195);
    expect(view.lines.some((line) => /deposit/i.test(line.label))).toBe(false);
    expect(view.depositAmount).toBe(500);
    expect(view.depositStatus).toBe('held');
  });

  it("keeps the deposit out of a business's gross, commission and net", async () => {
    const { booking, customer } = await seedBooking(ctx.db);
    const [deposit] = await ctx.db
      .insert(deposits)
      .values({ bookingId: booking.id, amountCents: 50000, status: 'held' })
      .returning();
    const view = toProviderBooking(booking, deposit, customer);
    expect(view.grossAmount).toBe(195);
    expect(view.commission + view.netAmount).toBe(view.grossAmount);
  });

  it('refuses to record a kept (claimed) deposit without a written reason', async () => {
    const { booking } = await seedBooking(ctx.db);
    await expect(
      ctx.db.insert(deposits).values({ bookingId: booking.id, amountCents: 50000, status: 'claimed' }),
    ).rejects.toEqual(violates('deposits_claim_needs_reason'));
  });
});

describe("rule 2: a rental business never sees a customer's contact details", () => {
  it('leaves out phone and email even when handed the whole customer record', async () => {
    const { booking, customer } = await seedBooking(ctx.db);
    expect(customer.email).toBeTruthy();
    expect(customer.phone).toBeTruthy();

    // Passing the full row is exactly the mistake this rule has to survive.
    const view = toProviderBooking(booking, undefined, customer);
    const json = JSON.stringify(view);

    expect(json).not.toContain(customer.email);
    expect(json).not.toContain(customer.phone!);
    expect(json).not.toContain(customer.lastName);
    expect(Object.keys(view).sort()).toEqual(
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
    expect(view.renterDisplayName).toBe('Benjamin J.');
    expect(view.renterVerified).toBe(true);
  });
});

describe("rule 3: a business always sees its own share, and the money adds up", () => {
  it('always returns gross, commission and net together', async () => {
    const { booking, customer } = await seedBooking(ctx.db);
    const view = toProviderBooking(booking, undefined, customer);
    expect(view).toMatchObject({ grossAmount: 195, commission: 58.5, netAmount: 136.5 });
  });

  it('refuses a booking whose share and commission do not add up to what the customer paid', async () => {
    const { booking } = await seedBooking(ctx.db);
    await expect(
      ctx.db
        .insert(bookings)
        .values({ ...booking, id: undefined, reference: 'SXM-BAD-1', grossCents: 20000, commissionCents: 5850, payoutCents: 13650 }),
    ).rejects.toEqual(violates('bookings_money_adds_up'));
  });

  it('refuses a payout whose amount and commission do not add up to its gross', async () => {
    const { provider } = await seedBooking(ctx.db);
    await expect(
      ctx.db.insert(payouts).values({
        reference: 'PO-BAD-1',
        providerId: provider.id,
        amountCents: 10000,
        grossCents: 15000,
        commissionCents: 3000,
        bookingCount: 1,
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      }),
    ).rejects.toEqual(violates('payouts_money_adds_up'));
  });
});
