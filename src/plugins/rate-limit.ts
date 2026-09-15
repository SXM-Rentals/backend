// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Limits how often any one address can call the API, to
// blunt password guessing, sign-up spam and simple flooding. Every route gets a
// generous general limit; the sign-in and account routes get much tighter ones
// (listed in AUTH_LIMITS below). Going over the limit gets a "429 Too Many
// Requests" with a Retry-After header saying how many seconds to wait, which
// the apps can show as a countdown.
//
// The counts are kept in the shared database (the rate_limits table), not in
// the server's memory, so the limit still holds when several copies of the
// backend are running — otherwise each copy would hand out its own allowance.

import rateLimit from '@fastify/rate-limit';
import { lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db/client.js';
import { rateLimits } from '../db/schema/index.js';
import { tooManyRequests } from '../lib/errors.js';

// ---- THE TIGHT LIMITS FOR ACCOUNT ROUTES ----
// Each is per visitor address. Each has its own name in the key so hitting one
// limit never uses up another.
function limit(name: string, max: number, timeWindow: string) {
  return { max, timeWindow, keyGenerator: (request: FastifyRequest) => `${name}:${request.ip}` };
}

export const AUTH_LIMITS = {
  signup: limit('auth-signup', 5, '10 minutes'),
  login: limit('auth-login', 10, '1 minute'),
  emailLink: limit('auth-email-link', 5, '15 minutes'),
  useLink: limit('auth-use-link', 10, '15 minutes'),
  passwordChange: limit('auth-password-change', 10, '15 minutes'),
};

// ---- THE SHARED COUNTER ----
type IncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

function createDatabaseStore(db: Database) {
  return class DatabaseRateLimitStore {
    // Adds one to the count for `key`, starting a fresh window if the old one
    // ran out, and reports the new count and milliseconds left in the window.
    incr(key: string, callback: IncrCallback, timeWindow: number): void {
      db.insert(rateLimits)
        .values({ key, count: 1, resetsAt: sql`now() + make_interval(secs => ${timeWindow / 1000})` })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: {
            count: sql`case when ${rateLimits.resetsAt} <= now() then 1 else ${rateLimits.count} + 1 end`,
            resetsAt: sql`case when ${rateLimits.resetsAt} <= now() then excluded.resets_at else ${rateLimits.resetsAt} end`,
          },
        })
        .returning({
          count: rateLimits.count,
          msLeft: sql<number>`greatest(0, floor(extract(epoch from (${rateLimits.resetsAt} - now())) * 1000))::int`,
        })
        .then(
          ([row]) => callback(null, { current: row?.count ?? 1, ttl: Number(row?.msLeft ?? timeWindow) }),
          (error: Error) => callback(error),
        );

      // Now and then, clear out counters whose windows ended long ago.
      if (Math.random() < 0.01) {
        db.delete(rateLimits)
          .where(lt(rateLimits.resetsAt, sql`now() - interval '1 hour'`))
          .catch(() => undefined);
      }
    }

    // Route-specific limits share the same table; their keys already carry
    // the limit's name (see `limit` above), so no extra prefix is needed.
    child(): DatabaseRateLimitStore {
      return new DatabaseRateLimitStore();
    }
  };
}

// ---- SWITCHING IT ON ----
export async function registerRateLimit(app: FastifyInstance, db: Database): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => `global:${request.ip}`,
    store: createDatabaseStore(db),
    // If the counter itself is unavailable, fail closed: refuse rather than
    // let unlimited guessing through.
    skipOnError: false,
    errorResponseBuilder: (_request, context) => tooManyRequests(Math.max(1, Math.ceil(context.ttl / 1000))),
  });
}
