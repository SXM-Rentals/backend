// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables for everything that keeps people in touch —
// conversations between a customer and a rental business, the notifications
// list, the rewards points history, and the log of AI-drafted support replies
// with who approved each one.

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { adminStaff } from './admin.js';
import { bookings } from './bookings.js';
import { createdAt, moment, updatedAt } from './columns.js';
import { chatSender, notificationKind, supportInteractionStatus } from './enums.js';
import { customers } from './identity.js';
import { providers } from './providers.js';
import { vehicles } from './vehicles.js';

// ---- CONVERSATIONS ----
// One customer and one business talking inside SXM Rentals. The business never
// receives the customer's phone or email through this — see the serializers.
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chat_threads_customer_idx').on(t.customerId), index('chat_threads_provider_idx').on(t.providerId)],
);

// A message is words, an attached car, or both — never neither.
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    sender: chatSender('sender').notNull(),
    body: text('body').notNull().default(''),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
    sentAt: moment('sent_at').notNull().defaultNow(),
    readAt: moment('read_at'),
  },
  (t) => [
    index('chat_messages_thread_idx').on(t.threadId, t.sentAt),
    check('chat_messages_not_empty', sql`length(${t.body}) > 0 or ${t.vehicleId} is not null`),
  ],
);

// ---- NOTIFICATIONS ----
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    sentAt: moment('sent_at').notNull().defaultNow(),
    readAt: moment('read_at'),
  },
  (t) => [index('notifications_customer_idx').on(t.customerId, t.sentAt)],
);

// ---- REWARDS POINTS HISTORY ----
// Points are never a stored balance that can drift: the balance is the sum of
// these rows. A negative row is a spend or a staff correction.
export const rewardLedger = pgTable(
  'reward_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    points: integer('points').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('reward_ledger_customer_idx').on(t.customerId)],
);

// ---- AI SUPPORT DRAFTS ----
// The customer's message, the AI's draft, what was finally sent, and who
// approved it. Nothing is sent without a person approving it first.
export const supportInteractions = pgTable(
  'support_interactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    fromEmail: text('from_email').notNull(),
    subject: text('subject').notNull().default(''),
    customerMessage: text('customer_message').notNull(),
    draft: text('draft'),
    finalSent: text('final_sent'),
    status: supportInteractionStatus('status').notNull().default('drafted'),
    wasEdited: boolean('was_edited').notNull().default(false),
    approvedByStaffId: uuid('approved_by_staff_id').references(() => adminStaff.id, { onDelete: 'set null' }),
    slackMessageTs: text('slack_message_ts'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('support_interactions_customer_idx').on(t.customerId)],
);
