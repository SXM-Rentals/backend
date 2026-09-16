// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Shared tools for the tests. It builds a complete private
// copy of the API backed by a brand-new, empty in-memory database with every
// migration applied, captures outgoing emails instead of sending them, and
// offers shortcuts for the steps many tests repeat — creating a verified
// account, signing in, and filling the database with a customer, a rental
// business, a car and a booking.

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectPglite, type Database } from '../src/db/client.js';
import { bookings, customers, providers, vehicles } from '../src/db/schema/index.js';
import { createMemoryEmailSender, type MemoryEmailSender } from '../src/lib/email.js';
import { AppError } from '../src/lib/errors.js';
import type { PaymentGateway, WebhookEvent } from '../src/lib/stripe.js';

export const WEB_ORIGIN = 'http://localhost:3000';
export const SESSION_COOKIE = 'sxm_session';
export const GOOD_PASSWORD = 'correct horse battery staple';

export type TestContext = {
  app: FastifyInstance;
  db: Database;
  email: MemoryEmailSender;
  // Passwords added here are treated as "found in a data breach".
  breachedPasswords: Set<string>;
  // The stand-in Stripe. Tests read what it was asked to do, and send the
  // messages Stripe would send back.
  gateway: FakeGateway;
  close: () => Promise<void>;
};

// ---- A PRIVATE COPY OF THE API ----
export async function createTestContext(
  options: { extend?: (app: FastifyInstance) => void } = {},
): Promise<TestContext> {
  const connection = await connectPglite();
  await connection.migrate();

  const config = loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: WEB_ORIGIN, APP_URL: WEB_ORIGIN });
  const email = createMemoryEmailSender();
  const breachedPasswords = new Set<string>();
  const gateway = createFakeGateway();

  const app = await buildApp({
    config,
    db: connection.db,
    email,
    breachedPasswords: { isBreached: async (password) => breachedPasswords.has(password) },
    payments: gateway,
    extend: options.extend,
  });
  await app.ready();

  return {
    app,
    db: connection.db,
    email,
    breachedPasswords,
    gateway,
    close: async () => {
      await app.close();
      await connection.close();
    },
  };
}

// ---- A STAND-IN FOR STRIPE ----
// Behaves the way Stripe does in the ways that matter: it hands back a payment
// with a one-time secret, it refuses a message that is not properly signed, and
// it remembers what it was asked to do so a test can check. No network, no keys.
export const TEST_SIGNATURE = 'test-signature';

export type FakeGateway = PaymentGateway & {
  // Every payment it has been asked to create, by id.
  created: Map<string, { kind: 'rental' | 'deposit'; amountCents: number; metadata: Record<string, string> }>;
  captured: { paymentId: string; amountCents: number }[];
  cancelled: string[];
  refunded: { paymentId: string; amountCents?: number }[];
  // Builds the message Stripe would send about a payment.
  eventFor(type: string, paymentId: string, overrides?: Record<string, unknown>): WebhookEvent;
};

export function createFakeGateway(): FakeGateway {
  const created: FakeGateway['created'] = new Map();
  const statuses = new Map<string, string>();
  let counter = 0;

  const create = (kind: 'rental' | 'deposit', amountCents: number, metadata: Record<string, string>) => {
    counter += 1;
    const id = `pi_${kind}_${counter}`;
    created.set(id, { kind, amountCents, metadata: { ...metadata, kind } });
    statuses.set(id, 'requires_payment_method');
    return { id, clientSecret: `${id}_secret`, status: 'requires_payment_method' };
  };

  const gateway: FakeGateway = {
    created,
    captured: [],
    cancelled: [],
    refunded: [],

    async createRentalPayment(input) {
      return create('rental', input.amountCents, { bookingId: input.bookingId, reference: input.bookingReference });
    },
    async createDepositHold(input) {
      return create('deposit', input.amountCents, {
        bookingId: input.bookingId,
        depositId: input.depositId,
        reference: input.bookingReference,
      });
    },
    async getPayment(paymentId) {
      const payment = created.get(paymentId);
      if (!payment) return null;
      return { id: paymentId, clientSecret: `${paymentId}_secret`, status: statuses.get(paymentId) ?? 'unknown' };
    },
    async captureDepositHold(paymentId, amountCents) {
      gateway.captured.push({ paymentId, amountCents });
      statuses.set(paymentId, 'succeeded');
    },
    async cancelDepositHold(paymentId) {
      gateway.cancelled.push(paymentId);
      statuses.set(paymentId, 'canceled');
    },
    async refundPayment(paymentId, amountCents) {
      gateway.refunded.push({ paymentId, amountCents });
    },
    verifyWebhook(rawBody, signature) {
      // The real Stripe checks a signature over these exact bytes; this checks
      // a fixed one, so a test can prove an unsigned message is refused.
      if (signature !== TEST_SIGNATURE) {
        throw new AppError(400, 'invalid_signature', 'This message could not be verified.');
      }
      return JSON.parse(rawBody.toString('utf8')) as WebhookEvent;
    },

    eventFor(type, paymentId, overrides = {}) {
      const payment = created.get(paymentId);
      counter += 1;
      return {
        id: `evt_${counter}`,
        type,
        data: {
          object: {
            id: paymentId,
            amount: payment?.amountCents ?? 0,
            metadata: payment?.metadata ?? {},
            ...overrides,
          },
        },
      };
    },
  };

  return gateway;
}

// ---- A DIFFERENT VISITOR ADDRESS PER CALL ----
// Rate limits are per address, so tests that are not about rate limiting use a
// fresh address each time to avoid tripping over each other's limits.
let addressCounter = 0;
export function uniqueIp(): string {
  addressCounter += 1;
  return `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter & 255}`;
}

// ---- READING THE LINK OUT OF AN EMAIL ----
export function tokenFromLastEmail(email: MemoryEmailSender): string {
  const last = email.sent.at(-1);
  const match = last?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`No link found in the last email: ${last?.subject ?? '(no email sent)'}`);
  return match[1];
}

// ---- A READY-TO-USE ACCOUNT ----
let accountCounter = 0;
export async function createVerifiedAccount(ctx: TestContext, overrides: { email?: string; password?: string } = {}) {
  accountCounter += 1;
  const email = overrides.email ?? `person${accountCounter}@example.com`;
  const password = overrides.password ?? GOOD_PASSWORD;

  const signup = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    remoteAddress: uniqueIp(),
    payload: { firstName: 'Aria', lastName: 'Duncan', email, password, accountType: 'tourist' },
  });
  if (signup.statusCode !== 202) throw new Error(`Signup failed: ${signup.body}`);

  const verify = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    remoteAddress: uniqueIp(),
    payload: { token: tokenFromLastEmail(ctx.email) },
  });
  if (verify.statusCode !== 200) throw new Error(`Verification failed: ${verify.body}`);

  return { email, password };
}

// ---- SIGNING IN ----
// Website style: returns the cookie to send back on later requests.
export async function signInWeb(ctx: TestContext, email: string, password: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: uniqueIp(),
    headers: { origin: WEB_ORIGIN },
    payload: { email, password },
  });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (res.statusCode !== 200 || !cookie) throw new Error(`Web sign-in failed: ${res.body}`);
  return `${SESSION_COOKIE}=${cookie.value}`;
}

// Phone-app style: returns the bearer code.
export async function signInMobile(ctx: TestContext, email: string, password: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: uniqueIp(),
    payload: { email, password, client: 'mobile' },
  });
  const token = res.json()?.session?.token;
  if (res.statusCode !== 200 || typeof token !== 'string') throw new Error(`Mobile sign-in failed: ${res.body}`);
  return token;
}

// ---- A CUSTOMER, A BUSINESS, A CAR AND A BOOKING ----
// Inserted straight into the database, for tests about data rules and searching.
let seedCounter = 0;

export async function seedCustomer(db: Database, overrides: Partial<typeof customers.$inferInsert> = {}) {
  seedCounter += 1;
  const [customer] = await db
    .insert(customers)
    .values({
      firstName: 'Benjamin',
      lastName: 'Jones',
      email: `renter${seedCounter}@example.com`,
      phone: '+1 721 555 0142',
      accountType: 'tourist',
      verificationStatus: 'approved',
      ...overrides,
    })
    .returning();
  return customer!;
}

export async function seedProvider(db: Database, overrides: Partial<typeof providers.$inferInsert> = {}) {
  const [provider] = await db
    .insert(providers)
    .values({ businessName: 'Island Wheels', side: 'dutch', town: 'Philipsburg', ...overrides })
    .returning();
  return provider!;
}

// Listed and approved by default, because that is what a customer can book.
export async function seedVehicle(
  db: Database,
  providerId: string,
  overrides: Partial<typeof vehicles.$inferInsert> = {},
) {
  seedCounter += 1;
  const [vehicle] = await db
    .insert(vehicles)
    .values({
      reference: `SXM-V-${100 + seedCounter}`,
      providerId,
      make: 'Suzuki',
      model: 'Jimny',
      year: 2024,
      vehicleClass: 'fourByFour',
      transmission: 'manual',
      fuel: 'petrol',
      seats: 4,
      doors: 3,
      dailyRateCents: 6500,
      depositAmountCents: 50000,
      pickupTown: 'Philipsburg',
      side: 'dutch',
      latitude: 18.026,
      longitude: -63.045,
      listingStatus: 'live',
      ...overrides,
    })
    .returning();
  return vehicle!;
}

// A date a given number of days from today, as YYYY-MM-DD.
export function dateIn(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function seedBooking(db: Database) {
  seedCounter += 1;
  const customer = await seedCustomer(db);
  const provider = await seedProvider(db);
  const vehicle = await seedVehicle(db, provider.id);
  const [booking] = await db
    .insert(bookings)
    .values({
      reference: `SXM-${4800 + seedCounter}`,
      customerId: customer.id,
      vehicleId: vehicle.id,
      providerId: provider.id,
      startDate: '2026-10-01',
      endDate: '2026-10-04',
      pickupTime: '10:00',
      returnTime: '10:00',
      collection: 'pickup',
      location: 'Princess Juliana Airport',
      grossCents: 19500,
      commissionCents: 5850,
      payoutCents: 13650,
      totalDueTodayCents: 19500,
    })
    .returning();

  return { customer, provider, vehicle, booking: booking! };
}
