// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: All the account and sign-in business logic, kept apart
// from the web routes so the website, the phone app and (later) webhooks all
// go through exactly the same rules:
//
//   - creating an account and verifying the email address
//   - signing in, with a lock that grows longer after repeated wrong passwords
//   - signing out of one device or of every device
//   - "forgot my password" and resetting it through an emailed link
//   - changing a password while signed in
//
// Deliberate choices a security reviewer will look for:
//   - Nothing here ever reveals whether an email address has an account. Sign
//     up, "resend my link" and "forgot password" answer the same way either
//     way, and a sign-in for an unknown email takes as long as a real one.
//   - Emailed link codes work once, expire, and only their fingerprint is kept.
//   - Resetting or changing a password signs the account out everywhere.
//   - Passwords known from data breaches are refused.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import {
  authTokens,
  bookings,
  credentials,
  customers,
  deposits,
  providerMembers,
  providers,
} from '../../db/schema/index.js';
import { anonymisedCustomer } from '../../lib/anonymise.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import type { EmailMessage, EmailSender } from '../../lib/email.js';
import { buildEmail } from '../../lib/email-templates.js';
import { AppError, badRequest, conflict, notFound, tooManyRequests, unauthorized } from '../../lib/errors.js';
import { isUuid, type Actor } from '../../lib/ownership.js';
import {
  getDummyPasswordHash,
  hashPassword,
  verifyPassword,
  type BreachedPasswordChecker,
} from '../../lib/passwords.js';
import type { User } from '../../types/api.js';
import { toUser } from '../serializers/customer.js';
import {
  createSession,
  listActiveSessions,
  revokeAllSessions,
  revokeSession,
  type ClientInfo,
  type NewSession,
} from './sessions.js';

// ---- THE RULES, IN NUMBERS ----
const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000; // verification link: 24 hours
const RESET_PASSWORD_TTL_MS = 30 * 60 * 1000; // reset link: 30 minutes
const LOCK_AFTER_FAILURES = 5; // wrong passwords in a row before locking
const MAX_LOCK_MINUTES = 60; // the lock never grows past an hour

type Logger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

export type AuthServiceDeps = {
  db: Database;
  config: Config;
  email: EmailSender;
  breachedPasswords: BreachedPasswordChecker;
  logger: Logger;
};

export type SignupInput = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  accountType: 'local' | 'tourist';
  phone?: string | undefined;
};

// Emails are compared without regard to capitals or stray spaces.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Postgres's "that value already exists" error, however the driver wraps it.
function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

// The same answer for a wrong password and an unknown email, on purpose.
const invalidCredentials = () => new AppError(401, 'invalid_credentials', 'That email and password do not match.');
const invalidLink = () =>
  badRequest('invalid_or_expired_link', 'This link is no longer valid. Please request a new one.');

export function createAuthService(deps: AuthServiceDeps) {
  const { db, config, email, breachedPasswords, logger } = deps;

  // The logo and website address every email is drawn with.
  const brand = { siteUrl: config.appUrl, logoUrl: config.emailLogoUrl, social: config.socialAccounts };

  // ---- SMALL HELPERS ----

  // Sends an email without making the person wait for it — which also keeps
  // "account exists" and "account doesn't exist" answers equally fast.
  function sendInBackground(message: EmailMessage) {
    email.send(message).catch((error: unknown) => logger.error({ err: error }, 'Email could not be sent'));
  }

  async function assertPasswordNotBreached(password: string) {
    if (await breachedPasswords.isBreached(password)) {
      throw badRequest(
        'password_breached',
        'This password has appeared in a known data breach, so it is not safe to use. Please choose a different one.',
      );
    }
  }

  // Creates a single-use link code and returns the code itself (to email).
  async function issueLinkToken(tx: Database, customerId: string, purpose: 'verify_email' | 'reset_password') {
    const token = generateToken();
    const ttl = purpose === 'verify_email' ? VERIFY_EMAIL_TTL_MS : RESET_PASSWORD_TTL_MS;
    // Any earlier unused link for the same purpose stops working.
    await tx
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(authTokens.customerId, customerId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));
    await tx.insert(authTokens).values({
      customerId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttl),
    });
    return token;
  }

  // Uses up a link code in one step: it only succeeds if the code is real,
  // unused and unexpired, and marks it used at the same moment — so two
  // clicks at once cannot both succeed. Returns whose code it was, or null.
  async function consumeLinkToken(
    tx: Database,
    token: string,
    purpose: 'verify_email' | 'reset_password',
  ): Promise<string | null> {
    if (token.length < 32 || token.length > 128) return null;
    const [row] = await tx
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(authTokens.tokenHash, hashToken(token)),
          eq(authTokens.purpose, purpose),
          isNull(authTokens.usedAt),
          sql`${authTokens.expiresAt} > now()`,
        ),
      )
      .returning({ customerId: authTokens.customerId });
    return row?.customerId ?? null;
  }

  // An open (not closed) account and its password record, by email.
  async function findAccountByEmail(emailAddress: string) {
    const [row] = await db
      .select({ customer: customers, credential: credentials })
      .from(customers)
      .innerJoin(credentials, eq(credentials.customerId, customers.id))
      .where(and(eq(customers.email, emailAddress), isNull(customers.deletedAt)))
      .limit(1);
    return row;
  }

  function verificationEmail(to: string, firstName: string, token: string): EmailMessage {
    return buildEmail(
      to,
      'Confirm your email for SXM Rentals',
      {
        preheader: 'One tap to confirm your email and start booking.',
        title: 'Confirm your email',
        paragraphs: [
          `Hi ${firstName},`,
          'Please confirm this is your email address. Then you can sign in and book a car.',
        ],
        button: { label: 'Confirm my email', url: `${config.appUrl}/verify-email?token=${token}` },
        note: 'This link works once and expires in 24 hours. If you did not create an account, you can ignore this email.',
      },
      brand,
    );
  }

  function passwordChangedEmail(to: string, firstName: string): EmailMessage {
    return buildEmail(
      to,
      'Your SXM Rentals password was changed',
      {
        preheader: 'Your password changed and every device was signed out.',
        title: 'Your password was changed',
        paragraphs: [
          `Hi ${firstName},`,
          'The password for your SXM Rentals account was just changed, and every device was signed out.',
        ],
        button: { label: 'This was not me', url: `${config.appUrl}/forgot-password` },
        note: 'If you made this change, there is nothing to do.',
      },
      brand,
    );
  }

  function accountClosedEmail(to: string, firstName: string): EmailMessage {
    return buildEmail(
      to,
      'Your SXM Rentals account is closed',
      {
        preheader: 'Your account is closed and every device is signed out.',
        title: 'Your account is closed',
        paragraphs: [
          `Hi ${firstName},`,
          'Your SXM Rentals account is closed and every device has been signed out. Nobody can sign in with this email address any more.',
          'Your past rentals are kept, because the businesses you rented from and our own records have to account for them. Nothing further will be charged.',
        ],
        note: 'Changed your mind? Write to us and we can talk about opening it again.',
      },
      brand,
    );
  }

  // ---- THE ACCOUNT FLOWS ----
  return {
    // Creating an account. Answers the same whether or not the email is taken;
    // if it is, the real owner gets an email saying someone tried.
    async signup(input: SignupInput): Promise<void> {
      const emailAddress = normalizeEmail(input.email);
      await assertPasswordNotBreached(input.password);
      // Hashed before checking the email, so both paths take the same time.
      const passwordHash = await hashPassword(input.password);

      const alreadyRegistered = async () => {
        sendInBackground(
          buildEmail(
            emailAddress,
            'Someone tried to create an SXM Rentals account with your email',
            {
              preheader: 'Your account already exists — nothing has changed.',
              title: 'You already have an account',
              paragraphs: [
                'Someone tried to create a new SXM Rentals account using this email address, which already has one.',
                'If it was you, just sign in instead. If you have forgotten your password, you can reset it.',
              ],
              // /login, not /sign-in: the website answers both, but /sign-in is
              // a redirect, and a link in an email should arrive where it means
              // to go the first time.
              button: { label: 'Sign in', url: `${config.appUrl}/login` },
              note: `Forgotten your password? ${config.appUrl}/forgot-password — if this was not you, you can ignore this email. Your account has not been changed.`,
            },
            brand,
          ),
        );
      };

      if (await findAccountByEmail(emailAddress)) return alreadyRegistered();

      try {
        const token = await db.transaction(async (tx) => {
          const [customer] = await tx
            .insert(customers)
            .values({
              firstName: input.firstName,
              lastName: input.lastName,
              email: emailAddress,
              phone: input.phone,
              accountType: input.accountType,
            })
            .returning({ id: customers.id });
          if (!customer) throw new Error('Customer was not created');
          await tx.insert(credentials).values({ customerId: customer.id, passwordHash });
          return issueLinkToken(tx, customer.id, 'verify_email');
        });
        sendInBackground(verificationEmail(emailAddress, input.firstName, token));
      } catch (error) {
        // Two sign-ups for the same email at the same instant.
        if (isUniqueViolation(error)) return alreadyRegistered();
        throw error;
      }
    },

    // Opening the link in the verification email.
    async verifyEmail(token: string): Promise<void> {
      const verified = await db.transaction(async (tx) => {
        const customerId = await consumeLinkToken(tx, token, 'verify_email');
        if (!customerId) return false;
        await tx
          .update(credentials)
          .set({ emailVerifiedAt: new Date() })
          .where(and(eq(credentials.customerId, customerId), isNull(credentials.emailVerifiedAt)));
        return true;
      });
      if (!verified) throw invalidLink();
    },

    // "Send me a new verification link." Silent if there is nothing to send.
    async resendVerification(emailAddressInput: string): Promise<void> {
      const account = await findAccountByEmail(normalizeEmail(emailAddressInput));
      if (!account || account.credential.emailVerifiedAt) return;
      const token = await db.transaction((tx) => issueLinkToken(tx, account.customer.id, 'verify_email'));
      sendInBackground(verificationEmail(account.customer.email, account.customer.firstName, token));
    },

    // Signing in.
    async login(input: { email: string; password: string }, client: ClientInfo): Promise<{ user: User; session: NewSession }> {
      const account = await findAccountByEmail(normalizeEmail(input.email));

      // Unknown email: still do the slow password check so the timing matches.
      if (!account) {
        await verifyPassword(await getDummyPasswordHash(), input.password);
        throw invalidCredentials();
      }

      const { customer, credential } = account;
      const now = Date.now();

      // Locked after too many wrong passwords.
      if (credential.lockedUntil && credential.lockedUntil.getTime() > now) {
        const seconds = Math.ceil((credential.lockedUntil.getTime() - now) / 1000);
        throw tooManyRequests(seconds, 'Too many sign-in attempts. Please wait a little before trying again.');
      }

      if (!(await verifyPassword(credential.passwordHash, input.password))) {
        // Count the failure; from the 5th in a row, lock for 1, 2, 4, 8... minutes.
        const [updated] = await db
          .update(credentials)
          .set({ failedLoginCount: sql`${credentials.failedLoginCount} + 1` })
          .where(eq(credentials.customerId, customer.id))
          .returning({ failedLoginCount: credentials.failedLoginCount });
        const failures = updated?.failedLoginCount ?? 0;
        if (failures >= LOCK_AFTER_FAILURES) {
          const minutes = Math.min(MAX_LOCK_MINUTES, 2 ** (failures - LOCK_AFTER_FAILURES));
          await db
            .update(credentials)
            .set({ lockedUntil: new Date(now + minutes * 60_000) })
            .where(eq(credentials.customerId, customer.id));
          logger.warn({ customerId: customer.id, failures }, 'Account temporarily locked after failed sign-ins');
        }
        throw invalidCredentials();
      }

      // Right password: clear the failure count.
      if (credential.failedLoginCount > 0 || credential.lockedUntil) {
        await db
          .update(credentials)
          .set({ failedLoginCount: 0, lockedUntil: null })
          .where(eq(credentials.customerId, customer.id));
      }

      if (!credential.emailVerifiedAt) {
        throw new AppError(
          403,
          'email_not_verified',
          'Please confirm your email address before signing in. We can send you a new link.',
        );
      }

      const session = await createSession(db, customer.id, client);
      return { user: toUser(customer), session };
    },

    // Signing out of this device.
    async logout(actor: Actor): Promise<void> {
      await revokeSession(db, actor.customerId, actor.sessionId);
    },

    // Signing out of every device, this one included.
    async logoutEverywhere(actor: Actor): Promise<void> {
      await revokeAllSessions(db, actor.customerId);
    },

    // "Forgot my password." Always answers the same; emails a link if the
    // account exists.
    async forgotPassword(emailAddressInput: string): Promise<void> {
      const account = await findAccountByEmail(normalizeEmail(emailAddressInput));
      if (!account) return;
      const token = await db.transaction((tx) => issueLinkToken(tx, account.customer.id, 'reset_password'));
      sendInBackground(
        buildEmail(
          account.customer.email,
          'Reset your SXM Rentals password',
          {
            preheader: 'Choose a new password — the link expires in 30 minutes.',
            title: 'Reset your password',
            paragraphs: [
              `Hi ${account.customer.firstName},`,
              'Someone asked to reset the password for your SXM Rentals account. Choose a new one below.',
            ],
            button: { label: 'Choose a new password', url: `${config.appUrl}/reset-password?token=${token}` },
            note: 'This link works once and expires in 30 minutes. If you did not ask for this, you can ignore this email — your password has not been changed.',
          },
          brand,
        ),
      );
    },

    // Choosing a new password from the emailed link. Signs out every device.
    async resetPassword(token: string, newPassword: string): Promise<void> {
      await assertPasswordNotBreached(newPassword);
      const passwordHash = await hashPassword(newPassword);

      const customerId = await db.transaction(async (tx) => {
        const owner = await consumeLinkToken(tx, token, 'reset_password');
        if (!owner) return null;
        await tx
          .update(credentials)
          .set({
            passwordHash,
            passwordChangedAt: new Date(),
            failedLoginCount: 0,
            lockedUntil: null,
            // Opening a link sent to the inbox proves the inbox is theirs.
            emailVerifiedAt: sql`coalesce(${credentials.emailVerifiedAt}, now())`,
          })
          .where(eq(credentials.customerId, owner));
        await revokeAllSessions(tx, owner);
        return owner;
      });
      if (!customerId) throw invalidLink();

      const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
      if (customer) sendInBackground(passwordChangedEmail(customer.email, customer.firstName));
    },

    // Changing the password while signed in. Every device is signed out and
    // this one is given a fresh session.
    async changePassword(
      actor: Actor,
      input: { currentPassword: string; newPassword: string },
      client: ClientInfo,
    ): Promise<NewSession> {
      const [account] = await db
        .select({ customer: customers, credential: credentials })
        .from(customers)
        .innerJoin(credentials, eq(credentials.customerId, customers.id))
        .where(and(eq(customers.id, actor.customerId), isNull(customers.deletedAt)))
        .limit(1);
      if (!account) throw unauthorized();

      if (!(await verifyPassword(account.credential.passwordHash, input.currentPassword))) {
        throw new AppError(400, 'wrong_current_password', 'Your current password is not correct.');
      }
      await assertPasswordNotBreached(input.newPassword);
      const passwordHash = await hashPassword(input.newPassword);

      const session = await db.transaction(async (tx) => {
        await tx
          .update(credentials)
          .set({ passwordHash, passwordChangedAt: new Date() })
          .where(eq(credentials.customerId, actor.customerId));
        await revokeAllSessions(tx, actor.customerId);
        return createSession(tx, actor.customerId, client);
      });

      sendInBackground(passwordChangedEmail(account.customer.email, account.customer.firstName));
      return session;
    },

    // ---- CLOSING YOUR OWN ACCOUNT ----
    // The same rules the admin panel applies when staff close one, for the same
    // reason: closing while money is in the air would strand it. A rental that
    // is running or about to, or a deposit still held, has to finish first.
    //
    // The password is asked for again. Somebody who walks up to an unlocked
    // laptop should not be able to erase the account in two clicks, and this is
    // not a step that can be undone from the website.
    async closeOwnAccount(actor: Actor, input: { password: string }): Promise<void> {
      const [account] = await db
        .select({ customer: customers, credential: credentials })
        .from(customers)
        .innerJoin(credentials, eq(credentials.customerId, customers.id))
        .where(and(eq(customers.id, actor.customerId), isNull(customers.deletedAt)))
        .limit(1);
      if (!account) throw unauthorized();

      if (!(await verifyPassword(account.credential.passwordHash, input.password))) {
        throw new AppError(400, 'wrong_password', 'Your password is not correct.');
      }

      // Somebody who runs a rental business closes the business first. Doing it
      // the other way would leave a business with cars listed and nobody who
      // can act for it.
      const [ownedBusiness] = await db
        .select({ name: providers.businessName })
        .from(providerMembers)
        .innerJoin(providers, eq(providers.id, providerMembers.providerId))
        .where(
          and(
            eq(providerMembers.customerId, actor.customerId),
            eq(providerMembers.role, 'owner'),
            isNull(providers.deletedAt),
          ),
        )
        .limit(1);
      if (ownedBusiness) {
        throw conflict(
          'owns_business',
          `You run ${ownedBusiness.name} on SXM Rentals. Close the business first, then close your account.`,
        );
      }

      const [liveBooking] = await db
        .select({ reference: bookings.reference, status: bookings.status })
        .from(bookings)
        .where(and(eq(bookings.customerId, actor.customerId), inArray(bookings.status, ['upcoming', 'active'])))
        .limit(1);
      if (liveBooking) {
        throw conflict(
          'has_live_rental',
          `You have a rental that is ${liveBooking.status} (${liveBooking.reference}). Your account can be closed once it is finished.`,
        );
      }

      const [heldDeposit] = await db
        .select({ id: deposits.id })
        .from(deposits)
        .innerJoin(bookings, eq(bookings.id, deposits.bookingId))
        .where(and(eq(bookings.customerId, actor.customerId), eq(deposits.status, 'held')))
        .limit(1);
      if (heldDeposit) {
        throw conflict(
          'has_held_deposit',
          'A deposit is still being held on your card. Your account can be closed once it has been given back.',
        );
      }

      // The row stays and is marked closed rather than deleted: past bookings,
      // payouts to businesses and the audit trail all point at it, and sign-in,
      // sessions and "my account" already refuse a closed one.
      //
      // BUT MOST OF THE PERSON GOES WITH IT. The phone number is erased, the
      // surname comes down to an initial — the same name a rental business was
      // ever shown — and the email address is replaced, which FREES IT: it is
      // unique across open and closed accounts alike, so leaving it meant the
      // same person could never sign up again. See lib/anonymise.ts for what
      // stays and why.
      await db.transaction(async (tx) => {
        await tx
          .update(customers)
          .set({
            deletedAt: new Date(),
            ...anonymisedCustomer({ id: actor.customerId, lastName: account.customer.lastName }),
          })
          .where(eq(customers.id, actor.customerId));
        await tx.delete(providerMembers).where(eq(providerMembers.customerId, actor.customerId));
        await revokeAllSessions(tx, actor.customerId);
      });

      sendInBackground(accountClosedEmail(account.customer.email, account.customer.firstName));
    },

    // The devices this person is signed in on.
    async listSessions(actor: Actor) {
      const rows = await listActiveSessions(db, actor.customerId);
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        userAgent: row.userAgent ?? null,
        current: row.id === actor.sessionId,
      }));
    },

    // Signing out one particular device. Someone else's session ID gets "not
    // found", exactly like an ID that does not exist.
    async revokeOwnSession(actor: Actor, sessionId: string): Promise<void> {
      if (!isUuid(sessionId) || !(await revokeSession(db, actor.customerId, sessionId))) {
        throw notFound();
      }
    },

    // "My account" — the signed-in person's own record.
    async getCurrentUser(actor: Actor): Promise<User> {
      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, actor.customerId), isNull(customers.deletedAt)))
        .limit(1);
      if (!customer) throw unauthorized();
      return toUser(customer);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
