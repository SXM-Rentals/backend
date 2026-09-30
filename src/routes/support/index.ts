// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: A customer's conversation with SXM Rentals staff, under
// /api/v1/support — the app's Help & support:
//
//   GET  /conversation   the whole conversation
//   POST /messages       say something, optionally about one of your rentals
//
// Answered by staff from the admin panel (/admin/support). One running
// conversation per customer. Only while the owner has switched support on.
//
// (The AI email assistant the Developer Guide describes is a separate thing,
// not built; this is people talking to people.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import { requireFeature } from '../../services/capabilities/index.js';
import type { SupportService } from '../../services/support/index.js';

export type SupportRouteOptions = { config: Config; support: SupportService };

const messageBody = z.object({
  body: z.string().trim().min(1).max(4000),
  bookingId: z.string().max(64).optional(),
});

export default async function supportRoutes(app: FastifyInstance, options: SupportRouteOptions) {
  app.get('/conversation', async (request) => {
    requireFeature(options.config, 'support');
    return options.support.conversationFor(requireCustomer(request));
  });

  app.post('/messages', async (request, reply) => {
    requireFeature(options.config, 'support');
    const actor = requireCustomer(request);
    const conversation = await options.support.send(actor, parseInput(messageBody, request.body));
    return reply.status(201).send(conversation);
  });
}
