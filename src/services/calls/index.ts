// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Calls inside the app between a renter and a rental
// business, carried by Twilio, so nobody opens the phone's own dialler and no
// phone number ever changes hands.
//
// HOW A CALL GOES:
//   1. POST /calls — the caller's phone gets a token for one call; the other
//      side's phones are told a call is coming (a push, carrying the call's id
//      and the caller's display name only — never a number).
//   2. The caller's calling kit connects to Twilio with the call's id. Twilio
//      asks us who to ring (POST /calls/twiml, signed by Twilio) and we answer
//      with the other side: the renter, or every member of the business, so
//      whoever is free picks up.
//   3. Answer, decline or end, from either phone. Twilio also tells us how the
//      call finished (POST /calls/:id/dial-status).
//   4. A line goes into the conversation — "Call, 3 min" or "Missed call" — so
//      both sides can see it happened. THE CALL ITSELF IS NOT RECORDED: no audio
//      is kept anywhere.
//
// Only the two sides of a conversation can call each other; anybody else's
// conversation is "not found". A few calls a minute at most, so nobody can ring
// somebody over and over.

import { and, count, eq, gte, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { calls, chatMessages, chatThreads, customers, providerMembers, providers } from '../../db/schema/index.js';
import { AppError, conflict, notFound, tooManyRequests } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import type { TwilioClient } from '../../lib/twilio.js';
import type { PushService } from '../push/index.js';
import { renterDisplayName } from '../serializers/bookings.js';

// How long a call token lasts. Long enough for a long call; Twilio keeps a call
// going past the token's end once it has connected.
const TOKEN_SECONDS = 60 * 60;
// How long a call rings before it counts as missed.
export const RING_SECONDS = 30;
// Calls one person may start in a minute.
const CALLS_PER_MINUTE = 5;

type Side = 'customer' | 'provider';
type CallRow = typeof calls.$inferSelect;

// Twilio's name for a person: letters, digits and underscores only, and nothing
// that identifies them outside SXM Rentals.
export const identityOf = (customerId: string) => `u_${customerId.replace(/-/g, '')}`;
export function customerIdOf(identity: string): string | null {
  const hex = identity.replace(/^client:/, '').match(/^u_([0-9a-f]{32})$/)?.[1];
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
}

export type CallDeps = { db: Database; twilio: TwilioClient; push: PushService };

export function createCallService(deps: CallDeps) {
  const { db, twilio, push } = deps;

  // Which side of this conversation the person is on — or "not found".
  async function sideOf(actor: Actor, threadId: string) {
    if (!isUuid(threadId)) throw notFound('We could not find that conversation.');
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, threadId)).limit(1);
    if (!thread) throw notFound('We could not find that conversation.');
    if (thread.customerId === actor.customerId) return { thread, side: 'customer' as Side };
    const [member] = await db
      .select({ id: providerMembers.customerId })
      .from(providerMembers)
      .innerJoin(providers, eq(providers.id, providerMembers.providerId))
      .where(and(eq(providerMembers.providerId, thread.providerId), eq(providerMembers.customerId, actor.customerId)))
      .limit(1);
    if (member) return { thread, side: 'provider' as Side };
    throw notFound('We could not find that conversation.');
  }

  // Everybody on one side of a conversation: the renter, or the business's members.
  async function peopleOn(thread: typeof chatThreads.$inferSelect, side: Side): Promise<string[]> {
    if (side === 'customer') return [thread.customerId];
    const rows = await db
      .select({ id: providerMembers.customerId })
      .from(providerMembers)
      .where(eq(providerMembers.providerId, thread.providerId));
    return rows.map((row) => row.id);
  }

  // What the other side is shown: the business's name, or the renter's first
  // name and initial — the same as everywhere else. Never a number.
  async function displayName(thread: typeof chatThreads.$inferSelect, side: Side): Promise<string> {
    if (side === 'provider') {
      const [row] = await db.select({ name: providers.businessName }).from(providers).where(eq(providers.id, thread.providerId)).limit(1);
      return row?.name ?? 'A rental business';
    }
    const [row] = await db
      .select({ firstName: customers.firstName, lastName: customers.lastName })
      .from(customers)
      .where(eq(customers.id, thread.customerId))
      .limit(1);
    return row ? renterDisplayName(row.firstName, row.lastName) : 'A renter';
  }

  async function loadCall(callId: string) {
    if (!isUuid(callId)) throw notFound('We could not find that call.');
    const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    if (!call) throw notFound('We could not find that call.');
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, call.threadId)).limit(1);
    return { call, thread: thread! };
  }

  // Finishing a call, once: its status, and the line in the conversation.
  async function finish(call: CallRow, outcome: 'ended' | 'missed' | 'declined', durationSeconds?: number) {
    const [done] = await db
      .update(calls)
      .set({ status: outcome, endedAt: new Date() })
      // Only a call still going: whichever of the phones and Twilio gets here
      // first finishes it, and the others change nothing.
      .where(and(eq(calls.id, call.id), inArray(calls.status, ['ringing', 'answered'])))
      .returning();
    if (!done) return;

    const seconds =
      durationSeconds ?? (done.answeredAt ? Math.round((done.endedAt!.getTime() - done.answeredAt.getTime()) / 1000) : 0);
    const talked = outcome === 'ended' && done.answeredAt !== null;
    const body = talked ? `Call, ${Math.max(1, Math.ceil(seconds / 60))} min` : 'Missed call';
    await db.insert(chatMessages).values({ threadId: done.threadId, sender: done.callerSide, body });
    await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, done.threadId));
  }

  const isOver = (call: CallRow) => call.status !== 'ringing' && call.status !== 'answered';

  return {
    // ---- 1. CALLING ----
    async start(actor: Actor, threadId: string, platform?: 'ios' | 'android') {
      const { thread, side } = await sideOf(actor, threadId);

      const [recent] = await db
        .select({ value: count() })
        .from(calls)
        .where(and(eq(calls.callerId, actor.customerId), gte(calls.createdAt, new Date(Date.now() - 60_000))));
      if ((recent?.value ?? 0) >= CALLS_PER_MINUTE) {
        throw tooManyRequests(60, 'That is a lot of calls in a minute. Please wait a moment, or send a message.');
      }

      const [call] = await db.insert(calls).values({ threadId: thread.id, callerSide: side, callerId: actor.customerId }).returning();
      const otherSide: Side = side === 'customer' ? 'provider' : 'customer';
      const from = await displayName(thread, side);
      for (const person of await peopleOn(thread, otherSide)) {
        if (person === actor.customerId) continue;
        await push.sendToCustomer(person, {
          category: 'messages',
          title: 'Incoming call',
          body: `${from} is calling you on SXM Rentals.`,
          data: { type: 'call', id: call!.id, callId: call!.id, from },
        });
      }

      return {
        callId: call!.id,
        provider: 'twilio' as const,
        token: twilio.accessToken(identityOf(actor.customerId), { ttlSeconds: TOKEN_SECONDS, platform }),
        // Twilio's calling kit finds its own servers; there is no address to give.
        serverUrl: null,
        expiresAt: new Date(Date.now() + TOKEN_SECONDS * 1000).toISOString(),
      };
    },

    // A token for this phone's calling kit to register for incoming calls, so a
    // call can ring even while the app is closed.
    async register(actor: Actor, platform: 'ios' | 'android') {
      return {
        provider: 'twilio' as const,
        identity: identityOf(actor.customerId),
        token: twilio.accessToken(identityOf(actor.customerId), { ttlSeconds: TOKEN_SECONDS, platform }),
        expiresAt: new Date(Date.now() + TOKEN_SECONDS * 1000).toISOString(),
      };
    },

    // ---- 3. ANSWERING, DECLINING, ENDING ----
    async answer(actor: Actor, callId: string, platform?: 'ios' | 'android') {
      const { call, thread } = await loadCall(callId);
      const { side } = await sideOf(actor, thread.id);
      if (side === call.callerSide) throw notFound('We could not find that call.');
      // Rang out long ago without anybody hearing back from Twilio: missed.
      if (call.status === 'ringing' && Date.now() - call.createdAt.getTime() > (RING_SECONDS + 60) * 1000) {
        await finish(call, 'missed');
        throw conflict('call_over', 'That call has already finished.');
      }
      if (isOver(call)) throw conflict('call_over', 'That call has already finished.');
      if (call.status === 'answered' && call.answeredBy !== actor.customerId) {
        throw conflict('answered_elsewhere', 'Somebody else from the business has answered.');
      }
      await db
        .update(calls)
        .set({ status: 'answered', answeredAt: call.answeredAt ?? new Date(), answeredBy: actor.customerId })
        .where(eq(calls.id, call.id));
      return {
        token: twilio.accessToken(identityOf(actor.customerId), { ttlSeconds: TOKEN_SECONDS, platform }),
        serverUrl: null,
      };
    },

    async decline(actor: Actor, callId: string) {
      const { call, thread } = await loadCall(callId);
      const { side } = await sideOf(actor, thread.id);
      if (side === call.callerSide) throw notFound('We could not find that call.');
      if (call.status === 'ringing') await finish(call, 'declined');
    },

    // Either side hangs up. Before anybody answered, it was a missed call.
    async end(actor: Actor, callId: string) {
      const { call, thread } = await loadCall(callId);
      await sideOf(actor, thread.id);
      if (!isOver(call)) await finish(call, call.status === 'answered' ? 'ended' : 'missed');
    },

    // ---- 2. TWILIO ASKS WHO TO RING ----
    // Answered with TwiML. The caller must be who the call says it is, and the
    // call must still be ringing; otherwise it is turned away.
    async whoToRing(params: Record<string, string>, statusUrl: (callId: string) => string): Promise<string> {
      const reject = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';
      const callId = params.callId ?? '';
      if (!isUuid(callId)) return reject;
      const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
      if (!call || call.status !== 'ringing' || customerIdOf(params.From ?? '') !== call.callerId) return reject;
      const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, call.threadId)).limit(1);
      const otherSide: Side = call.callerSide === 'customer' ? 'provider' : 'customer';
      const clients = (await peopleOn(thread!, otherSide))
        .filter((person) => person !== call.callerId)
        .map((person) => `<Client>${identityOf(person)}</Client>`)
        .join('');
      if (!clients) return reject;
      return (
        '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        `<Dial timeout="${RING_SECONDS}" answerOnBridge="true" action="${statusUrl(call.id)}">${clients}</Dial>` +
        '</Response>'
      );
    },

    // ---- TWILIO SAYS HOW IT FINISHED ----
    async dialFinished(callId: string, params: Record<string, string>) {
      if (!isUuid(callId)) return;
      const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
      if (!call) return;
      const seconds = Number(params.DialCallDuration ?? '0') || 0;
      if (params.DialCallStatus === 'completed' && seconds > 0) {
        if (!call.answeredAt) {
          await db
            .update(calls)
            .set({ answeredAt: new Date(Date.now() - seconds * 1000) })
            .where(eq(calls.id, call.id));
        }
        const [fresh] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
        await finish(fresh!, 'ended', seconds);
      } else {
        await finish(call, 'missed');
      }
    },
  };
}

export type CallService = ReturnType<typeof createCallService>;

// Guards the Twilio addresses: a request that is not signed by Twilio changes
// nothing and learns nothing.
export function notFromTwilio(): AppError {
  return new AppError(403, 'forbidden', 'That request did not come from Twilio.');
}
