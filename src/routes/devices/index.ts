// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Registering a phone for push notifications, under
// /api/v1/devices:
//
//   POST   /           register this phone (or move it to this sign-in)
//   DELETE /current    stop sending to this phone
//
// A phone belongs to the sign-in it registered under, and ending that sign-in
// removes it on the server — the phone is not trusted to unregister itself,
// because it may be offline, wiped or stolen. Only live while the owner has
// switched push on.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import { requireFeature } from '../../services/capabilities/index.js';
import type { PushService } from '../../services/push/index.js';

export type DeviceRouteOptions = { config: Config; push: PushService };

// Only Expo's own push addresses. Anything else is refused rather than stored
// and sent to — it could be anybody's address for anything.
const expoToken = z
  .string()
  .max(200)
  .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/, 'That is not an Expo push address.');

const registerBody = z.object({
  token: expoToken,
  platform: z.enum(['ios', 'android']),
  language: z.string().max(35).optional(),
});
const unregisterBody = z.object({ token: expoToken });

export default async function deviceRoutes(app: FastifyInstance, options: DeviceRouteOptions) {
  app.post('/', async (request, reply) => {
    requireFeature(options.config, 'push');
    const actor = requireCustomer(request);
    const body = parseInput(registerBody, request.body);
    // The language the app asks in, so a push can one day be written in it.
    const language = body.language ?? request.headers['accept-language']?.split(',')[0]?.trim();
    await options.push.registerDevice(actor, { ...body, language: language || undefined });
    return reply.status(204).send();
  });

  app.delete('/current', async (request, reply) => {
    requireFeature(options.config, 'push');
    const actor = requireCustomer(request);
    const { token } = parseInput(unregisterBody, request.body);
    await options.push.unregisterDevice(actor, token);
    return reply.status(204).send();
  });
}
