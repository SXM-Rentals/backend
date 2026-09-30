// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The things a customer does with their own account — see
// their rewards, change their name and phone number, move to a new email
// address, keep a list of saved cars, and download a copy of their data.
//
// EVERYTHING HERE IS THE SIGNED-IN PERSON'S OWN RECORD. Nothing takes an account
// id from the request, so there is nobody else's record to ask for.
//
// ---- THREE RULES WORTH SAYING OUT LOUD ----
//
//   - Once somebody's identity has been checked, their NAME is locked: it was
//     checked against their licence. They ask SXM Rentals to change it.
//   - A new email address only takes over once the person proves they can read
//     it. Until then the old one keeps working, and it is told about the request
//     at once — so somebody who has got into the account cannot quietly move it.
//     The answer is the same whether or not the new address is taken, so the
//     request cannot be used to find out who is a customer.
//   - A copy of your data is a one-time link, good for a day, at most once a
//     day. It contains your own records and no other person's contact details.
//     Opening the link shows a page with a button; only pressing it downloads.
//     Mail programs open links to check them for danger, and a download that
//     happened on opening would be used up by the checker before the person saw
//     it.

import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import {
  authTokens,
  customers,
  notificationPreferences,
  reviews,
  rewardLedger,
  savedCars,
  supportMessages,
  vehicles,
} from '../../db/schema/index.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import type { EmailSender } from '../../lib/email.js';
import { buildEmail, type EmailBrand } from '../../lib/email-templates.js';
import { AppError, conflict, notFound, tooManyRequests } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import { assertOwnPassword } from '../auth/credentials.js';
import { listBookingsFor } from '../booking-engine/index.js';
import { isFeatureOn } from '../capabilities/index.js';
import { listThreadsForCustomer } from '../messaging/index.js';
import { tierForPoints } from '../serializers/admin.js';
import { toUser } from '../serializers/customer.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The points at which each rewards level begins. The same numbers the apps show.
const TIERS: { tier: 'explorer' | 'traveler' | 'vip' | 'elite'; from: number }[] = [
  { tier: 'explorer', from: 0 },
  { tier: 'traveler', from: 2_500 },
  { tier: 'vip', from: 7_500 },
  { tier: 'elite', from: 20_000 },
];

export type AccountServiceDeps = {
  db: Database;
  config: Config;
  email: EmailSender;
  brand: EmailBrand;
  logger: { error: (obj: object, msg: string) => void };
};

export function createAccountService(deps: AccountServiceDeps) {
  const { db, config, email, brand, logger } = deps;

  const sendInBackground = (to: string, subject: string, content: Parameters<typeof buildEmail>[2]) => {
    email.send(buildEmail(to, subject, content, brand)).catch((error: unknown) => {
      logger.error({ err: error }, 'Account email could not be sent');
    });
  };

  async function me(actor: Actor) {
    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, actor.customerId), isNull(customers.deletedAt)))
      .limit(1);
    if (!customer) throw new AppError(401, 'unauthorized', 'Please sign in again.');
    return customer;
  }

  return {
    // ---- REWARDS ----
    // What the ledger holds. Points come from staff adjustments until the owner
    // decides how they are earned; nothing here invents a rule for earning them.
    async rewards(actor: Actor) {
      const customer = await me(actor);
      const history = await db
        .select()
        .from(rewardLedger)
        .where(eq(rewardLedger.customerId, customer.id))
        .orderBy(desc(rewardLedger.createdAt));
      const points = history.reduce((sum, row) => sum + row.points, 0);
      const tier = tierForPoints(points);
      const next = TIERS.find((level) => level.from > points) ?? null;
      return {
        points,
        tier,
        nextTier: next?.tier ?? null,
        pointsToNextTier: next ? next.from - points : 0,
        // Somebody who lives on the island. Not earned, cannot be lost, and
        // nothing to do with points.
        isIslander: customer.isIslander,
        history: history.map((row) => ({
          id: row.id,
          label: row.label,
          points: row.points,
          date: row.createdAt.toISOString().slice(0, 10),
        })),
      };
    },

    // ---- YOUR NAME AND PHONE NUMBER ----
    async updateProfile(
      actor: Actor,
      patch: { firstName?: string | undefined; lastName?: string | undefined; phone?: string | undefined },
    ) {
      const customer = await me(actor);
      const renaming =
        (patch.firstName !== undefined && patch.firstName !== customer.firstName) ||
        (patch.lastName !== undefined && patch.lastName !== customer.lastName);
      // Checked against their licence, so it cannot drift from it.
      if (renaming && customer.verificationStatus === 'approved' && isFeatureOn(config, 'identity')) {
        throw conflict(
          'name_locked',
          'Your name was checked against your licence, so it cannot be changed here. Please contact SXM Rentals.',
        );
      }
      const changes = {
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone || null } : {}),
      };
      if (Object.keys(changes).length === 0) return toUser(customer);
      const [updated] = await db.update(customers).set(changes).where(eq(customers.id, customer.id)).returning();
      return toUser(updated!);
    },

    // ---- MOVING TO A NEW EMAIL ADDRESS ----
    async requestEmailChange(actor: Actor, input: { email: string; password: string }) {
      await assertOwnPassword(db, actor.customerId, input.password);
      const customer = await me(actor);
      const newEmail = input.email.trim().toLowerCase();
      const message = { message: `Check ${newEmail} for a link to confirm the change.` };
      if (newEmail === customer.email) return message;

      const [taken] = await db.select({ id: customers.id }).from(customers).where(eq(customers.email, newEmail)).limit(1);

      // Told at once, before anything changes: if this was not them, they still
      // hold the account and can change the password.
      sendInBackground(customer.email, 'A change of email address was asked for', {
        preheader: 'Your SXM Rentals account may be moving to a new address.',
        title: 'A new email address was asked for',
        paragraphs: [
          `Hi ${customer.firstName},`,
          `Somebody signed in to your SXM Rentals account asked to move it to ${newEmail}. Nothing changes unless that address confirms it.`,
          'If this was not you, change your password now.',
        ],
        button: { label: 'Change my password', url: `${config.appUrl}/forgot-password` },
      });

      if (taken) {
        // The same answer to the person asking. The owner of that address is
        // told somebody tried, and nothing else happens.
        sendInBackground(newEmail, 'Somebody tried to use this address', {
          preheader: 'This address already has an SXM Rentals account. Nothing has changed.',
          title: 'This address already has an account',
          paragraphs: [
            'Somebody asked to move another SXM Rentals account to this email address, which already has one of its own.',
            'Nothing has changed. If this was you, sign in to the account this address already belongs to.',
          ],
        });
        return message;
      }

      // One open request at a time: a new one cancels the last.
      await db
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(authTokens.customerId, customer.id), eq(authTokens.purpose, 'change_email'), isNull(authTokens.usedAt)));
      const token = generateToken();
      await db.insert(authTokens).values({
        customerId: customer.id,
        purpose: 'change_email',
        tokenHash: hashToken(token),
        newEmail,
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      sendInBackground(newEmail, 'Confirm your new email address', {
        preheader: 'One click and your SXM Rentals account moves to this address.',
        title: 'Confirm your new email address',
        paragraphs: [`Hi ${customer.firstName},`, 'Confirm this address and your SXM Rentals account moves to it.'],
        button: { label: 'Confirm this address', url: `${config.appUrl}/confirm-email?token=${token}` },
        note: 'The link works once, for the next 24 hours. If you did not ask for this, ignore this email.',
      });
      return message;
    },

    // Opening the link from the email, on the website.
    async confirmEmailChange(token: string) {
      const [row] = await db
        .select()
        .from(authTokens)
        .where(
          and(
            eq(authTokens.tokenHash, hashToken(token)),
            eq(authTokens.purpose, 'change_email'),
            isNull(authTokens.usedAt),
            gt(authTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!row?.newEmail) {
        throw new AppError(400, 'link_expired', 'That link has already been used or has expired. Please ask for a new one.');
      }
      const [taken] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.email, row.newEmail))
        .limit(1);
      if (taken) throw conflict('email_taken', 'That address has an SXM Rentals account of its own now.');

      await db.transaction(async (tx) => {
        await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
        await tx.update(customers).set({ email: row.newEmail! }).where(eq(customers.id, row.customerId));
      });
      return { message: 'Your email address has been changed.' };
    },

    // ---- SAVED CARS ----
    async savedCars(actor: Actor) {
      const rows = await db
        .select({ vehicleId: savedCars.vehicleId })
        .from(savedCars)
        .where(eq(savedCars.customerId, actor.customerId))
        .orderBy(desc(savedCars.savedAt));
      return { vehicleIds: rows.map((row) => row.vehicleId) };
    },

    // Saving twice changes nothing. A car that does not exist is "not found".
    async saveCar(actor: Actor, vehicleId: string) {
      if (!isUuid(vehicleId)) throw notFound('We could not find that vehicle.');
      const [vehicle] = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, vehicleId)).limit(1);
      if (!vehicle) throw notFound('We could not find that vehicle.');
      await db.insert(savedCars).values({ customerId: actor.customerId, vehicleId }).onConflictDoNothing();
    },

    // Removing one that was never saved changes nothing either.
    async unsaveCar(actor: Actor, vehicleId: string) {
      if (!isUuid(vehicleId)) return;
      await db.delete(savedCars).where(and(eq(savedCars.customerId, actor.customerId), eq(savedCars.vehicleId, vehicleId)));
    },

    // ---- A COPY OF YOUR DATA ----
    async requestExport(actor: Actor, linkBase: string) {
      const customer = await me(actor);
      const [recent] = await db
        .select({ createdAt: authTokens.createdAt })
        .from(authTokens)
        .where(
          and(
            eq(authTokens.customerId, customer.id),
            eq(authTokens.purpose, 'data_export'),
            gt(authTokens.createdAt, new Date(Date.now() - DAY_MS)),
          ),
        )
        .orderBy(desc(authTokens.createdAt))
        .limit(1);
      if (recent) {
        const seconds = Math.ceil((recent.createdAt.getTime() + DAY_MS - Date.now()) / 1000);
        throw tooManyRequests(seconds, 'A copy of your data can be asked for once a day. Please try again tomorrow.');
      }

      const token = generateToken();
      await db.insert(authTokens).values({
        customerId: customer.id,
        purpose: 'data_export',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      sendInBackground(customer.email, 'A copy of your SXM Rentals data', {
        preheader: 'Your download link, good for one download in the next 24 hours.',
        title: 'Your data is ready',
        paragraphs: [
          `Hi ${customer.firstName},`,
          'Here is the copy of your SXM Rentals data you asked for: your account, your rentals, your messages and your reviews.',
        ],
        button: { label: 'Download my data', url: `${linkBase}/api/v1/exports/${token}` },
        note: 'The link works once, for the next 24 hours. If you did not ask for this, change your password.',
      });
      return { message: `We will email a link to download your data to ${customer.email}.` };
    },

    // The page the link opens. It checks the link without using it up.
    async exportLinkIsGood(token: string): Promise<boolean> {
      const [row] = await db
        .select({ id: authTokens.id })
        .from(authTokens)
        .where(
          and(
            eq(authTokens.tokenHash, hashToken(token)),
            eq(authTokens.purpose, 'data_export'),
            isNull(authTokens.usedAt),
            gt(authTokens.expiresAt, new Date()),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    // Pressing the button: the link is used up, and the file is made.
    async downloadExport(token: string) {
      const [row] = await db
        .update(authTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(authTokens.tokenHash, hashToken(token)),
            eq(authTokens.purpose, 'data_export'),
            isNull(authTokens.usedAt),
            gt(authTokens.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!row) throw new AppError(400, 'link_expired', 'That link has already been used or has expired.');

      const actor: Actor = { customerId: row.customerId, sessionId: '', authMethod: 'bearer' };
      const [customer] = await db.select().from(customers).where(eq(customers.id, row.customerId)).limit(1);
      if (!customer) throw notFound();

      const [bookingList, conversations, reviewRows, saved, rewardRows, supportRows, [preferences]] = await Promise.all([
        listBookingsFor(db, actor),
        listThreadsForCustomer(db, actor),
        db
          .select({ rating: reviews.rating, body: reviews.body, createdAt: reviews.createdAt, make: vehicles.make, model: vehicles.model })
          .from(reviews)
          .innerJoin(vehicles, eq(vehicles.id, reviews.vehicleId))
          .where(eq(reviews.customerId, customer.id)),
        db.select({ vehicleId: savedCars.vehicleId }).from(savedCars).where(eq(savedCars.customerId, customer.id)),
        db.select().from(rewardLedger).where(eq(rewardLedger.customerId, customer.id)),
        db.select().from(supportMessages).where(eq(supportMessages.customerId, customer.id)).orderBy(asc(supportMessages.sentAt)),
        db.select().from(notificationPreferences).where(eq(notificationPreferences.customerId, customer.id)),
      ]);
      return {
        generatedAt: new Date().toISOString(),
        account: { ...toUser(customer), email: customer.email, phone: customer.phone ?? '' },
        bookings: bookingList,
        // Other people appear by business name only — never a phone number or
        // an email address that is not the person's own.
        conversations: conversations.map((thread) => ({
          business: thread.providerName,
          bookingRef: thread.bookingRef ?? null,
          messages: thread.messages.map((message) => ({ from: message.from, body: message.body, sentAt: message.sentAt })),
        })),
        reviews: reviewRows.map((review) => ({
          car: `${review.make} ${review.model}`,
          rating: review.rating,
          body: review.body,
          date: review.createdAt.toISOString().slice(0, 10),
        })),
        savedCars: saved.map((row) => row.vehicleId),
        rewards: rewardRows.map((entry) => ({ label: entry.label, points: entry.points, date: entry.createdAt.toISOString().slice(0, 10) })),
        messagesWithSxmRentals: supportRows.map((message) => ({
          from: message.fromStaff ? 'SXM Rentals' : 'me',
          body: message.body,
          sentAt: message.sentAt.toISOString(),
        })),
        notificationChoices: preferences ?? null,
      };
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
