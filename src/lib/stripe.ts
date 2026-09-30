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

// Paying for the extra days of a rental whose dates were changed.
export type DateChangePaymentInput = {
  bookingId: string;
  bookingReference: string;
  dateChangeId: string;
  amountCents: number;
};

export type DepositHoldInput = {
  bookingId: string;
  bookingReference: string;
  depositId: string;
  amountCents: number;
};

// A card a customer has saved with Stripe, as the app may show it: the brand,
// the last four digits and the expiry, and never more. The number itself stays
// with Stripe.
export type SavedCard = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
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
  // Charge the difference when a rental's new dates cost more.
  createDateChangePayment(input: DateChangePaymentInput): Promise<PaymentRecord>;
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

  // ---- SAVED CARDS ----
  // The customer's own record at Stripe, which their saved cards hang off.
  createCustomer(input: { customerId: string; email: string; name: string }): Promise<{ id: string }>;
  // Removing it takes every saved card with it. Used when an account closes.
  deleteCustomer(stripeCustomerId: string): Promise<void>;
  // A one-time secret the app gives Stripe's own form, in "save a card" mode.
  // The card goes from the phone to Stripe; this server never sees it.
  createCardSetup(stripeCustomerId: string): Promise<{ clientSecret: string }>;
  listCards(stripeCustomerId: string): Promise<SavedCard[]>;
  // Both answer false when the card is not this customer's — which the caller
  // turns into "not found", exactly like a card that does not exist.
  removeCard(stripeCustomerId: string, cardId: string): Promise<boolean>;
  setDefaultCard(stripeCustomerId: string, cardId: string): Promise<boolean>;

  // ---- IDENTITY CHECKS ----
  // A check on Stripe's own page: the person photographs their ID and takes a
  // selfie there, and the photos go to Stripe, never to us.
  createIdentitySession(input: { customerId: string; returnUrl: string }): Promise<{ id: string; url: string }>;
  getIdentitySession(sessionId: string): Promise<{ id: string; status: string; url: string | null } | null>;
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
        // The amount is part of the key: a booking whose dates (and so its
        // price) changed before it was paid gets a payment for the new amount,
        // where the same key would hand back the old one.
        { idempotencyKey: `rental-${input.bookingId}-${input.amountCents}` },
      );
      return toRecord(intent);
    },

    async createDateChangePayment(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency,
          // Matched back to the request, not the booking, when Stripe reports it.
          metadata: {
            kind: 'date_change',
            bookingId: input.bookingId,
            dateChangeId: input.dateChangeId,
            reference: input.bookingReference,
          },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: `date-change-${input.dateChangeId}` },
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

    // ---- SAVED CARDS ----
    async createCustomer(input) {
      const customer = await stripe.customers.create(
        { email: input.email, name: input.name, metadata: { customerId: input.customerId } },
        // Asking twice for the same person makes one Stripe customer, not two.
        { idempotencyKey: `customer-${input.customerId}` },
      );
      return { id: customer.id };
    },

    async deleteCustomer(stripeCustomerId) {
      try {
        await stripe.customers.del(stripeCustomerId);
      } catch (error) {
        // Already gone is the result we wanted.
        if ((error as { code?: string }).code !== 'resource_missing') throw error;
      }
    },

    async createCardSetup(stripeCustomerId) {
      const setup = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        // Saved for the customer to CHOOSE when they pay — never to be charged
        // while they are not there. Charging a card with nobody at the keyboard
        // needs their agreement in so many words, and nobody has asked for it.
        usage: 'on_session',
        automatic_payment_methods: { enabled: true },
      });
      return { clientSecret: setup.client_secret ?? '' };
    },

    async listCards(stripeCustomerId) {
      const [methods, customer] = await Promise.all([
        stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card' }),
        stripe.customers.retrieve(stripeCustomerId),
      ]);
      const defaultId =
        !customer.deleted && typeof customer.invoice_settings?.default_payment_method === 'string'
          ? customer.invoice_settings.default_payment_method
          : null;
      return methods.data
        .filter((method) => method.card)
        .map((method) => ({
          id: method.id,
          brand: method.card!.brand,
          last4: method.card!.last4,
          expMonth: method.card!.exp_month,
          expYear: method.card!.exp_year,
          isDefault: method.id === defaultId,
        }));
    },

    async removeCard(stripeCustomerId, cardId) {
      const method = await stripe.paymentMethods.retrieve(cardId).catch(() => null);
      if (!method || method.customer !== stripeCustomerId) return false;
      await stripe.paymentMethods.detach(cardId);
      return true;
    },

    async setDefaultCard(stripeCustomerId, cardId) {
      const method = await stripe.paymentMethods.retrieve(cardId).catch(() => null);
      if (!method || method.customer !== stripeCustomerId) return false;
      await stripe.customers.update(stripeCustomerId, { invoice_settings: { default_payment_method: cardId } });
      return true;
    },

    // ---- IDENTITY CHECKS ----
    async createIdentitySession(input) {
      const session = await stripe.identity.verificationSessions.create({
        type: 'document',
        options: { document: { require_matching_selfie: true } },
        return_url: input.returnUrl,
        // How the outcome is matched back to the account when Stripe reports it.
        metadata: { customerId: input.customerId },
      });
      return { id: session.id, url: session.url ?? '' };
    },

    async getIdentitySession(sessionId) {
      try {
        const session = await stripe.identity.verificationSessions.retrieve(sessionId);
        return { id: session.id, status: session.status, url: session.url ?? null };
      } catch {
        return null;
      }
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
    createDateChangePayment: refuse,
    createDepositHold: refuse,
    getPayment: refuse,
    captureDepositHold: refuse,
    cancelDepositHold: refuse,
    refundPayment: refuse,
    createConnectedAccount: refuse,
    createAccountOnboardingLink: refuse,
    getConnectedAccount: refuse,
    createTransfer: refuse,
    createCustomer: refuse,
    deleteCustomer: refuse,
    createCardSetup: refuse,
    listCards: refuse,
    removeCard: refuse,
    setDefaultCard: refuse,
    createIdentitySession: refuse,
    getIdentitySession: refuse,
    verifyWebhook() {
      throw notConfigured();
    },
  };
}
