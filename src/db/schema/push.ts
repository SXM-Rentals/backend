// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables behind push notifications — which phones may
// be sent to, what each person has chosen to hear about, and the receipts that
// say whether a phone still wants them.
//
// A PHONE BELONGS TO A SESSION, NOT JUST TO A PERSON. When a session ends —
// signing out, closing the account, a password change — its phones are removed
// here on the server, because the phone may be offline, wiped or stolen and
// cannot be trusted to unregister itself. See services/auth/sessions.ts.

import { boolean, index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, moment, updatedAt } from './columns.js';
import { customers, sessions } from './identity.js';

export const devicePlatform = pgEnum('device_platform', ['ios', 'android']);

// ---- PHONES THAT MAY BE SENT A PUSH ----
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    // The sign-in this phone registered under. Ending it removes the phone.
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Expo's address for the phone: "ExponentPushToken[…]". Unique, because a
    // phone that changes hands moves to its new owner rather than being shared.
    token: text('token').notNull(),
    platform: devicePlatform('platform').notNull(),
    // The language the phone asked in, so a push can one day be written in it.
    language: text('language'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('devices_token_unique').on(t.token), index('devices_customer_idx').on(t.customerId)],
);

// ---- WHAT EACH PERSON WANTS TO HEAR ABOUT ----
// Six switches, matching the six on the app's Settings screen. No row means the
// defaults below: everything on except offers, which nobody gets unless they ask.
export const notificationPreferences = pgTable('notification_preferences', {
  customerId: uuid('customer_id')
    .primaryKey()
    .references(() => customers.id, { onDelete: 'cascade' }),
  bookings: boolean('bookings').notNull().default(true),
  pickupReminders: boolean('pickup_reminders').notNull().default(true),
  returnReminders: boolean('return_reminders').notNull().default(true),
  deposits: boolean('deposits').notNull().default(true),
  messages: boolean('messages').notNull().default(true),
  offers: boolean('offers').notNull().default(false),
  updatedAt: updatedAt(),
});

// ---- RECEIPTS STILL TO CHECK ----
// Expo answers a send with a ticket, and only later with whether the phone
// accepted it. A phone that answers "no longer registered" is removed, so we
// stop sending to an app that has been deleted.
export const pushTickets = pgTable('push_tickets', {
  id: text('id').primaryKey(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  sentAt: moment('sent_at').notNull().defaultNow(),
});
