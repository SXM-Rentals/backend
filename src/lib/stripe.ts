// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The only place in the backend that talks to Stripe. It
// describes the handful of things we ask Stripe to do, and provides three ways
// of doing them: the real Stripe, a version that politely refuses because no
// Stripe keys are set yet, and (in the tests) a stand-in.
//
// WHY IT IS SHAPED THIS WAY: the rest of the backend only ever sees the small
// list of actions below, so the payment rules can be tested completely without
// a Stripe account, and swapping or upgrading Stripe touches this file alone.
//
// THE TWO KINDS OF MONEY ARE DELIBERATELY SEPARATE:
//   - the rental is CHARGED: the customer pays, and the money is ours to split.
//   - the deposit is HELD: authorised on the card and never taken, unless a
//     claim is agreed. It is the customer's money throughout.
// Stripe calls the second one a "manual capture" payment. Keeping them as two
// different payments is what makes "a deposit is never revenue" true in the
// payment processor as well as in our own database.
//
// Card details never touch this server: the apps send them straight to Stripe
// using the one-time client secret returned below.

import Stripe from 'stripe';
import { AppError } from './errors.js';

// What Stripe tells us about a payment.
export type PaymentRecord = {
  id: string;
  // Used once by the app to complete the payment on the customer's device.
  clientSecret: string;
  status: string;
};

// A message from Stripe about something that happened.
export type WebhookEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

export type RentalPaymentInput = {
  bookingId: string;
  bookingReference: string;
  amountCents: number;
  customerEmail?: string | undefined;
};

export type DepositHoldInput = {
  bookingId: string;
  bookingReference: string;
  depositId: string;
  amountCents: number;
};

// A rental business's own Stripe account, which is where their share is sent.
// SXM Rentals never holds their money on their behalf: Stripe pays them
// directly, and we only ever ask for the transfer.
export type ConnectedAccount = {
  id: string;
  payoutsEnabled: boolean;
  // What Stripe is still waiting for from the business, in its own words.
  outstanding: string[];
};

// Everything the backend ever asks a payment processor to do.
export type PaymentGateway = {
  // Charge the customer for the rental.
  createRentalPayment(input: RentalPaymentInput): Promise<PaymentRecord>;
  // Place a hold on the card for the deposit. Nothing is taken.
  createDepositHold(input: DepositHoldInput): Promise<PaymentRecord>;
  // Look up a payment we started earlier.
  getPayment(paymentId: string): Promise<PaymentRecord | null>;
  // Keep some or all of a held deposit (only ever after a written claim).
  captureDepositHold(paymentId: string, amountCents: number): Promise<void>;
  // Let a held deposit go. The customer's card is released.
  cancelDepositHold(paymentId: string): Promise<void>;
  // Give rental money back.
  refundPayment(paymentId: string, amountCents?: number): Promise<void>;
  // Check a message really came from Stripe, and read it.
  verifyWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent;

  // ---- PAYING RENTAL BUSINESSES ----
  // Start a business's own Stripe account.
  createConnectedAccount(input: {
    providerId: string;
    businessName: string;
    email: string;
    country: string;
  }): Promise<{ id: string }>;
  // The one-time link where the business gives Stripe its details. We never see
  // their bank details; they go straight to Stripe.
  createAccountOnboardingLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }>;
  // Where a business has got to in being able to receive money.
  getConnectedAccount(accountId: string): Promise<ConnectedAccount | null>;
  // Send a business their share.
  createTransfer(input: { accountId: string; amountCents: number; reference: string }): Promise<{ id: string }>;
};

// Raised when the endpoints are used before Stripe has been connected.
const notConfigured = () =>
  new AppError(503, 'payments_unavailable', 'Card payments are not switched on yet. Please try again later.');

// ---- THE REAL STRIPE ----
export function createStripeGateway(options: {
  secretKey: string;
  webhookSecret: string | undefined;
  currency: string;
}): PaymentGateway {
  const stripe = new Stripe(options.secretKey);
  const { currency } = options;

  // Turns Stripe's answer into the small shape the rest of the code uses.
  const toRecord = (intent: Stripe.PaymentIntent): PaymentRecord => ({
    id: intent.id,
    clientSecret: intent.client_secret ?? '',
    status: intent.status,
  });

  return {
    async createRentalPayment(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency,
          // What this payment is for, so an incoming message can be matched
          // back to the right booking without trusting anything else in it.
          metadata: { kind: 'rental', bookingId: input.bookingId, reference: input.bookingReference },
          receipt_email: input.customerEmail,
          automatic_payment_methods: { enabled: true },
        },
        // Asking twice for the same booking returns the same payment rather
        // than creating a second one.
        { idempotencyKey: `rental-${input.bookingId}` },
      );
      return toRecord(intent);
    },

    async createDepositHold(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency,
          // Authorise only. The money is never taken unless a claim is agreed.
          capture_method: 'manual',
          metadata: {
            kind: 'deposit',
            bookingId: input.bookingId,
            depositId: input.depositId,
            reference: input.bookingReference,
          },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: `deposit-${input.depositId}` },
      );
      return toRecord(intent);
    },

    async getPayment(paymentId) {
      try {
        return toRecord(await stripe.paymentIntents.retrieve(paymentId));
      } catch {
        return null;
      }
    },

    async captureDepositHold(paymentId, amountCents) {
      await stripe.paymentIntents.capture(paymentId, { amount_to_capture: amountCents });
    },

    async cancelDepositHold(paymentId) {
      await stripe.paymentIntents.cancel(paymentId);
    },

    async refundPayment(paymentId, amountCents) {
      await stripe.refunds.create({ payment_intent: paymentId, ...(amountCents ? { amount: amountCents } : {}) });
    },

    // ---- PAYING RENTAL BUSINESSES ----
    async createConnectedAccount(input) {
      const account = await stripe.accounts.create(
        {
          type: 'express',
          country: input.country,
          email: input.email,
          business_profile: { name: input.businessName },
          metadata: { providerId: input.providerId },
        },
        { idempotencyKey: `connect-${input.providerId}` },
      );
      return { id: account.id };
    },

    async createAccountOnboardingLink(input) {
      const link = await stripe.accountLinks.create({
        account: input.accountId,
        type: 'account_onboarding',
        return_url: input.returnUrl,
        refresh_url: input.refreshUrl,
      });
      return { url: link.url };
    },

    async getConnectedAccount(accountId) {
      try {
        const account = await stripe.accounts.retrieve(accountId);
        return {
          id: account.id,
          payoutsEnabled: account.payouts_enabled ?? false,
          outstanding: account.requirements?.currently_due ?? [],
        };
      } catch {
        return null;
      }
    },

    async createTransfer(input) {
      const transfer = await stripe.transfers.create(
        {
          amount: input.amountCents,
          currency,
          destination: input.accountId,
          transfer_group: input.reference,
          metadata: { payoutReference: input.reference },
        },
        // Asking twice for the same payout sends the money once.
        { idempotencyKey: `payout-${input.reference}` },
      );
      return { id: transfer.id };
    },

    verifyWebhook(rawBody, signature) {
      if (!options.webhookSecret) throw notConfigured();
      if (!signature) {
        throw new AppError(400, 'invalid_signature', 'This message was not signed.');
      }
      try {
        const event = stripe.webhooks.constructEvent(rawBody, signature, options.webhookSecret);
        // Stripe's own type here is the union of every kind of object it can
        // send. We read a few named fields out of it, so it is narrowed to a
        // plain bag of values and each field is checked where it is used.
        return {
          id: event.id,
          type: event.type,
          data: { object: event.data.object as unknown as Record<string, unknown> },
        };
      } catch {
        // Either not from Stripe, or altered on the way. Either way, refuse it.
        throw new AppError(400, 'invalid_signature', 'This message could not be verified.');
      }
    },
  };
}

// ---- BEFORE STRIPE IS CONNECTED ----
// Every action refuses clearly, so a half-finished payment can never appear to
// have worked.
export function createUnconfiguredGateway(): PaymentGateway {
  const refuse = async (): Promise<never> => {
    throw notConfigured();
  };
  return {
    createRentalPayment: refuse,
    createDepositHold: refuse,
    getPayment: refuse,
    captureDepositHold: refuse,
    cancelDepositHold: refuse,
    refundPayment: refuse,
    createConnectedAccount: refuse,
    createAccountOnboardingLink: refuse,
    getConnectedAccount: refuse,
    createTransfer: refuse,
    verifyWebhook() {
      throw notConfigured();
    },
  };
}
