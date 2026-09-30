// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The table behind changing a rental's dates — keeping the
// car longer, bringing it back early, or moving a rental that has not started.
//
// A change is a REQUEST: the renter asks, SXM Rentals prices it, the business
// accepts or declines, and only an accepted request changes the booking. The
// price is fixed at the moment of asking, so what the business accepts is exactly
// what the renter was shown.

import { index, integer, jsonb, pgEnum, pgTable, text, date, uuid } from 'drizzle-orm/pg-core';
import { bookings } from './bookings.js';
import { createdAt, moment } from './columns.js';

export const dateChangeStatus = pgEnum('date_change_status', ['pending', 'accepted', 'declined', 'withdrawn', 'expired']);
// Only for a change that costs more: whether the extra has been paid.
export const dateChangePaymentStatus = pgEnum('date_change_payment_status', ['unpaid', 'paid']);

export const dateChangeRequests = pgTable(
  'date_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),

    // What was asked for, and what the booking had at the time — so both sides
    // can see what changed, even after the booking has moved on.
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    fromStartDate: date('from_start_date').notNull(),
    fromEndDate: date('from_end_date').notNull(),
    days: integer('days').notNull(),
    fromDays: integer('from_days').notNull(),

    // The whole rental at the new dates, and how it compares with now. Cents.
    totalCents: integer('total_cents').notNull(),
    differenceCents: integer('difference_cents').notNull(),
    // How much of a lower price actually comes back, under the policy.
    refundCents: integer('refund_cents').notNull().default(0),
    // What the renter ends up paying for the booking if it is accepted, split
    // the way every figure shown to a business is: gross, commission, net.
    grossCents: integer('gross_cents').notNull(),
    commissionCents: integer('commission_cents').notNull(),
    payoutCents: integer('payout_cents').notNull(),
    // The price lines at the new dates, applied to the booking on acceptance.
    lines: jsonb('lines').$type<{ label: string; amountCents: number }[]>().notNull(),
    explanation: text('explanation'),

    status: dateChangeStatus('status').notNull().default('pending'),
    // The business's own words when it declines, shown to the renter as written.
    note: text('note'),
    paymentStatus: dateChangePaymentStatus('payment_status'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    requestedAt: createdAt(),
    decidedAt: moment('decided_at'),
  },
  (t) => [index('date_change_requests_booking_idx').on(t.bookingId)],
);
