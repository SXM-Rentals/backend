// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for paying for a rental, under
// /api/v1/payments.
//
//   POST /payments/bookings/:id/intent   start (or resume) paying for a booking
//
//   GET    /payments/methods              the customer's saved cards
//   POST   /payments/methods/setup        a secret for saving a new one
//   DELETE /payments/methods/:id          forget one
//   POST   /payments/methods/:id/default  make one the default
//
// Saved cards live at Stripe. The app is told the brand, the last four digits
// and the expiry, and never more; a card is saved through Stripe's own form, in
// "save" mode, with the setup secret. They are only offered while the owner has
// switched paymentMethods on — see services/capabilities.
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
import type { Config } from '../../config.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import { requireFeature } from '../../services/capabilities/index.js';
import type { PaymentService } from '../../services/payments/index.js';
import type { DateChangeService } from '../../services/date-changes/index.js';

export type PaymentRouteOptions = { payments: PaymentService; config: Config; dateChanges: DateChangeService };
const dateChangeParams = z.object({ id: z.string().max(64), requestId: z.string().max(64) });

const idParam = z.object({ id: z.string().max(64) });
const intentBody = z.object({ saveCardForDeposit: z.boolean().optional() });

export default async function paymentRoutes(app: FastifyInstance, options: PaymentRouteOptions) {
  // saveCardForDeposit: true only once the customer has been shown, beside the
  // pay button, that the card will also be used for the deposit hold. Left out,
  // the payment is exactly as it always was.
  app.post('/bookings/:id/intent', async (request) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    const { saveCardForDeposit } = parseInput(intentBody, request.body ?? {});
    const payment = await options.payments.startRentalPayment(actor, id, { saveCardForDeposit });
    return {
      clientSecret: payment.clientSecret,
      amount: payment.amount,
      status: payment.status,
      // The deposit beside it: its amount, whether this payment saves the card
      // for it, and when it will be held. Null when there is no deposit.
      deposit: payment.deposit,
    };
  });

  // Paying the difference when a rental's new dates cost more.
  app.post('/bookings/:id/date-changes/:requestId/intent', async (request) => {
    const actor = requireCustomer(request);
    const { id, requestId } = parseInput(dateChangeParams, request.params);
    return options.dateChanges.startPayment(actor, id, requestId);
  });

  // ---- SAVED CARDS ----
  app.get('/methods', async (request) => {
    requireFeature(options.config, 'paymentMethods');
    return options.payments.listCards(requireCustomer(request));
  });

  app.post('/methods/setup', async (request) => {
    requireFeature(options.config, 'paymentMethods');
    return options.payments.startCardSetup(requireCustomer(request));
  });

  app.delete('/methods/:id', async (request, reply) => {
    requireFeature(options.config, 'paymentMethods');
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    await options.payments.removeCard(actor, id);
    return reply.status(204).send();
  });

  app.post('/methods/:id/default', async (request) => {
    requireFeature(options.config, 'paymentMethods');
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    return options.payments.makeDefaultCard(actor, id);
  });
}
