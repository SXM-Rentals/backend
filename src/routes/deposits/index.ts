// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for security deposits, under
// /api/v1/deposits.
//
//   POST /deposits/bookings/:id/authorize  place the hold on the customer's card
//   GET  /deposits/bookings/:id            what is being held, and its state
//   POST /deposits/:id/release             give it back          (staff only)
//   POST /deposits/:id/claim               keep part of it       (staff only)
//
// A deposit is HELD, not charged: it is set aside on the card and stays the
// customer's money. It is never counted as revenue, never commissioned and
// never part of what a business is paid.
//
// Releasing or keeping a deposit is a staff decision, never a customer's or a
// business's — so those two sit behind the staff check. Staff sign-in arrives
// in Phase 6, and until then that check refuses everybody, which is the safe
// way round: the endpoints exist and are locked rather than being added in a
// hurry later.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validate.js';
import { requireAdmin, requireCustomer } from '../../middleware/auth.js';
import type { PaymentService } from '../../services/payments/index.js';

export type DepositRouteOptions = { payments: PaymentService };

const idParam = z.object({ id: z.string().max(64) });

// Keeping any part of a deposit always needs a written reason. It is the most
// disputable thing the platform can do, so the shape makes it impossible to
// leave out.
const claimBody = z.object({
  reason: z.string().trim().min(10, 'Please write a reason of at least 10 characters.').max(1000),
  amount: z.number().positive().max(100_000),
});

export default async function depositRoutes(app: FastifyInstance, options: DepositRouteOptions) {
  const { payments } = options;

  // ---- THE CUSTOMER'S SIDE ----
  app.post('/bookings/:id/authorize', async (request) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    const hold = await payments.startDepositHold(actor, id);
    return { clientSecret: hold.clientSecret, amount: hold.amount, status: hold.status };
  });

  app.get('/bookings/:id', async (request) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    return payments.getDepositFor(actor, id);
  });

  // ---- THE STAFF SIDE (locked until staff sign-in exists) ----
  app.post('/:id/release', async (request, reply) => {
    requireAdmin(request);
    const { id } = parseInput(idParam, request.params);
    await payments.releaseDeposit(id);
    return reply.status(204).send();
  });

  app.post('/:id/claim', async (request, reply) => {
    requireAdmin(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(claimBody, request.body);
    await payments.claimDeposit(id, { reason: body.reason, amountCents: Math.round(body.amount * 100) });
    return reply.status(204).send();
  });
}
