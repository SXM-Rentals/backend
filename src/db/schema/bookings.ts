// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables for bookings and every kind of money that
// moves around them — the booking and its price lines, the security deposit,
// payouts to businesses, the payment ledger, refund requests, disputes and
// promo codes — plus the reviews left after a rental. All amounts are whole
// cents.
//
// TWO PRODUCT RULES ARE BUILT INTO THE TABLES THEMSELVES:
//
// 1. A security deposit is never revenue. It lives in its own `deposits` table
//    with its own life cycle (not taken → held → released or claimed). The
//    `bookings` table has no deposit column at all, so a deposit cannot be
//    summed into a booking total, a commission or a payout by accident.
//
// 2. The money always adds up. The database refuses any booking or payout
//    where what the customer paid is not exactly the business's share plus
//    the SXM Rentals commission. Removing those checks would let the three
//    figures a business sees quietly disagree.

import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { adminStaff } from './admin.js';
import { createdAt, moment, updatedAt } from './columns.js';
import {
  bookingStatus,
  collectionMethod,
  depositStatus,
  disputeOpenedBy,
  disputeStatus,
  ledgerKind,
  ledgerStatus,
  paymentStatus,
  payoutStatus,
  promoAudience,
  promoKind,
  promoStatus,
  refundStatus,
} from './enums.js';
import { customers } from './identity.js';
import { providers } from './providers.js';
import { vehicles } from './vehicles.js';

// ---- PROMO CODES ----
// `value` is a percentage (1–100) for "percent" codes, or cents for "fixed".
export const promoCodes = pgTable(
  'promo_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    description: text('description').notNull().default(''),
    kind: promoKind('kind').notNull(),
    value: integer('value').notNull(),
    startsAt: moment('starts_at').notNull(),
    endsAt: moment('ends_at').notNull(),
    status: promoStatus('status').notNull().default('scheduled'),
    usageLimit: integer('usage_limit'),
    usedCount: integer('used_count').notNull().default(0),
    appliesTo: promoAudience('applies_to').notNull().default('all'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('promo_codes_code_unique').on(t.code),
    check('promo_codes_dates', sql`${t.endsAt} > ${t.startsAt}`),
    check('promo_codes_value_positive', sql`${t.value} > 0`),
    check('promo_codes_percent_range', sql`${t.kind} <> 'percent' or ${t.value} <= 100`),
  ],
);

// ---- THE BOOKING ----
export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The short code shown to the customer, e.g. SXM-4821.
    reference: text('reference').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'restrict' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    status: bookingStatus('status').notNull().default('upcoming'),

    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    pickupTime: text('pickup_time').notNull(),
    returnTime: text('return_time').notNull(),
    collection: collectionMethod('collection').notNull(),
    location: text('location').notNull(),

    // The rental money, split three ways. Deposits are NOT here — see above.
    grossCents: integer('gross_cents').notNull(),
    commissionCents: integer('commission_cents').notNull(),
    payoutCents: integer('payout_cents').notNull(),
    totalDueTodayCents: integer('total_due_today_cents').notNull(),
    paymentStatus: paymentStatus('payment_status').notNull().default('authorized'),
    // Stripe's own reference for the rental payment. The deposit has its own,
    // separate one on the deposits table — the two are never the same charge.
    stripePaymentIntentId: text('stripe_payment_intent_id'),

    promoCodeId: uuid('promo_code_id').references(() => promoCodes.id, { onDelete: 'set null' }),
    agreementSignedAt: moment('agreement_signed_at'),
    cancelledAt: moment('cancelled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bookings_reference_unique').on(t.reference),
    uniqueIndex('bookings_payment_intent_unique').on(t.stripePaymentIntentId),
    index('bookings_customer_idx').on(t.customerId),
    index('bookings_provider_idx').on(t.providerId),
    index('bookings_vehicle_dates_idx').on(t.vehicleId, t.startDate, t.endDate),
    check('bookings_money_adds_up', sql`${t.grossCents} = ${t.payoutCents} + ${t.commissionCents}`),
    check(
      'bookings_money_not_negative',
      sql`${t.grossCents} >= 0 and ${t.commissionCents} >= 0 and ${t.payoutCents} >= 0 and ${t.totalDueTodayCents} >= 0`,
    ),
    check('bookings_dates_in_order', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

// ---- REVIEWS ----
// One review per booking, rated 1 to 5. Tied to a real booking so only people
// who actually rented the car can review it.
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    body: text('body').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reviews_booking_unique').on(t.bookingId),
    index('reviews_vehicle_idx').on(t.vehicleId),
    check('reviews_rating_range', sql`${t.rating} between 1 and 5`),
  ],
);

// ---- PRICE LINES ----
// Rental subtotal, fees, add-ons — the lines on the customer's price breakdown.
export const bookingPriceLines = pgTable(
  'booking_price_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    amountCents: integer('amount_cents').notNull(),
    note: text('note'),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('booking_price_lines_booking_idx').on(t.bookingId)],
);

// ---- SECURITY DEPOSITS ----
// The customer's money, held against damage and given back. One per booking.
// Keeping a deposit ("claimed") without a written reason is refused.
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    status: depositStatus('status').notNull().default('not_taken'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    authorizedAt: moment('authorized_at'),
    releasedAt: moment('released_at'),
    claimedAt: moment('claimed_at'),
    claimReason: text('claim_reason'),
    // How much of the deposit was actually kept. A claim can be for part of it;
    // whatever is not claimed goes back to the customer.
    claimedAmountCents: integer('claimed_amount_cents'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('deposits_booking_unique').on(t.bookingId),
    uniqueIndex('deposits_payment_intent_unique').on(t.stripePaymentIntentId),
    check('deposits_amount_positive', sql`${t.amountCents} > 0`),
    check(
      'deposits_claim_within_amount',
      sql`${t.claimedAmountCents} is null or (${t.claimedAmountCents} > 0 and ${t.claimedAmountCents} <= ${t.amountCents})`,
    ),
    check('deposits_claim_needs_reason', sql`${t.status} <> 'claimed' or length(trim(coalesce(${t.claimReason}, ''))) > 0`),
  ],
);

// ---- PAYOUTS TO BUSINESSES ----
// Rental money only, and only the business's share. Never deposits.
export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    grossCents: integer('gross_cents').notNull(),
    commissionCents: integer('commission_cents').notNull(),
    bookingCount: integer('booking_count').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    paidOn: moment('paid_on'),
    status: payoutStatus('status').notNull().default('pending'),
    stripeTransferId: text('stripe_transfer_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payouts_reference_unique').on(t.reference),
    index('payouts_provider_idx').on(t.providerId),
    check('payouts_money_adds_up', sql`${t.grossCents} = ${t.amountCents} + ${t.commissionCents}`),
  ],
);

// ---- THE PAYMENT LEDGER ----
// Every charge, refund, payout and commission line, as Stripe reported it.
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'restrict' }),
    kind: ledgerKind('kind').notNull(),
    amountCents: integer('amount_cents').notNull(),
    status: ledgerStatus('status').notNull(),
    stripeRef: text('stripe_ref').notNull(),
    occurredAt: moment('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_entries_booking_idx').on(t.bookingId), index('ledger_entries_occurred_idx').on(t.occurredAt)],
);

// ---- REFUND REQUESTS ----
// A decision (approved or denied) always records who decided and why.
export const refundRequests = pgTable(
  'refund_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    reasonGiven: text('reason_given').notNull(),
    status: refundStatus('status').notNull().default('pending'),
    decidedByStaffId: uuid('decided_by_staff_id').references(() => adminStaff.id, { onDelete: 'restrict' }),
    decidedAt: moment('decided_at'),
    decisionReason: text('decision_reason'),
    requestedAt: moment('requested_at').notNull().defaultNow(),
  },
  (t) => [
    index('refund_requests_booking_idx').on(t.bookingId),
    check('refund_requests_amount_positive', sql`${t.amountCents} > 0`),
    check(
      'refund_requests_decision_recorded',
      sql`${t.status} = 'pending' or (${t.decidedByStaffId} is not null and ${t.decisionReason} is not null)`,
    ),
  ],
);

// ---- DISPUTES ----
export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    openedBy: disputeOpenedBy('opened_by').notNull(),
    subject: text('subject').notNull(),
    detail: text('detail').notNull(),
    amountAtStakeCents: integer('amount_at_stake_cents').notNull().default(0),
    status: disputeStatus('status').notNull().default('open'),
    assignedToStaffId: uuid('assigned_to_staff_id').references(() => adminStaff.id, { onDelete: 'set null' }),
    resolutionNotes: text('resolution_notes'),
    resolvedAt: moment('resolved_at'),
    openedAt: moment('opened_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('disputes_reference_unique').on(t.reference), index('disputes_booking_idx').on(t.bookingId)],
);
