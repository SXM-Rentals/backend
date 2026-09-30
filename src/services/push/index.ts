// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Push notifications to phones — registering a phone,
// honouring what each person chose to hear about, and sending.
//
// THE RULES IT HOLDS:
//
//   - a phone belongs to a sign-in. Only phones whose sign-in is still live are
//     ever sent to, and ending a sign-in removes its phones (sessions.ts);
//   - the same phone registered again MOVES to its new sign-in and owner, so a
//     phone that changes hands stops receiving the previous owner's pushes;
//   - at most ten phones per person — the oldest go first;
//   - each person's six choices are honoured, with one exception said out loud:
//     news about a booking still arrives while a rental is running, because a
//     person with a car in their hands needs to hear it;
//   - a push never carries a phone number, an email address, message text, card
//     details or an amount. Callers write the words; this file sends them.
//
// Sending never throws. A push that could not go out is logged, and whatever
// caused it — a booking, a message — has already happened and stays done.

import { and, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  bookings,
  chatThreads,
  devices,
  notificationPreferences,
  providerMembers,
  providers,
  pushTickets,
  sessions,
  vehicles,
} from '../../db/schema/index.js';
import type { Actor } from '../../lib/ownership.js';
import type { PushMessage, PushSender } from '../../lib/push.js';

export const MAX_DEVICES_PER_PERSON = 10;

export type PushCategory = 'bookings' | 'pickupReminders' | 'returnReminders' | 'deposits' | 'messages' | 'offers';
export type Preferences = Record<PushCategory, boolean>;

const DEFAULT_PREFERENCES: Preferences = {
  bookings: true,
  pickupReminders: true,
  returnReminders: true,
  deposits: true,
  messages: true,
  // Nobody is sent offers unless they asked for them.
  offers: false,
};

export type PushServiceDeps = {
  db: Database;
  sender: PushSender;
  logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

export function createPushService(deps: PushServiceDeps) {
  const { db, sender, logger } = deps;

  async function preferencesFor(customerId: string): Promise<Preferences> {
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.customerId, customerId))
      .limit(1);
    if (!row) return { ...DEFAULT_PREFERENCES };
    return {
      bookings: row.bookings,
      pickupReminders: row.pickupReminders,
      returnReminders: row.returnReminders,
      deposits: row.deposits,
      messages: row.messages,
      offers: row.offers,
    };
  }

  async function hasRentalRunning(customerId: string): Promise<boolean> {
    const [running] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.customerId, customerId), eq(bookings.status, 'active')))
      .limit(1);
    return Boolean(running);
  }

  // Sends to every live phone one person has, if they want this kind of news.
  async function sendToCustomer(
    customerId: string,
    push: { category: PushCategory; title: string; body: string; data: PushMessage['data'] },
  ): Promise<void> {
    try {
      if (!sender.live) return;

      const preferences = await preferencesFor(customerId);
      const wanted =
        preferences[push.category] || (push.category === 'bookings' && (await hasRentalRunning(customerId)));
      if (!wanted) return;

      // Only phones whose sign-in is still live.
      const now = new Date();
      const phones = await db
        .select({ id: devices.id, token: devices.token })
        .from(devices)
        .innerJoin(sessions, eq(sessions.id, devices.sessionId))
        .where(
          and(
            eq(devices.customerId, customerId),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, now),
            gt(sessions.absoluteExpiresAt, now),
          ),
        );
      if (phones.length === 0) return;

      const tickets = await sender.send(
        phones.map((phone) => ({ to: phone.token, title: push.title, body: push.body, data: push.data })),
      );

      for (const [index, ticket] of tickets.entries()) {
        const phone = phones[index];
        if (!phone) continue;
        if (ticket.status === 'ok') {
          await db.insert(pushTickets).values({ id: ticket.id, deviceId: phone.id }).onConflictDoNothing();
        } else if (ticket.details?.error === 'DeviceNotRegistered') {
          // The app is gone from that phone. Stop sending to it.
          await db.delete(devices).where(eq(devices.id, phone.id));
        }
      }
    } catch (error) {
      logger.warn({ err: String(error), category: push.category }, 'A push could not be sent');
    }
  }

  // The owners of a business, who hear about its bookings and conversations.
  async function ownersOf(providerId: string): Promise<string[]> {
    const rows = await db
      .select({ customerId: providerMembers.customerId })
      .from(providerMembers)
      .where(eq(providerMembers.providerId, providerId));
    return rows.map((row) => row.customerId);
  }

  return {
    sendToCustomer,

    // ---- REGISTERING A PHONE ----
    async registerDevice(actor: Actor, input: { token: string; platform: 'ios' | 'android'; language?: string | undefined }) {
      const [device] = await db
        .insert(devices)
        .values({
          customerId: actor.customerId,
          sessionId: actor.sessionId,
          token: input.token,
          platform: input.platform,
          language: input.language ?? null,
        })
        // Registered before, perhaps by somebody else: it moves to this sign-in.
        .onConflictDoUpdate({
          target: devices.token,
          set: {
            customerId: actor.customerId,
            sessionId: actor.sessionId,
            platform: input.platform,
            language: input.language ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: devices.id });

      // No more than ten phones each: the oldest go.
      const mine = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.customerId, actor.customerId))
        .orderBy(sql`${devices.updatedAt} desc`);
      const extra = mine.slice(MAX_DEVICES_PER_PERSON).map((row) => row.id);
      if (extra.length > 0) await db.delete(devices).where(inArray(devices.id, extra));
      return device;
    },

    // Only ever this person's own phone.
    async unregisterDevice(actor: Actor, token: string) {
      await db.delete(devices).where(and(eq(devices.token, token), eq(devices.customerId, actor.customerId)));
    },

    // ---- WHAT THEY WANT TO HEAR ABOUT ----
    async getPreferences(actor: Actor) {
      return preferencesFor(actor.customerId);
    },

    async setPreferences(actor: Actor, input: Preferences) {
      await db
        .insert(notificationPreferences)
        .values({ customerId: actor.customerId, ...input })
        .onConflictDoUpdate({ target: notificationPreferences.customerId, set: { ...input, updatedAt: new Date() } });
      const saved = await preferencesFor(actor.customerId);
      // Saved as chosen — and said plainly when one part of it does not apply
      // right now, rather than quietly ignoring the choice.
      if (!saved.bookings && (await hasRentalRunning(actor.customerId))) {
        return {
          ...saved,
          note: 'You have a rental running, so you will still hear about it until it ends.',
        };
      }
      return saved;
    },

    // ---- A NEW MESSAGE ----
    // From a business to its renter: the business's name, never the words.
    async messageFromBusiness(threadId: string) {
      const [thread] = await db
        .select({ customerId: chatThreads.customerId, businessName: providers.businessName })
        .from(chatThreads)
        .innerJoin(providers, eq(providers.id, chatThreads.providerId))
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      if (!thread) return;
      await sendToCustomer(thread.customerId, {
        category: 'messages',
        title: `New message from ${thread.businessName}`,
        body: 'Open SXM Rentals to read it.',
        data: { type: 'message', id: threadId },
      });
    },

    // From a renter to a business: to its owners, and never the renter's name
    // beyond what the business already sees, nor the words.
    async messageFromCustomer(threadId: string) {
      const [thread] = await db
        .select({ providerId: chatThreads.providerId, customerId: chatThreads.customerId })
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      if (!thread) return;
      for (const owner of await ownersOf(thread.providerId)) {
        if (owner === thread.customerId) continue;
        await sendToCustomer(owner, {
          category: 'messages',
          title: 'New message from a renter',
          body: 'Open SXM Rentals to read it.',
          data: { type: 'business_message', id: threadId },
        });
      }
    },

    // ---- A NEW BOOKING, TOLD TO THE BUSINESS ----
    async bookingForBusiness(bookingId: string) {
      const [row] = await db
        .select({ providerId: bookings.providerId, reference: bookings.reference, make: vehicles.make, model: vehicles.model, startDate: bookings.startDate })
        .from(bookings)
        .innerJoin(vehicles, eq(vehicles.id, bookings.vehicleId))
        .where(eq(bookings.id, bookingId))
        .limit(1);
      if (!row) return;
      for (const owner of await ownersOf(row.providerId)) {
        await sendToCustomer(owner, {
          category: 'bookings',
          title: `New booking — ${row.reference}`,
          body: `Your ${row.make} ${row.model}, from ${row.startDate}.`,
          data: { type: 'business_booking', id: bookingId },
        });
      }
    },

    // ---- RECEIPTS ----
    // Run by the daily job. A phone that answers "no longer registered" had the
    // app removed, and is not sent to again.
    async checkReceipts(): Promise<{ checked: number; removed: number }> {
      if (!sender.live) return { checked: 0, removed: 0 };
      // Expo needs a little time before a receipt exists.
      const settled = new Date(Date.now() - 15 * 60 * 1000);
      const tickets = await db.select().from(pushTickets).where(lt(pushTickets.sentAt, settled));
      if (tickets.length === 0) return { checked: 0, removed: 0 };

      const receipts = await sender.receipts(tickets.map((ticket) => ticket.id));
      let removed = 0;
      for (const ticket of tickets) {
        if (receipts[ticket.id]?.details?.error === 'DeviceNotRegistered') {
          await db.delete(devices).where(eq(devices.id, ticket.deviceId));
          removed += 1;
        }
      }
      await db.delete(pushTickets).where(inArray(pushTickets.id, tickets.map((ticket) => ticket.id)));
      return { checked: tickets.length, removed };
    },
  };
}

export type PushService = ReturnType<typeof createPushService>;

// Used by sessions.ts: ending a sign-in removes the phones registered under it.
export async function removeDevicesOfSessions(
  db: Database,
  where: { customerId: string; sessionId?: string; exceptSessionId?: string },
) {
  await db
    .delete(devices)
    .where(
      and(
        eq(devices.customerId, where.customerId),
        where.sessionId ? eq(devices.sessionId, where.sessionId) : undefined,
        where.exceptSessionId ? ne(devices.sessionId, where.exceptSessionId) : undefined,
      ),
    );
}
