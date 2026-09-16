// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Telling customers what has happened — their booking is
// confirmed, their payment went through, their deposit has been given back,
// their car is due for collection tomorrow.
//
// TWO PLACES AT ONCE. Everything appears in the app's notifications list, and
// the ones that genuinely need attention are emailed as well. A notification is
// written to the database first, so the list is right even if the email fails.
//
// NOTHING HERE EVER STOPS THE THING IT IS TELLING YOU ABOUT. A booking that was
// made, a payment that arrived, a deposit that was given back — those have
// already happened. If writing the notification or sending the email fails, it
// is logged and the original action still stands, because failing a completed
// booking because an email bounced would be far worse than a missing message.
//
// Push notifications to phones come later: they need Expo credentials.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings, customers, deposits, notifications, vehicles } from '../../db/schema/index.js';
import type { EmailSender } from '../../lib/email.js';
import { notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import { today } from '../availability-engine/index.js';

type Logger = { error: (obj: object, msg: string) => void };

export type NotificationServiceDeps = {
  db: Database;
  email: EmailSender;
  logger: Logger;
};

export type NotificationKind =
  | 'booking_confirmed'
  | 'payment'
  | 'pickup_reminder'
  | 'return_reminder'
  | 'late_return'
  | 'cancellation'
  | 'verification'
  | 'promotion';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function createNotificationService(deps: NotificationServiceDeps) {
  const { db, email, logger } = deps;

  // Everything the messages need to say something useful: who, which car, when.
  async function bookingContext(bookingId: string) {
    const [row] = await db
      .select({ booking: bookings, customer: customers, vehicle: vehicles })
      .from(bookings)
      .innerJoin(customers, eq(customers.id, bookings.customerId))
      .innerJoin(vehicles, eq(vehicles.id, bookings.vehicleId))
      .where(eq(bookings.id, bookingId))
      .limit(1);
    return row;
  }

  // Writes the notification, then emails it if asked. Never throws: see the
  // note at the top of this file.
  async function notify(input: {
    customerId: string;
    bookingId?: string | undefined;
    kind: NotificationKind;
    title: string;
    body: string;
    // Only set for the messages that genuinely warrant an email.
    emailTo?: { address: string; subject: string; text: string } | undefined;
    // When set, the same kind of message about the same booking is only ever
    // sent once.
    onlyOnce?: boolean;
  }): Promise<void> {
    try {
      if (input.onlyOnce && input.bookingId) {
        const [already] = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(eq(notifications.bookingId, input.bookingId), eq(notifications.kind, input.kind)))
          .limit(1);
        if (already) return;
      }

      await db.insert(notifications).values({
        customerId: input.customerId,
        bookingId: input.bookingId,
        kind: input.kind,
        title: input.title,
        body: input.body,
      });

      if (input.emailTo) {
        email
          .send({ to: input.emailTo.address, subject: input.emailTo.subject, text: input.emailTo.text })
          .catch((error: unknown) => logger.error({ err: error }, 'Notification email could not be sent'));
      }
    } catch (error) {
      logger.error({ err: error, kind: input.kind }, 'Notification could not be recorded');
    }
  }

  return {
    notify,

    // ---- WHAT HAPPENS TO A BOOKING ----

    async bookingConfirmed(bookingId: string) {
      const row = await bookingContext(bookingId);
      if (!row) return;
      const car = `${row.vehicle.make} ${row.vehicle.model}`;
      await notify({
        customerId: row.customer.id,
        bookingId,
        kind: 'booking_confirmed',
        title: `Booking confirmed — ${row.booking.reference}`,
        body: `Your ${car} is booked from ${row.booking.startDate} to ${row.booking.endDate}.`,
        emailTo: {
          address: row.customer.email,
          subject: `Your SXM Rentals booking ${row.booking.reference}`,
          text: [
            `Hi ${row.customer.firstName},`,
            '',
            `Your ${car} is booked from ${row.booking.startDate} to ${row.booking.endDate}.`,
            `Collection: ${row.booking.pickupTime} at ${row.booking.location}.`,
            '',
            `Total for the rental: ${money(row.booking.totalDueTodayCents)}.`,
            'A security deposit is held separately on your card just before collection and given back after the car is returned. It is not part of the total above.',
          ].join('\n'),
        },
      });
    },

    async bookingCancelled(bookingId: string) {
      const row = await bookingContext(bookingId);
      if (!row) return;
      await notify({
        customerId: row.customer.id,
        bookingId,
        kind: 'cancellation',
        title: `Booking cancelled — ${row.booking.reference}`,
        body: `Your ${row.vehicle.make} ${row.vehicle.model} booking has been cancelled.`,
        emailTo: {
          address: row.customer.email,
          subject: `Your SXM Rentals booking ${row.booking.reference} is cancelled`,
          text: [
            `Hi ${row.customer.firstName},`,
            '',
            `Your booking for the ${row.vehicle.make} ${row.vehicle.model} (${row.booking.startDate} to ${row.booking.endDate}) has been cancelled.`,
            'Any deposit held for it is released back to your card.',
          ].join('\n'),
        },
      });
    },

    // ---- MONEY ----

    async paymentSucceeded(bookingId: string) {
      const row = await bookingContext(bookingId);
      if (!row) return;
      await notify({
        customerId: row.customer.id,
        bookingId,
        kind: 'payment',
        title: 'Payment received',
        body: `We have received ${money(row.booking.grossCents)} for booking ${row.booking.reference}.`,
        onlyOnce: true,
      });
    },

    async paymentFailed(bookingId: string) {
      const row = await bookingContext(bookingId);
      if (!row) return;
      await notify({
        customerId: row.customer.id,
        bookingId,
        kind: 'payment',
        title: 'Payment did not go through',
        body: `The payment for booking ${row.booking.reference} was declined. Please try another card.`,
        emailTo: {
          address: row.customer.email,
          subject: `Payment problem with booking ${row.booking.reference}`,
          text: [
            `Hi ${row.customer.firstName},`,
            '',
            `The payment for your booking ${row.booking.reference} did not go through.`,
            'Your booking is being held for now — please open the app and try another card.',
          ].join('\n'),
        },
      });
    },

    // ---- DEPOSITS ----
    // Kept clearly apart from payments in the wording too: a deposit is the
    // customer's money being held and given back, not something they paid.

    async depositReleased(depositId: string) {
      const [row] = await db
        .select({ deposit: deposits, booking: bookings, customer: customers })
        .from(deposits)
        .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
        .innerJoin(customers, eq(customers.id, bookings.customerId))
        .where(eq(deposits.id, depositId))
        .limit(1);
      if (!row) return;

      await notify({
        customerId: row.customer.id,
        bookingId: row.booking.id,
        kind: 'payment',
        title: 'Your deposit has been released',
        body: `The ${money(row.deposit.amountCents)} hold for booking ${row.booking.reference} has been let go. It was never charged.`,
        emailTo: {
          address: row.customer.email,
          subject: `Your deposit for ${row.booking.reference} has been released`,
          text: [
            `Hi ${row.customer.firstName},`,
            '',
            `The ${money(row.deposit.amountCents)} security deposit held for booking ${row.booking.reference} has been released.`,
            'It was only ever held on your card, never taken. Your bank may take a few days to show it as available again.',
          ].join('\n'),
        },
      });
    },

    async depositClaimed(depositId: string) {
      const [row] = await db
        .select({ deposit: deposits, booking: bookings, customer: customers })
        .from(deposits)
        .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
        .innerJoin(customers, eq(customers.id, bookings.customerId))
        .where(eq(deposits.id, depositId))
        .limit(1);
      if (!row) return;

      const kept = row.deposit.claimedAmountCents ?? row.deposit.amountCents;
      await notify({
        customerId: row.customer.id,
        bookingId: row.booking.id,
        kind: 'payment',
        title: 'Part of your deposit has been kept',
        body: `${money(kept)} of your ${money(row.deposit.amountCents)} deposit for ${row.booking.reference} has been kept.`,
        emailTo: {
          address: row.customer.email,
          subject: `About the deposit for booking ${row.booking.reference}`,
          text: [
            `Hi ${row.customer.firstName},`,
            '',
            `${money(kept)} of the ${money(row.deposit.amountCents)} security deposit held for booking ${row.booking.reference} has been kept.`,
            '',
            `Reason given: ${row.deposit.claimReason ?? 'not recorded'}`,
            '',
            'Anything not kept is released back to your card. If you disagree with this, reply to this email and we will look into it.',
          ].join('\n'),
        },
      });
    },

    // ---- REMINDERS ----
    // Run once a day by the scheduled command. Each reminder is sent once per
    // booking, so running the command twice does not message anybody twice.
    async sendTomorrowsReminders(): Promise<{ pickups: number; returns: number }> {
      const tomorrow = new Date(Date.parse(`${today()}T00:00:00Z`) + 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const [collecting, returning] = await Promise.all([
        db
          .select({ booking: bookings, customer: customers, vehicle: vehicles })
          .from(bookings)
          .innerJoin(customers, eq(customers.id, bookings.customerId))
          .innerJoin(vehicles, eq(vehicles.id, bookings.vehicleId))
          .where(and(eq(bookings.startDate, tomorrow), eq(bookings.status, 'upcoming'))),
        db
          .select({ booking: bookings, customer: customers, vehicle: vehicles })
          .from(bookings)
          .innerJoin(customers, eq(customers.id, bookings.customerId))
          .innerJoin(vehicles, eq(vehicles.id, bookings.vehicleId))
          .where(and(eq(bookings.endDate, tomorrow), eq(bookings.status, 'active'))),
      ]);

      for (const row of collecting) {
        await notify({
          customerId: row.customer.id,
          bookingId: row.booking.id,
          kind: 'pickup_reminder',
          title: 'Your rental starts tomorrow',
          body: `Collect your ${row.vehicle.make} ${row.vehicle.model} at ${row.booking.pickupTime} from ${row.booking.location}.`,
          onlyOnce: true,
        });
      }
      for (const row of returning) {
        await notify({
          customerId: row.customer.id,
          bookingId: row.booking.id,
          kind: 'return_reminder',
          title: 'Your rental ends tomorrow',
          body: `Please return your ${row.vehicle.make} ${row.vehicle.model} by ${row.booking.returnTime} to ${row.booking.location}.`,
          onlyOnce: true,
        });
      }

      return { pickups: collecting.length, returns: returning.length };
    },

    // ---- WHAT THE CUSTOMER SEES ----

    async listFor(actor: Actor) {
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.customerId, actor.customerId))
        .orderBy(desc(notifications.sentAt))
        .limit(50);

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        sentAt: row.sentAt.toISOString(),
        read: row.readAt !== null,
      }));
    },

    // Somebody else's notification is "not found", like one that never existed.
    async markRead(actor: Actor, notificationId: string) {
      if (!isUuid(notificationId)) throw notFound('We could not find that notification.');
      const marked = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.customerId, actor.customerId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });

      if (marked.length === 0) {
        // Either it is not theirs, or it was already read. Tell them apart
        // only as far as they are entitled to know.
        const [exists] = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(eq(notifications.id, notificationId), eq(notifications.customerId, actor.customerId)))
          .limit(1);
        if (!exists) throw notFound('We could not find that notification.');
      }
    },

    async markAllRead(actor: Actor) {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.customerId, actor.customerId), isNull(notifications.readAt)));
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
