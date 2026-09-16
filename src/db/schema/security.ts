// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Two small tables the server keeps for its own safety.
//
// `rate_limits` counts requests for rate limiting ("no more than 5 sign-in
// attempts a minute from one address"). It lives in the shared database rather
// than in each server's memory so the limit still holds when the backend is
// running on several servers at once — otherwise an attacker could simply get
// a fresh allowance from each one.
//
// `processed_webhook_events` remembers every Stripe message already dealt with.
// Stripe deliberately sends a message more than once if it is not sure we got
// it, so without this a single payment could be recorded twice, or a deposit
// released twice.

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

// One row per Stripe message handled. The id is Stripe's own event id, so a
// repeat delivery cannot be inserted twice and is simply ignored.
export const processedWebhookEvents = pgTable('processed_webhook_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: moment('received_at').notNull().defaultNow(),
});
