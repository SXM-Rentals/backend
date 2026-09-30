// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for a customer's conversations with
// rental businesses, under /api/v1/messages.
//
//   GET  /messages/threads              your conversations, most recent first
//   GET  /messages/threads/:id          one conversation
//   POST /messages/threads              start one (or continue an existing one)
//   POST /messages/threads/:id/messages say something else
//   POST /messages/threads/:id/read     mark the business's messages as read
//   PATCH /messages/threads/:id         mark unread, pin, mute — your copy only
//
// Talking to a business happens here, inside SXM Rentals, rather than by phone
// or email — which is what lets a business answer without ever being given a
// customer's contact details.
//
// You only ever see your own conversations: somebody else's is "not found",
// exactly like one that does not exist.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { requireFeature } from '../../services/capabilities/index.js';
import type { PushService } from '../../services/push/index.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import {
  getThreadForCustomer,
  listThreadsForCustomer,
  markReadAsCustomer,
  replyAsCustomer,
  setOptionsAsCustomer,
  startThread,
} from '../../services/messaging/index.js';

export type MessageRouteOptions = { db: Database; push: PushService; config: Config };

// Mark as unread, pin, mute. "unread" can only be switched on: reading the
// conversation is what switches it off.
export const threadOptionsBody = z
  .object({ unread: z.literal(true).optional(), pinned: z.boolean().optional(), muted: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'Say what to change: unread, pinned or muted.');

const idParam = z.object({ id: z.string().max(64) });
// A message is words, a car, or both. The service refuses one that is neither.
const messageBody = z.object({
  body: z.string().trim().max(4000).optional(),
  vehicleId: z.string().max(64).optional(),
});
const startBody = messageBody.extend({
  providerId: z.string().max(64),
  bookingId: z.string().max(64).optional(),
});

export default async function messageRoutes(app: FastifyInstance, options: MessageRouteOptions) {
  const { db } = options;

  app.get('/threads', async (request) => listThreadsForCustomer(db, requireCustomer(request)));

  app.get('/threads/:id', async (request) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    return getThreadForCustomer(db, actor, id);
  });

  app.post('/threads', async (request, reply) => {
    const actor = requireCustomer(request);
    const body = parseInput(startBody, request.body);
    const thread = await startThread(db, actor, body);
    await options.push.messageFromCustomer(thread.id);
    return reply.status(201).send(thread);
  });

  app.post('/threads/:id/messages', async (request, reply) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(messageBody, request.body);
    const thread = await replyAsCustomer(db, actor, id, body);
    await options.push.messageFromCustomer(thread.id);
    return reply.status(201).send(thread);
  });

  app.patch('/threads/:id', async (request) => {
    requireFeature(options.config, 'messageOptions');
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    return setOptionsAsCustomer(db, actor, id, parseInput(threadOptionsBody, request.body));
  });

  app.post('/threads/:id/read', async (request, reply) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    await markReadAsCustomer(db, actor, id);
    return reply.status(204).send();
  });
}
