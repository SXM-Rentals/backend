// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Works out who is making each request, before it reaches
// any route. The website proves who it is with a sign-in cookie the browser
// sends automatically; the phone app sends its sign-in code in the
// Authorization header. Either way the code is checked against the database
// (see services/auth/sessions.ts), and the request is marked with the person it
// belongs to — or with nobody.
//
// It also blocks cross-site request forgery: because a browser attaches the
// sign-in cookie to requests even when another website triggers them, any
// cookie-signed request that changes something must come from one of our own
// websites (checked via the Origin header), or it is refused.
//
// Routes then call the "require" helpers at the bottom to say who may use them.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/client.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Actor } from '../lib/ownership.js';
import { authenticateSession } from '../services/auth/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    // The signed-in person, or null.
    actor: Actor | null;
  }
}

// ---- THE COOKIE'S NAME ----
// In production the "__Host-" prefix makes browsers insist the cookie is
// HTTPS-only, sent to this exact host, and not readable by other subdomains.
export function sessionCookieName(config: Config): string {
  return config.isProduction ? '__Host-sxm_session' : 'sxm_session';
}

// "Bearer abc123" → "abc123"
function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerAuth(app: FastifyInstance, deps: { db: Database; config: Config }): void {
  const { db, config } = deps;
  const cookieName = sessionCookieName(config);
  const allowedOrigins = new Set(config.corsOrigins);

  app.decorateRequest('actor', null);

  app.addHook('preHandler', async (request) => {
    const bearerToken = readBearerToken(request.headers.authorization);
    const cookieToken = request.cookies[cookieName];
    const origin = request.headers.origin;

    // ---- FORGED-REQUEST CHECK ----
    if (!READ_ONLY_METHODS.has(request.method)) {
      // A browser on a website that is not ours is trying to change something.
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        throw forbidden('This request came from a website that is not allowed to make it.');
      }
      // A cookie-signed change with no Origin at all cannot be confirmed as ours.
      if (!bearerToken && cookieToken && origin === undefined) {
        throw forbidden('This request could not be confirmed as coming from SXM Rentals.');
      }
    }

    // ---- WHO IS THIS? ----
    if (bearerToken) {
      request.actor = await authenticateSession(db, bearerToken, 'bearer');
    } else if (cookieToken) {
      request.actor = await authenticateSession(db, cookieToken, 'cookie');
    }
  });
}

// ---- WHO MAY USE A ROUTE ----

// Any signed-in customer. Returns who they are.
export function requireCustomer(request: FastifyRequest): Actor {
  if (!request.actor) throw unauthorized();
  return request.actor;
}

// Staff only. The staff sign-in (separate from customers, with mandatory
// two-factor codes) arrives in Phase 2; until then nobody passes this check,
// so an admin route added early cannot be reached by accident.
export function requireAdmin(_request: FastifyRequest): never {
  throw forbidden('Staff access is not available yet.');
}

// Business membership checks live in lib/ownership.ts (assertProviderMember),
// because they need the ID of the business being asked about.
