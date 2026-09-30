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
import { buildEmail, type EmailBrand, type EmailContent } from '../../lib/email-templates.js';
import { notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import { today } from '../availability-engine/index.js';
import type { PushCategory, PushService } from '../push/index.js';

// Which of a person's six choices each kind of notification falls under.
const CATEGORY_BY_KIND: Record<NotificationKind, PushCategory> = {
  booking_confirmed: 'bookings',
  cancellation: 'bookings',
  verification: 'bookings',
  pickup_reminder: 'pickupReminders',
  return_reminder: 'returnReminders',
  late_return: 'returnReminders',
  payment: 'deposits',
  promotion: 'offers',
};

type Logger = { error: (obj: object, msg: string) => void };

export type NotificationServiceDeps = {
  db: Database;
  email: EmailSender;
  logger: Logger;
  // The website address and logo the emails are drawn with.
  brand: EmailBrand;
  // Phones. Left out, nothing is pushed — the notification list and the email
  // still happen exactly as before.
  push?: PushService;
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
  const { db, email, logger, brand, push } = deps;

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
    // Only set for the messages that genuinely warrant an email. The content is
    // drawn by lib/email-templates.ts, so every email looks like SXM Rentals.
    emailTo?: { address: string; subject: string; content: EmailContent } | undefined;
    // When set, the same kind of message about the same booking is only ever
    // sent once.
    onlyOnce?: boolean;
    // Which choice it falls under, when not the one its kind suggests.
    pushCategory?: PushCategory;
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

      const [saved] = await db
        .insert(notifications)
        .values({
          customerId: input.customerId,
          bookingId: input.bookingId,
          kind: input.kind,
          title: input.title,
          body: input.body,
        })
        .returning({ id: notifications.id });

      // AND TO THEIR PHONE, where they chose to hear about this kind of thing.
      // A push shows on a locked screen, so one whose words mention money says
      // "open the app" instead: an amount never appears there.
      if (push && saved) {
        await push.sendToCustomer(input.customerId, {
          category: input.pushCategory ?? CATEGORY_BY_KIND[input.kind],
          title: input.title,
          body: input.body.includes('$') ? 'Open SXM Rentals for the details.' : input.body,
          data: input.bookingId ? { type: 'booking', id: input.bookingId } : { type: 'notification', id: saved.id },
        });
      }

      if (input.emailTo) {
        email
          .send(buildEmail(input.emailTo.address, input.emailTo.subject, input.emailTo.content, brand))
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
      // Its owners get a push of their own: the car and the date, nothing about
      // the renter.
      await push?.bookingForBusiness(bookingId);
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
          content: {
            preheader: `${car}, ${row.booking.startDate} to ${row.booking.endDate}.`,
            title: 'Your booking is confirmed',
            paragraphs: [
              `Hi ${row.customer.firstName},`,
              `Your ${car} is booked from ${row.booking.startDate} to ${row.booking.endDate}.`,
              `Collection: ${row.booking.pickupTime} at ${row.booking.location}.`,
              `Total for the rental: ${money(row.booking.totalDueTodayCents)}.`,
            ],
            button: { label: 'View my booking', url: `${brand.siteUrl}/account/rentals` },
            note: 'A security deposit is held separately on your card just before collection and given back after the car is returned. It is not part of the total above.',
          },
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
          content: {
            preheader: 'Your booking has been cancelled and any deposit released.',
            title: 'Your booking is cancelled',
            paragraphs: [
              `Hi ${row.customer.firstName},`,
              `Your booking for the ${row.vehicle.make} ${row.vehicle.model} (${row.booking.startDate} to ${row.booking.endDate}) has been cancelled.`,
            ],
            button: { label: 'Find another car', url: `${brand.siteUrl}/search` },
            note: 'Any deposit held for it is released back to your card. It was only ever held, never taken.',
          },
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
        pushCategory: 'bookings',
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
        pushCategory: 'bookings',
        title: 'Payment did not go through',
        body: `The payment for booking ${row.booking.reference} was declined. Please try another card.`,
        emailTo: {
          address: row.customer.email,
          subject: `Payment problem with booking ${row.booking.reference}`,
          content: {
            preheader: 'Your card was declined — your booking is still being held.',
            title: 'Payment did not go through',
            paragraphs: [
              `Hi ${row.customer.firstName},`,
              `The payment for your booking ${row.booking.reference} was declined.`,
              'Your booking is being held for now. Please try another card.',
            ],
            button: { label: 'Try another card', url: `${brand.siteUrl}/account/rentals` },
          },
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
          content: {
            preheader: `${money(row.deposit.amountCents)} released — it was never charged.`,
            title: 'Your deposit has been released',
            paragraphs: [
              `Hi ${row.customer.firstName},`,
              `The ${money(row.deposit.amountCents)} security deposit held for booking ${row.booking.reference} has been released.`,
              'It was only ever held on your card, never taken.',
            ],
            note: 'Your bank may take a few days to show it as available again.',
          },
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
          content: {
            preheader: `${money(kept)} of your deposit has been kept — here is why.`,
            title: 'About your deposit',
            paragraphs: [
              `Hi ${row.customer.firstName},`,
              `${money(kept)} of the ${money(row.deposit.amountCents)} security deposit held for booking ${row.booking.reference} has been kept.`,
              `Reason given: ${row.deposit.claimReason ?? 'not recorded'}`,
              'Anything not kept is released back to your card.',
            ],
            note: 'If you disagree with this, reply to this email and we will look into it.',
          },
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
