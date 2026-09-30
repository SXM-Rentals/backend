// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Checks that a customer is who they say they are before
// they rent a car — either through Stripe Identity, or by SXM Rentals staff.
//
// ---- THE TWO WAYS, CHOSEN BY THE OWNER (IDENTITY_METHOD on Render) ----
//
//   stripe   The person photographs their ID and takes a selfie on STRIPE'S OWN
//            page. The photos go straight to Stripe — never through the app, and
//            never through SXM Rentals. Stripe tells us the outcome. It costs per
//            check.
//   staff    SXM Rentals staff decide from the admin panel. Starting a check from
//            the app answers "feature_off", and the app says staff will do it.
//
// ---- WHAT IS KEPT ----
//
// The OUTCOME and Stripe's session id, and nothing else. The ID photos stay
// with Stripe, which keeps SXM Rentals from holding passport scans — and keeps
// its obligations under the GDPR, on the French side, light.
//
// ---- THE RULE THAT MAKES IT MEAN SOMETHING ----
//
// Once identity checks are switched on, making a booking refuses a customer who
// is not approved (assertMayBook). The check on the phone only makes the
// screens clearer; an old or altered copy of the app would skip it.

import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { customers } from '../../db/schema/index.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import type { Actor } from '../../lib/ownership.js';
import type { PaymentGateway, WebhookEvent } from '../../lib/stripe.js';
import type { AdminActor } from '../admin/auth.js';
import { recordAudit } from '../admin/audit.js';
import { isFeatureOn } from '../capabilities/index.js';
import { toUser } from '../serializers/customer.js';

type Notifier = {
  notify(input: { customerId: string; kind: 'verification'; title: string; body: string }): Promise<void>;
};

export type VerificationServiceDeps = {
  db: Database;
  config: Config;
  gateway: PaymentGateway;
  notifications: Notifier;
  logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

// The same words however the decision was made, so the app never has to know.
const STATUS_WORDS = {
  unstarted: 'Not started',
  pending: 'Being checked',
  approved: 'Approved',
  rejected: 'Not approved',
  resubmit: 'Asked to try again',
} as const;

export function createVerificationService(deps: VerificationServiceDeps) {
  const { db, config, gateway, notifications, logger } = deps;

  async function loadCustomer(customerId: string) {
    const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    if (!customer || customer.deletedAt) throw notFound('We could not find that account.');
    return customer;
  }

  // What happened, told to the person in the app — never with anybody else's
  // details, and never the reason for somebody else.
  async function tell(customerId: string, status: 'approved' | 'rejected' | 'resubmit') {
    const message = {
      approved: { title: 'Your identity is confirmed', body: 'You can book a car now.' },
      rejected: { title: 'Your identity check was not approved', body: 'Open your account to see why.' },
      resubmit: { title: 'Please try the identity check again', body: 'Open your account to see what to change.' },
    }[status];
    await notifications.notify({ customerId, kind: 'verification', ...message });
  }

  return {
    // ---- STARTING A CHECK, FROM THE APP ----
    // Answers with the address of Stripe's own page. Asking again while that
    // page is still waiting for the person hands back the same one.
    async startSession(actor: Actor, returnUrl: string): Promise<{ url: string }> {
      if (config.identityMethod === 'staff') {
        throw new AppError(503, 'feature_off', 'SXM Rentals staff check your identity. You will be told here when it is done.');
      }
      const customer = await loadCustomer(actor.customerId);
      if (customer.verificationStatus === 'approved') {
        throw conflict('already_verified', 'Your identity is already confirmed.');
      }

      if (customer.identitySessionId) {
        const existing = await gateway.getIdentitySession(customer.identitySessionId);
        if (existing?.status === 'requires_input' && existing.url) return { url: existing.url };
        if (existing?.status === 'processing') {
          throw conflict('check_in_progress', 'Your identity is being checked. You will be told here when it is done.');
        }
      }

      const session = await gateway.createIdentitySession({ customerId: customer.id, returnUrl });
      await db.update(customers).set({ identitySessionId: session.id }).where(eq(customers.id, customer.id));
      return { url: session.url };
    },

    // ---- WHAT STRIPE TELLS US ----
    // Only ever changes the account the session was started for, and only for
    // the session it currently has — a message about an old, abandoned session
    // cannot overwrite a newer outcome.
    async applyStripeEvent(event: WebhookEvent): Promise<boolean> {
      if (!event.type.startsWith('identity.verification_session.')) return false;
      const session = event.data.object as {
        id?: string;
        metadata?: { customerId?: string };
        last_error?: { reason?: string } | null;
      };
      const customerId = session.metadata?.customerId;
      if (!customerId || !session.id) return true;

      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
      if (!customer || customer.identitySessionId !== session.id) {
        logger.info({ type: event.type }, 'Identity message for a session that is not current; ignored');
        return true;
      }
      // Once approved, nothing from Stripe takes it away. Only staff can.
      if (customer.verificationStatus === 'approved') return true;

      switch (event.type) {
        case 'identity.verification_session.processing':
          await db
            .update(customers)
            .set({ verificationStatus: 'pending', verificationSubmittedAt: new Date(), verificationReason: null })
            .where(eq(customers.id, customer.id));
          break;
        case 'identity.verification_session.verified':
          await db
            .update(customers)
            .set({ verificationStatus: 'approved', verificationReason: null, identityDocDone: true, selfieDone: true })
            .where(eq(customers.id, customer.id));
          await tell(customer.id, 'approved');
          break;
        case 'identity.verification_session.requires_input':
          // Stripe's reason is written for people ("The document was too
          // blurry"), so it is shown as it is.
          await db
            .update(customers)
            .set({
              verificationStatus: 'resubmit',
              verificationReason: session.last_error?.reason ?? 'The check could not be completed. Please try again.',
            })
            .where(eq(customers.id, customer.id));
          await tell(customer.id, 'resubmit');
          break;
        default:
          logger.info({ type: event.type }, 'Identity message of a kind we do not act on');
      }
      return true;
    },

    // ---- A STAFF MEMBER DECIDES ----
    // The way checks are made when the owner chooses staff over Stripe, and the
    // way to overturn Stripe's answer either way. Recorded with who decided and
    // why. `customerMessage` is what the person is told; `reason` is for the
    // audit log and may be meant for staff only, so the two are kept apart.
    async decideByStaff(
      actor: AdminActor,
      customerId: string,
      input: { decision: 'approved' | 'rejected' | 'resubmit'; reason: string; customerMessage?: string | undefined },
    ) {
      const customer = await loadCustomer(customerId);
      const [updated] = await db
        .update(customers)
        .set({
          verificationStatus: input.decision,
          verificationReason: input.decision === 'approved' ? null : (input.customerMessage ?? null),
        })
        .where(eq(customers.id, customer.id))
        .returning();

      await recordAudit(db, {
        staffId: actor.staffId,
        action: input.decision === 'approved' ? 'verification_approved' : 'verification_rejected',
        subjectType: 'customer',
        subjectId: customer.id,
        subjectLabel: `Customer · ${customer.firstName} ${customer.lastName}`,
        field: 'Identity',
        before: STATUS_WORDS[customer.verificationStatus],
        after: STATUS_WORDS[input.decision],
        reason: input.reason,
      });
      await tell(customer.id, input.decision);
      return toUser(updated!);
    },

    // ---- THE RULE ----
    // With identity checks switched on, only an approved customer may book.
    async assertMayBook(actor: Actor): Promise<void> {
      if (!isFeatureOn(config, 'identity')) return;
      const customer = await loadCustomer(actor.customerId);
      if (customer.verificationStatus !== 'approved') {
        throw new AppError(
          403,
          'identity_required',
          'Please confirm your identity before booking. It takes a few minutes, and only needs doing once.',
        );
      }
    },
  };
}

export type VerificationService = ReturnType<typeof createVerificationService>;
