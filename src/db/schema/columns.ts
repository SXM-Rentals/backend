// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Small reusable column recipes shared by every table —
// "when was this created", "when was it last changed", and a timestamp that
// always records the time zone. Using the same recipe everywhere means every
// table records time the same way.

import { timestamp } from 'drizzle-orm/pg-core';

// A moment in time, always stored with its time zone so the Dutch side, the
// French side and a visiting tourist's phone all agree on when something happened.
export const moment = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// When the row was first saved. Filled in by the database automatically.
export const createdAt = () => moment('created_at').notNull().defaultNow();

// When the row was last changed. Refreshed automatically on every update.
export const updatedAt = () =>
  moment('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
