// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for security deposits, under
// /api/v1/deposits.
//
//   POST /deposits/bookings/:id/authorize  place the hold on the customer's card
//   GET  /deposits/bookings/:id            what is being held, and its state
//
// A deposit is HELD, not charged: it is set aside on the card and stays the
// customer's money. It is never counted as revenue, never commissioned and
// never part of what a business is paid.
//
// Releasing or keeping a deposit is a staff decision, never a customer's or a
// business's, so those live in the admin routes instead — behind the staff
// sign-in, and recorded in the audit log with the reason given.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import type { PaymentService } from '../../services/payments/index.js';

export type DepositRouteOptions = { payments: PaymentService };

const idParam = z.object({ id: z.string().max(64) });

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

}
