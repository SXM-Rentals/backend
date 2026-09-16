// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Receives the messages other services send us when
// something happens on their side, under /api/v1/webhooks.
//
//   POST /webhooks/stripe   a payment succeeded, failed, was held or refunded
//
// Anyone on the internet can send a request to this address, so NOTHING here is
// believed until its signature has been checked against our Stripe signing
// secret. An unsigned or altered message is refused. Without that check, a
// stranger could simply announce that a booking had been paid for.
//
// The signature is worked out over the EXACT bytes Stripe sent, so this route
// keeps the raw body rather than letting it be tidied into an object first.
// That parser is set inside this file's own scope, so it changes nothing about
// how the rest of the API reads requests.
//
// Stripe resends a message if it is not sure we received it. Each one is
// recorded after it is dealt with, and a repeat is quietly ignored.
//
// Slack and inbound support email arrive here too, in Phase 8.

import type { FastifyInstance } from 'fastify';
import type { PaymentGateway } from '../../lib/stripe.js';
import type { PaymentService } from '../../services/payments/index.js';

export type WebhookRouteOptions = { payments: PaymentService; gateway: PaymentGateway };

export default async function webhookRoutes(app: FastifyInstance, options: WebhookRouteOptions) {
  const { payments, gateway } = options;

  // Keep the body exactly as it arrived — the signature covers those bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/stripe', async (request, reply) => {
    const event = gateway.verifyWebhook(request.body as Buffer, request.headers['stripe-signature'] as string);
    const result = await payments.handleStripeEvent(event);

    // Answering 200 tells Stripe not to send it again. A message we refused to
    // verify never gets this far.
    return reply.status(200).send({ received: true, handled: result.handled });
  });
}
