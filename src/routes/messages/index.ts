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
//
// Talking to a business happens here, inside SXM Rentals, rather than by phone
// or email — which is what lets a business answer without ever being given a
// customer's contact details.
//
// You only ever see your own conversations: somebody else's is "not found",
// exactly like one that does not exist.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import {
  getThreadForCustomer,
  listThreadsForCustomer,
  markReadAsCustomer,
  replyAsCustomer,
  startThread,
} from '../../services/messaging/index.js';

export type MessageRouteOptions = { db: Database };

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
    return reply.status(201).send(thread);
  });

  app.post('/threads/:id/messages', async (request, reply) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(messageBody, request.body);
    const thread = await replyAsCustomer(db, actor, id, body);
    return reply.status(201).send(thread);
  });

  app.post('/threads/:id/read', async (request, reply) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    await markReadAsCustomer(db, actor, id);
    return reply.status(204).send();
  });
}
