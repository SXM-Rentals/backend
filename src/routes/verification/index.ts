// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The customer's side of identity checks, under
// /api/v1/verification:
//
//   POST /sessions   start a check; answers with the address of Stripe's own page
//   GET  /return     where Stripe sends the person back — hands over to the app
//
// The person photographs their ID and takes a selfie on Stripe's page, and the
// photos go to Stripe, never through the app or this server. The outcome
// arrives later from Stripe itself (routes/webhooks), and the app reads it from
// the customer's own record — nothing on the phone can approve anybody. See
// services/verification for the rest, including the staff way of checking.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { requireCustomer } from '../../middleware/auth.js';
import { requireFeature } from '../../services/capabilities/index.js';
import type { VerificationService } from '../../services/verification/index.js';

export type VerificationRouteOptions = { config: Config; verification: VerificationService };

export default async function verificationRoutes(app: FastifyInstance, options: VerificationRouteOptions) {
  app.post('/sessions', async (request) => {
    requireFeature(options.config, 'identity');
    const actor = requireCustomer(request);
    // Stripe only sends people to https addresses, so it sends them to the one
    // below, which hands over to the app.
    const returnUrl = `${request.protocol}://${request.host}/api/v1/verification/return`;
    return options.verification.startSession(actor, returnUrl);
  });

  // Fixed destination, never taken from the request, so it cannot be used to
  // send anybody anywhere else.
  app.get('/return', async (_request, reply) => reply.redirect('sxmrentals://verify-status', 302));
}
