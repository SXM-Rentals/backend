// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Decides which websites a browser will let call this API.
// Only the addresses listed in CORS_ORIGINS (our own website and admin panel)
// are allowed; a browser on any other site is refused. There is never a
// "any website" wildcard, because this API uses sign-in cookies and a wildcard
// would let any website act as a signed-in customer.
//
// The phone app is not a browser, so this does not apply to it.

import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

export async function registerCors(app: FastifyInstance, config: Config): Promise<void> {
  const allowed = new Set(config.corsOrigins);

  await app.register(cors, {
    // No Origin header means it is not a cross-site browser request.
    origin: (origin, callback) => callback(null, origin === undefined || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization'],
    maxAge: 600,
  });
}
