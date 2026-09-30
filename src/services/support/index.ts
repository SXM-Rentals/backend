// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: A customer's conversation with SXM Rentals staff — one
// running conversation each, written from the app's Help & support and answered
// from the admin panel.
//
// WHAT EACH SIDE SEES. The customer sees what they wrote and what staff wrote,
// with the staff member's first name at most — never their email or phone. Staff
// see the customer's name and the whole conversation. A booking can be mentioned
// only if it is the customer's own.
//
// Staff replies reach the customer's phone as a push, which says a reply is
// waiting and never what it says.

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adminStaff, bookings, customers, supportMessages } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import type { AdminActor } from '../admin/auth.js';
import type { PushService } from '../push/index.js';

export type SupportServiceDeps = { db: Database; push?: PushService };

export function createSupportService(deps: SupportServiceDeps) {
  const { db, push } = deps;

  async function messagesOf(customerId: string) {
    return db
      .select({ message: supportMessages, staffName: adminStaff.name })
      .from(supportMessages)
      .leftJoin(adminStaff, eq(adminStaff.id, supportMessages.staffId))
      .where(eq(supportMessages.customerId, customerId))
      .orderBy(asc(supportMessages.sentAt));
  }

  return {
    // ---- THE CUSTOMER'S SIDE ----
    async conversationFor(actor: Actor) {
      const rows = await messagesOf(actor.customerId);
      return {
        messages: rows.map((row) => ({
          id: row.message.id,
          from: row.message.fromStaff ? ('staff' as const) : ('me' as const),
          body: row.message.body,
          sentAt: row.message.sentAt.toISOString(),
          // A first name at most: staff are people, not contact details.
          ...(row.message.fromStaff && row.staffName ? { staffName: row.staffName.split(/\s+/)[0] } : {}),
          ...(row.message.bookingId ? { bookingId: row.message.bookingId } : {}),
        })),
      };
    },

    async send(actor: Actor, input: { body: string; bookingId?: string | undefined }) {
      // Only one of their own rentals may be mentioned.
      if (input.bookingId) {
        if (!isUuid(input.bookingId)) throw notFound('We could not find that booking.');
        const [booking] = await db
          .select({ id: bookings.id })
          .from(bookings)
          .where(and(eq(bookings.id, input.bookingId), eq(bookings.customerId, actor.customerId)))
          .limit(1);
        if (!booking) throw notFound('We could not find that booking.');
      }
      await db.insert(supportMessages).values({
        customerId: actor.customerId,
        fromStaff: false,
        body: input.body,
        bookingId: input.bookingId,
      });
      return this.conversationFor(actor);
    },

    // ---- THE STAFF SIDE ----
    // Every conversation, those waiting for an answer first, then the most recent.
    async listForStaff() {
      const latest = await db
        .select({
          customerId: supportMessages.customerId,
          lastAt: sql<Date>`max(${supportMessages.sentAt})`,
          count: sql<number>`count(*)::int`,
        })
        .from(supportMessages)
        .groupBy(supportMessages.customerId)
        .orderBy(desc(sql`max(${supportMessages.sentAt})`))
        .limit(200);
      if (latest.length === 0) return [];

      const result = [];
      for (const row of latest) {
        const [last] = await db
          .select({ fromStaff: supportMessages.fromStaff, body: supportMessages.body })
          .from(supportMessages)
          .where(eq(supportMessages.customerId, row.customerId))
          .orderBy(desc(supportMessages.sentAt))
          .limit(1);
        const [customer] = await db
          .select({ firstName: customers.firstName, lastName: customers.lastName })
          .from(customers)
          .where(eq(customers.id, row.customerId))
          .limit(1);
        result.push({
          customerId: row.customerId,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : '',
          lastMessageAt: new Date(row.lastAt).toISOString(),
          // Waiting for staff when the customer wrote last.
          waitingForStaff: last ? !last.fromStaff : false,
          messageCount: row.count,
          preview: (last?.body ?? '').slice(0, 140),
        });
      }
      return result.sort((a, b) => Number(b.waitingForStaff) - Number(a.waitingForStaff));
    },

    async conversationForStaff(customerId: string) {
      if (!isUuid(customerId)) throw notFound('We could not find that conversation.');
      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
      if (!customer) throw notFound('We could not find that conversation.');
      const rows = await messagesOf(customerId);
      return {
        customerId,
        customerName: `${customer.firstName} ${customer.lastName}`,
        messages: rows.map((row) => ({
          id: row.message.id,
          from: row.message.fromStaff ? ('staff' as const) : ('customer' as const),
          body: row.message.body,
          sentAt: row.message.sentAt.toISOString(),
          ...(row.staffName ? { staffName: row.staffName } : {}),
          ...(row.message.bookingId ? { bookingId: row.message.bookingId } : {}),
        })),
      };
    },

    async replyAsStaff(actor: AdminActor, customerId: string, input: { body: string }) {
      const conversation = await this.conversationForStaff(customerId);
      await db.insert(supportMessages).values({
        customerId,
        fromStaff: true,
        staffId: actor.staffId,
        body: input.body,
      });
      await push?.sendToCustomer(customerId, {
        category: 'messages',
        title: 'SXM Rentals replied',
        body: 'Open Help & support to read it.',
        data: { type: 'support', id: customerId },
      });
      return this.conversationForStaff(conversation.customerId);
    },
  };
}

export type SupportService = ReturnType<typeof createSupportService>;
