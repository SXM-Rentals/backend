// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The one public address that says which features are
// switched on, under /api/v1/capabilities:
//
//   GET /   { "payments": false, "push": true, … } — only true and false
//
// The phone app asks when it opens and again when it comes back to the front,
// and switches each screen on or off from the answer. See
// services/capabilities/index.ts for what makes a feature true.
//
// No sign-in, and cacheable for five minutes: it is the same answer for
// everybody, and it is asked often.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { capabilities } from '../../services/capabilities/index.js';

export type CapabilityRouteOptions = { config: Config };

export default async function capabilityRoutes(app: FastifyInstance, options: CapabilityRouteOptions) {
  app.get('/', async (_request, reply) => {
    // Every other answer from this API says "do not keep me"; this one is safe
    // to keep, and asked for on every app launch.
    reply.header('cache-control', 'public, max-age=300');
    return capabilities(options.config);
  });
}
