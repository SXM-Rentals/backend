// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The table that counts requests for rate limiting ("no
// more than 5 sign-in attempts a minute from one address"). It lives in the
// shared database rather than in each server's memory so the limit still holds
// when the backend is running on several servers at once — otherwise an
// attacker could simply get a fresh allowance from each one.

import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { moment } from './columns.js';

export const rateLimits = pgTable(
  'rate_limits',
  {
    // Which limit and who, e.g. "auth-login:203.0.113.7".
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    resetsAt: moment('resets_at').notNull(),
  },
  (t) => [index('rate_limits_resets_at_idx').on(t.resetsAt)],
);
