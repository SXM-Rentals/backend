// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for a customer's own account, under
// /api/v1/customers:
//
//   GET  /me         the signed-in person's own account, in the `User` shape the
//                    website and phone app already use for the account screens
//   POST /me/close   close that account for good
//
// There is deliberately no "/customers/:id" for customers — a person can only
// ever ask for their own record, so there is no ID to tamper with.
//
// CLOSING ASKS FOR THE PASSWORD AGAIN. It cannot be undone from the website, so
// somebody who finds an unlocked laptop should not be able to do it in two
// clicks. It is rate-limited like the other password routes, so the endpoint
// cannot be used to guess one either.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { clearSessionCookie, requireCustomer } from '../../middleware/auth.js';
import { AUTH_LIMITS } from '../../plugins/rate-limit.js';
import { parseInput } from '../../lib/validate.js';
import { PASSWORD_MAX_LENGTH } from '../../lib/passwords.js';
import type { AuthService } from '../../services/auth/index.js';

export type CustomerRouteOptions = { auth: AuthService; config: Config };

const closeBody = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

export default async function customerRoutes(app: FastifyInstance, options: CustomerRouteOptions) {
  const { auth, config } = options;

  app.get('/me', async (request) => auth.getCurrentUser(requireCustomer(request)));

  app.post('/me/close', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request, reply) => {
    const actor = requireCustomer(request);
    const { password } = parseInput(closeBody, request.body);
    await auth.closeOwnAccount(actor, { password });
    // Every session was ended; take the cookie off this browser too, so the
    // person is visibly signed out rather than seeing errors.
    clearSessionCookie(reply, config);
    return reply.status(204).send();
  });
}
