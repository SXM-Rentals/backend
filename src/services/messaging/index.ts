// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Conversations between a customer and a rental business,
// held inside SXM Rentals. A customer asks "is there a child seat?", a business
// answers, and both sides have a record either can point to if there is ever a
// disagreement.
//
// WHY THE MESSAGES LIVE HERE AT ALL: it is what lets a business answer a
// customer without ever being given their phone number or email address. The
// business's view of a conversation is built from a renter summary with no
// field for either — the same rule as their view of a booking.
//
// WHO CAN SEE WHAT. A customer only ever sees threads that are theirs; a
// business only ever sees threads belonging to that business. Anything else is
// "not found", exactly like a thread that does not exist.
//
// A message is words, an attached car, or both — never neither. The database
// refuses an empty one, and an attached car has to belong to the business being
// talked to, so a thread cannot be used to advertise somebody else's fleet.

import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { bookings, chatMessages, chatThreads, customers, vehicles } from '../../db/schema/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import { toBusinessChatThread, toChatThread } from '../serializers/messaging.js';

export type NewMessage = {
  body?: string | undefined;
  vehicleId?: string | undefined;
};

// A message has to say something, or show a car.
function assertNotEmpty(input: NewMessage) {
  const body = input.body?.trim() ?? '';
  if (body.length === 0 && !input.vehicleId) {
    throw badRequest('empty_message', 'Write something, or attach a vehicle.');
  }
  return body;
}

// An attached car must belong to the business in the conversation.
async function assertVehicleBelongs(db: Database, providerId: string, vehicleId: string | undefined) {
  if (!vehicleId) return;
  if (!isUuid(vehicleId)) throw notFound('We could not find that vehicle.');
  const [vehicle] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)))
    .limit(1);
  if (!vehicle) throw notFound('We could not find that vehicle.');
}

// The booking references for a page of threads, in one query.
async function bookingRefsFor(db: Database, threads: (typeof chatThreads.$inferSelect)[]) {
  const ids = threads.map((thread) => thread.bookingId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: bookings.id, reference: bookings.reference })
    .from(bookings)
    .where(inArray(bookings.id, ids));
  return new Map(rows.map((row) => [row.id, row.reference]));
}

async function messagesFor(db: Database, threadIds: string[]) {
  if (threadIds.length === 0) return [];
  return db.select().from(chatMessages).where(inArray(chatMessages.threadId, threadIds));
}

// ================= THE CUSTOMER'S SIDE =================

export async function listThreadsForCustomer(db: Database, actor: Actor) {
  const threads = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.customerId, actor.customerId))
    .orderBy(desc(chatThreads.updatedAt));
  if (threads.length === 0) return [];

  const [messages, refs] = await Promise.all([
    messagesFor(db, threads.map((thread) => thread.id)),
    bookingRefsFor(db, threads),
  ]);

  return threads.map((thread) =>
    toChatThread(
      thread,
      messages.filter((message) => message.threadId === thread.id),
      thread.bookingId ? refs.get(thread.bookingId) : undefined,
    ),
  );
}

async function loadCustomerThread(db: Database, actor: Actor, threadId: string) {
  if (!isUuid(threadId)) throw notFound('We could not find that conversation.');
  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.customerId, actor.customerId)))
    .limit(1);
  if (!thread) throw notFound('We could not find that conversation.');
  return thread;
}

export async function getThreadForCustomer(db: Database, actor: Actor, threadId: string) {
  const thread = await loadCustomerThread(db, actor, threadId);
  const [messages, refs] = await Promise.all([messagesFor(db, [thread.id]), bookingRefsFor(db, [thread])]);
  return toChatThread(thread, messages, thread.bookingId ? refs.get(thread.bookingId) : undefined);
}

// Starting a conversation. Asking the same business again continues the
// existing conversation rather than starting a second one — unless it is about
// a particular booking, which gets its own thread.
export async function startThread(
  db: Database,
  actor: Actor,
  input: { providerId: string; bookingId?: string | undefined } & NewMessage,
) {
  const body = assertNotEmpty(input);
  if (!isUuid(input.providerId)) throw notFound('We could not find that rental business.');
  await assertVehicleBelongs(db, input.providerId, input.vehicleId);

  // A thread about a booking has to be about one of the customer's own.
  if (input.bookingId) {
    if (!isUuid(input.bookingId)) throw notFound('We could not find that booking.');
    const [booking] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.id, input.bookingId), eq(bookings.customerId, actor.customerId)))
      .limit(1);
    if (!booking) throw notFound('We could not find that booking.');
  }

  const [existing] = await db
    .select()
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.customerId, actor.customerId),
        eq(chatThreads.providerId, input.providerId),
        input.bookingId ? eq(chatThreads.bookingId, input.bookingId) : isNull(chatThreads.bookingId),
      ),
    )
    .limit(1);

  const thread =
    existing ??
    (
      await db
        .insert(chatThreads)
        .values({
          customerId: actor.customerId,
          providerId: input.providerId,
          bookingId: input.bookingId,
          vehicleId: input.vehicleId,
        })
        .returning()
    )[0]!;

  await db.insert(chatMessages).values({
    threadId: thread.id,
    sender: 'customer',
    body,
    vehicleId: input.vehicleId,
  });
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, thread.id));

  return getThreadForCustomer(db, actor, thread.id);
}

export async function replyAsCustomer(db: Database, actor: Actor, threadId: string, input: NewMessage) {
  const thread = await loadCustomerThread(db, actor, threadId);
  const body = assertNotEmpty(input);
  await assertVehicleBelongs(db, thread.providerId, input.vehicleId);

  await db.insert(chatMessages).values({
    threadId: thread.id,
    sender: 'customer',
    body,
    vehicleId: input.vehicleId,
  });
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, thread.id));

  return getThreadForCustomer(db, actor, thread.id);
}

// Reading a conversation marks the other side's messages as read.
export async function markReadAsCustomer(db: Database, actor: Actor, threadId: string) {
  const thread = await loadCustomerThread(db, actor, threadId);
  await db
    .update(chatMessages)
    .set({ readAt: new Date() })
    .where(and(eq(chatMessages.threadId, thread.id), ne(chatMessages.sender, 'customer'), isNull(chatMessages.readAt)));
}

// ================= THE RENTAL BUSINESS'S SIDE =================
// Every one of these is scoped to the business the signed-in person acts for,
// so one business can never read another's conversations.

export async function listThreadsForProvider(db: Database, providerId: string) {
  const rows = await db
    .select({ thread: chatThreads, renter: customers })
    .from(chatThreads)
    .innerJoin(customers, eq(customers.id, chatThreads.customerId))
    .where(eq(chatThreads.providerId, providerId))
    .orderBy(desc(chatThreads.updatedAt));
  if (rows.length === 0) return [];

  const threads = rows.map((row) => row.thread);
  const [messages, refs] = await Promise.all([
    messagesFor(db, threads.map((thread) => thread.id)),
    bookingRefsFor(db, threads),
  ]);

  return rows.map((row) =>
    toBusinessChatThread(
      row.thread,
      messages.filter((message) => message.threadId === row.thread.id),
      {
        firstName: row.renter.firstName,
        lastName: row.renter.lastName,
        verificationStatus: row.renter.verificationStatus,
      },
      row.thread.bookingId ? refs.get(row.thread.bookingId) : undefined,
    ),
  );
}

async function loadProviderThread(db: Database, providerId: string, threadId: string) {
  if (!isUuid(threadId)) throw notFound('We could not find that conversation.');
  const [row] = await db
    .select({ thread: chatThreads, renter: customers })
    .from(chatThreads)
    .innerJoin(customers, eq(customers.id, chatThreads.customerId))
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.providerId, providerId)))
    .limit(1);
  if (!row) throw notFound('We could not find that conversation.');
  return row;
}

export async function getThreadForProvider(db: Database, providerId: string, threadId: string) {
  const row = await loadProviderThread(db, providerId, threadId);
  const [messages, refs] = await Promise.all([messagesFor(db, [row.thread.id]), bookingRefsFor(db, [row.thread])]);
  return toBusinessChatThread(
    row.thread,
    messages,
    {
      firstName: row.renter.firstName,
      lastName: row.renter.lastName,
      verificationStatus: row.renter.verificationStatus,
    },
    row.thread.bookingId ? refs.get(row.thread.bookingId) : undefined,
  );
}

export async function replyAsProvider(db: Database, providerId: string, threadId: string, input: NewMessage) {
  const row = await loadProviderThread(db, providerId, threadId);
  const body = assertNotEmpty(input);
  await assertVehicleBelongs(db, providerId, input.vehicleId);

  await db.insert(chatMessages).values({
    threadId: row.thread.id,
    sender: 'provider',
    body,
    vehicleId: input.vehicleId,
  });
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, row.thread.id));

  return getThreadForProvider(db, providerId, row.thread.id);
}

export async function markReadAsProvider(db: Database, providerId: string, threadId: string) {
  const row = await loadProviderThread(db, providerId, threadId);
  await db
    .update(chatMessages)
    .set({ readAt: new Date() })
    .where(
      and(eq(chatMessages.threadId, row.thread.id), eq(chatMessages.sender, 'customer'), isNull(chatMessages.readAt)),
    );
}
