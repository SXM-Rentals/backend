// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for paying for a rental, under
// /api/v1/payments.
//
//   POST /payments/bookings/:id/intent   start (or resume) paying for a booking
//
// The response contains a one-time "client secret". The app hands that to
// Stripe's own card form, so the card number goes straight from the customer's
// device to Stripe and never passes through this server — which is what keeps
// SXM Rentals out of the strictest card-handling rules.
//
// Being handed a client secret does NOT mean the booking is paid. Only Stripe
// telling us afterwards does that; see routes/webhooks.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import type { PaymentService } from '../../services/payments/index.js';

export type PaymentRouteOptions = { payments: PaymentService };

const idParam = z.object({ id: z.string().max(64) });

export default async function paymentRoutes(app: FastifyInstance, options: PaymentRouteOptions) {
  app.post('/bookings/:id/intent', async (request) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    const payment = await options.payments.startRentalPayment(actor, id);
    return {
      clientSecret: payment.clientSecret,
      amount: payment.amount,
      status: payment.status,
    };
  });
}
