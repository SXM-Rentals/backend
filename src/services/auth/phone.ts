// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Signing in with a code sent by text message, and
// confirming the phone number on an account the same way.
//
// IT SIGNS IN TO AN ACCOUNT THAT ALREADY EXISTS, through a phone number its
// owner has CONFIRMED. It never creates an account: joining stays email and
// password, so every account still has an email for receipts and closing. A
// number typed into a profile and never confirmed does not count.
//
// WHAT KEEPS IT SAFE:
//   - the answer to "send a code" is the same whether or not an account has
//     that number, and a code is only actually sent when one does — otherwise
//     this would tell anybody who is a customer;
//   - 6 digits, 10 minutes, 5 tries; a new code cancels the old one; only a
//     hash of the code is kept;
//   - limits on how many texts go out (every one is paid for): per number 3 in
//     15 minutes, 10 a day, and one a minute; per IP address 20 a day. They are
//     counted whether or not a text was really sent, so trying numbers costs
//     the same as using a real one;
//   - the text says the code, "SXM Rentals", and that we never ask for it. No
//     link and no name.
//
// A sign-in by text is an ordinary session: it shows in "Where you're signed
// in", a closed account is refused, and it is logged like any other sign-in.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gte, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { customers, phoneChallenges } from '../../db/schema/index.js';
import { AppError, badRequest, tooManyRequests } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import type { TwilioClient } from '../../lib/twilio.js';
import { toUser } from '../serializers/customer.js';
import { createSession, type ClientInfo } from './sessions.js';

export const CODE_LENGTH = 6;
const CODE_MINUTES = 10;
const MAX_TRIES = 5;
export const RESEND_AFTER_SECONDS = 60;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type PhonePurpose = 'sign_in' | 'confirm_phone';

// "+1 (721) 555-1234" → "+17215551234". Null when it cannot be a real number:
// a plus, a country code, and 8 to 15 digits in all.
export function normalisePhone(value: string): string | null {
  const compact = value.trim().replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

const hashCode = (challengeId: string, code: string) => createHash('sha256').update(`${challengeId}:${code}`).digest();

export type PhoneDeps = {
  db: Database;
  twilio: TwilioClient;
  logger: { info: (details: object, message: string) => void; warn: (details: object, message: string) => void };
};

export function createPhoneSignInService(deps: PhoneDeps) {
  const { db, twilio, logger } = deps;

  // The open account whose owner confirmed this number.
  async function accountFor(phone: string) {
    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.phone, phone), isNotNull(customers.phoneVerifiedAt), isNull(customers.deletedAt)))
      .limit(1);
    return customer;
  }

  // The limits, in the order a person would hit them.
  async function assertWithinLimits(phone: string, ipAddress: string | undefined) {
    const now = Date.now();
    const since = (ms: number) => new Date(now - ms);
    const countFor = async (where: ReturnType<typeof and>) =>
      (await db.select({ value: count() }).from(phoneChallenges).where(where))[0]?.value ?? 0;

    const [latest] = await db
      .select({ createdAt: phoneChallenges.createdAt })
      .from(phoneChallenges)
      .where(and(eq(phoneChallenges.phone, phone), gte(phoneChallenges.createdAt, since(RESEND_AFTER_SECONDS * 1000))))
      .limit(1);
    if (latest) {
      const wait = Math.ceil((latest.createdAt.getTime() + RESEND_AFTER_SECONDS * 1000 - now) / 1000);
      throw tooManyRequests(wait, `A code was just sent. You can ask for a new one in ${wait} seconds.`);
    }
    if ((await countFor(and(eq(phoneChallenges.phone, phone), gte(phoneChallenges.createdAt, since(15 * MINUTE))))) >= 3) {
      throw tooManyRequests(15 * 60, 'Three codes have been sent to this number in the last 15 minutes. Please wait a little.');
    }
    if ((await countFor(and(eq(phoneChallenges.phone, phone), gte(phoneChallenges.createdAt, since(DAY))))) >= 10) {
      throw tooManyRequests(60 * 60, 'Too many codes have been sent to this number today. Please sign in with your email.');
    }
    if (ipAddress && (await countFor(and(eq(phoneChallenges.ipAddress, ipAddress), gte(phoneChallenges.createdAt, since(DAY))))) >= 20) {
      throw tooManyRequests(60 * 60, 'Too many codes have been asked for from here today. Please sign in with your email.');
    }
  }

  return {
    // ---- 1. SENDING A CODE ----
    async start(input: { phone: string; purpose: PhonePurpose; actor: Actor | null; ipAddress?: string | undefined }) {
      const phone = normalisePhone(input.phone);
      if (!phone) throw badRequest('invalid_phone', 'That is not a phone number we can text. Include the country code, like +1 721 555 1234.');
      if (input.purpose === 'confirm_phone' && !input.actor) {
        throw new AppError(401, 'unauthorized', 'Please sign in to confirm a phone number.');
      }
      await assertWithinLimits(phone, input.ipAddress);

      // Who the code is for: the signed-in person confirming their number, or
      // the account that confirmed this number before.
      const customerId =
        input.purpose === 'confirm_phone' ? input.actor!.customerId : ((await accountFor(phone))?.id ?? null);

      // A new code cancels any still open for this number.
      await db
        .update(phoneChallenges)
        .set({ cancelledAt: new Date() })
        .where(and(eq(phoneChallenges.phone, phone), isNull(phoneChallenges.usedAt), isNull(phoneChallenges.cancelledAt)));

      const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
      const expiresAt = new Date(Date.now() + CODE_MINUTES * MINUTE);
      const [challenge] = await db
        .insert(phoneChallenges)
        .values({ phone, purpose: input.purpose, customerId, codeHash: '', expiresAt, ipAddress: input.ipAddress ?? null })
        .returning({ id: phoneChallenges.id });
      await db
        .update(phoneChallenges)
        .set({ codeHash: hashCode(challenge!.id, code).toString('hex') })
        .where(eq(phoneChallenges.id, challenge!.id));

      // Only a number with an account (or one being confirmed) is texted.
      if (customerId) {
        try {
          await twilio.sendSms(phone, `${code} is your SXM Rentals code. SXM Rentals will never ask you for it.`);
        } catch (error) {
          logger.warn({ challengeId: challenge!.id, error: String(error) }, 'Could not send a sign-in code');
          // Confirming is the signed-in person's own number: they can be told.
          // Signing in gets the same answer as always, so nothing leaks.
          if (input.purpose === 'confirm_phone') {
            throw new AppError(502, 'sms_failed', 'We could not send a text to that number just now. Please try again.');
          }
        }
      }

      return {
        challengeId: challenge!.id,
        expiresAt: expiresAt.toISOString(),
        resendAfterSeconds: RESEND_AFTER_SECONDS,
        codeLength: CODE_LENGTH,
      };
    },

    // ---- 2. CHECKING THE CODE ----
    async verify(input: {
      challengeId: string;
      code: string;
      purpose: PhonePurpose;
      actor: Actor | null;
      client: ClientInfo;
    }) {
      const expired = () => new AppError(400, 'code_expired', 'That code has expired. Ask for a new one.');
      if (!isUuid(input.challengeId)) throw expired();
      const [challenge] = await db.select().from(phoneChallenges).where(eq(phoneChallenges.id, input.challengeId)).limit(1);
      if (!challenge || challenge.purpose !== input.purpose || challenge.usedAt || challenge.cancelledAt) throw expired();
      if (challenge.expiresAt.getTime() <= Date.now()) throw expired();
      if (challenge.attempts >= MAX_TRIES) {
        throw new AppError(400, 'too_many_tries', 'That code has been tried too many times. Ask for a new one.');
      }

      const given = hashCode(challenge.id, input.code.trim());
      const stored = Buffer.from(challenge.codeHash, 'hex');
      if (stored.length !== given.length || !timingSafeEqual(stored, given)) {
        const [updated] = await db
          .update(phoneChallenges)
          .set({ attempts: challenge.attempts + 1 })
          .where(eq(phoneChallenges.id, challenge.id))
          .returning({ attempts: phoneChallenges.attempts });
        const left = MAX_TRIES - (updated?.attempts ?? MAX_TRIES);
        if (left <= 0) throw new AppError(400, 'too_many_tries', 'That code has been tried too many times. Ask for a new one.');
        throw new AppError(
          400,
          'invalid_code',
          `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
          { triesLeft: left },
        );
      }

      // Used once, and only once — even by two requests at the same moment.
      const [claimed] = await db
        .update(phoneChallenges)
        .set({ usedAt: new Date() })
        .where(and(eq(phoneChallenges.id, challenge.id), isNull(phoneChallenges.usedAt)))
        .returning({ id: phoneChallenges.id });
      if (!claimed) throw expired();

      if (challenge.purpose === 'confirm_phone') {
        if (!input.actor || input.actor.customerId !== challenge.customerId) throw expired();
        // Somebody holding the phone proves it is theirs now. A number reused by
        // the phone company stops signing in to whoever had it before.
        await db
          .update(customers)
          .set({ phoneVerifiedAt: null })
          .where(and(eq(customers.phone, challenge.phone), ne(customers.id, input.actor.customerId)));
        const [updated] = await db
          .update(customers)
          .set({ phone: challenge.phone, phoneVerifiedAt: new Date() })
          .where(eq(customers.id, input.actor.customerId))
          .returning();
        return { user: toUser(updated!) };
      }

      // Signing in. Only somebody holding the phone gets this far, and this
      // tells them only about their own number.
      const customer = await accountFor(challenge.phone);
      if (!customer) {
        throw new AppError(404, 'no_account', 'There is no account with this phone number. You can join with your email.');
      }
      const session = await createSession(db, customer.id, input.client);
      logger.info({ customerId: customer.id, method: 'phone' }, 'Signed in');
      return { user: toUser(customer), session };
    },
  };
}

export type PhoneSignInService = ReturnType<typeof createPhoneSignInService>;
