// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables behind a customer's own account features —
// the cars they have saved, and their conversation with SXM Rentals staff.
//
// Both belong to one person, and nobody else ever reads them: another customer's
// saved cars or messages are "not found", like everything else here.

import { boolean, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { adminStaff } from './admin.js';
import { bookings } from './bookings.js';
import { createdAt, moment } from './columns.js';
import { customers } from './identity.js';
import { vehicles } from './vehicles.js';

// ---- CARS A CUSTOMER HAS SAVED ----
// Kept on the account, so they follow the person to a new phone. A car taken
// off the platform may stay in the list; the app shows it as no longer listed.
export const savedCars = pgTable(
  'saved_cars',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    savedAt: createdAt(),
  },
  // Saving the same car twice is the same as saving it once.
  (t) => [primaryKey({ columns: [t.customerId, t.vehicleId] })],
);

// ---- A CUSTOMER'S CONVERSATION WITH SXM RENTALS STAFF ----
// One running conversation per customer, answered from the admin panel.
export const supportMessages = pgTable(
  'support_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    // False: the customer wrote it. True: staff did, and staffId says who.
    fromStaff: boolean('from_staff').notNull(),
    staffId: uuid('staff_id').references(() => adminStaff.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    // The rental it is about, if they said — only ever one of their own.
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    sentAt: moment('sent_at').notNull().defaultNow(),
  },
  (t) => [index('support_messages_customer_idx').on(t.customerId)],
);
