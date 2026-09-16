// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for a customer's notifications, under
// /api/v1/notifications.
//
//   GET  /notifications           your notifications, newest first
//   POST /notifications/:id/read  mark one as read
//   POST /notifications/read-all  mark every one as read
//
// You only ever see your own: the list is tied to whoever is signed in, and
// somebody else's notification is "not found", exactly like one that does not
// exist.
//
// Notifications are created by the backend itself when something happens — a
// booking is made, a payment arrives, a deposit is released — never by an app
// asking for one to be made. There is deliberately no address for that.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import type { NotificationService } from '../../services/notifications/index.js';

export type NotificationRouteOptions = { notifications: NotificationService };

const idParam = z.object({ id: z.string().max(64) });

export default async function notificationRoutes(app: FastifyInstance, options: NotificationRouteOptions) {
  const { notifications } = options;

  app.get('/', async (request) => notifications.listFor(requireCustomer(request)));

  app.post('/:id/read', async (request, reply) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    await notifications.markRead(actor, id);
    return reply.status(204).send();
  });

  app.post('/read-all', async (request, reply) => {
    await notifications.markAllRead(requireCustomer(request));
    return reply.status(204).send();
  });
}
