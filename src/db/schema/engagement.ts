// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables for everything that keeps people in touch —
// conversations between a customer and a rental business, the notifications
// list, the rewards points history, and the log of AI-drafted support replies
// with who approved each one.

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { adminStaff } from './admin.js';
import { bookings } from './bookings.js';
import { createdAt, moment, updatedAt } from './columns.js';
import { callStatus, chatSender, notificationKind, supportInteractionStatus } from './enums.js';
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

// ---- ONE PERSON'S OPTIONS FOR ONE CONVERSATION ----
// Pinned, muted, and marked unread belong to the PERSON, not the conversation:
// when a business pins a conversation the renter's copy does not change, and one
// member of a business muting it does not mute it for the others. "side" says
// which end of the conversation the person is on, so the key is exact even in
// the odd case of somebody renting from their own business.
export const chatThreadSettings = pgTable(
  'chat_thread_settings',
  {
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    side: chatSender('side').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    // No push for new messages. They still arrive and still count as unread.
    muted: boolean('muted').notNull().default(false),
    // "Mark as unread": counts as at least one unread until it is read again.
    // A mark of the person's own rather than un-reading the message itself, so
    // the other side's "read" tick never disappears because of it.
    markedUnread: boolean('marked_unread').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.customerId, t.side] })],
);

// ---- CALLS INSIDE THE APP ----
// Who called whom, in which conversation, and how it went. No audio, and no
// phone number: the call itself is carried by Twilio and never recorded.
export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    // Which side rang, and the person who did.
    callerSide: chatSender('caller_side').notNull(),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    status: callStatus('status').notNull().default('ringing'),
    answeredBy: uuid('answered_by'),
    answeredAt: moment('answered_at'),
    endedAt: moment('ended_at'),
    createdAt: createdAt(),
  },
  (t) => [index('calls_thread_idx').on(t.threadId), index('calls_caller_idx').on(t.callerId, t.createdAt)],
);

// ---- NOTIFICATIONS ----
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    // Which rental this is about, where it is about one. This is also what
    // stops a reminder being sent twice: before sending, we look for one of
    // the same kind already sent about the same booking.
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    sentAt: moment('sent_at').notNull().defaultNow(),
    readAt: moment('read_at'),
    // Deleted by the person. Kept as a mark rather than removed, so a reminder
    // already sent is never sent again just because its notification was cleared.
    deletedAt: moment('deleted_at'),
  },
  (t) => [
    index('notifications_customer_idx').on(t.customerId, t.sentAt),
    index('notifications_booking_kind_idx').on(t.bookingId, t.kind),
  ],
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
