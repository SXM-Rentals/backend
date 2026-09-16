// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Assembles the whole API, in the order the protections
// have to run, without starting it. server.ts uses this to run the real server;
// the tests use it to build a private copy with a throwaway database and call
// it directly, so the tests exercise exactly the same assembly as production.
//
// Every request passes through, in order:
//   1. security headers and CORS          (plugins/security-headers, cors)
//   2. the rate limit                     (plugins/rate-limit)
//   3. forged-request check + who is it   (middleware/auth)
//   4. the route, under /api/v1           (routes/)
//   5. one consistent error shape         (middleware/error-handler)

import cookie from '@fastify/cookie';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import { createConsoleEmailSender, createUnconfiguredEmailSender, type EmailSender } from './lib/email.js';
import { createHibpChecker, skipBreachedPasswordCheck, type BreachedPasswordChecker } from './lib/passwords.js';
import { registerAuth } from './middleware/auth.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerCors } from './plugins/cors.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { buildLoggerOptions } from './plugins/request-logging.js';
import { registerSecurityHeaders } from './plugins/security-headers.js';
import adminRoutes from './routes/admin/index.js';
import authRoutes from './routes/auth/index.js';
import bookingRoutes from './routes/bookings/index.js';
import customerRoutes from './routes/customers/index.js';
import depositRoutes from './routes/deposits/index.js';
import messageRoutes from './routes/messages/index.js';
import notificationRoutes from './routes/notifications/index.js';
import paymentRoutes from './routes/payments/index.js';
import providerRoutes from './routes/providers/index.js';
import vehicleRoutes from './routes/vehicles/index.js';
import webhookRoutes from './routes/webhooks/index.js';
import { createAdminAuthService } from './services/admin/auth.js';
import { createAdminService } from './services/admin/index.js';
import { createAuthService } from './services/auth/index.js';
import { createNotificationService } from './services/notifications/index.js';
import { createPaymentService } from './services/payments/index.js';
import { createStripeGateway, createUnconfiguredGateway, type PaymentGateway } from './lib/stripe.js';

export type AppDependencies = {
  config: Config;
  db: Database;
  // Optional stand-ins, mainly for tests. Sensible defaults are chosen otherwise.
  email?: EmailSender;
  breachedPasswords?: BreachedPasswordChecker;
  payments?: PaymentGateway;
  // A chance to add extra routes before the app is sealed (used by tests).
  extend?: (app: FastifyInstance) => void | Promise<void>;
};

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, db } = deps;

  // ---- THE SERVER ITSELF ----
  const app = Fastify({
    logger: buildLoggerOptions(config),
    // Our own request IDs; one sent in by a caller is never trusted.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // Trust only as many proxies as we actually run behind, so a visitor cannot
    // fake their address (and dodge rate limits) with an X-Forwarded-For header.
    trustProxy: config.trustProxyHops > 0 ? (_address: string, hop: number) => hop < config.trustProxyHops : false,
    // Sane ceilings so a huge or never-ending request cannot tie a server up.
    bodyLimit: 1024 * 1024,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    return503OnClosing: true,
  });

  // ---- PROTECTIONS, IN ORDER ----
  registerErrorHandler(app);
  await registerSecurityHeaders(app);
  await registerCors(app, config);
  await app.register(cookie);
  await registerRateLimit(app, db);
  // Staff sign in through their own realm, checked on every request alongside
  // the customer one — and never confused with it.
  const adminAuth = createAdminAuthService({ db, config, logger: app.log });
  registerAuth(app, { db, config, adminAuth });

  // ---- SERVICES ----
  const email =
    deps.email ?? (config.isProduction ? createUnconfiguredEmailSender(app.log) : createConsoleEmailSender(app.log));
  const breachedPasswords =
    deps.breachedPasswords ?? (config.breachedPasswordCheck ? createHibpChecker(app.log) : skipBreachedPasswordCheck);
  const auth = createAuthService({ db, config, email, breachedPasswords, logger: app.log });

  // Stripe, when its keys are set. Until then every payment endpoint answers
  // "not switched on yet" rather than appearing to take money.
  const gateway =
    deps.payments ??
    (config.stripeSecretKey
      ? createStripeGateway({
          secretKey: config.stripeSecretKey,
          webhookSecret: config.stripeWebhookSecret,
          currency: config.currency,
        })
      : createUnconfiguredGateway());
  // Tells customers what has happened: in the app's notification list, and by
  // email for the things that warrant one.
  const notifications = createNotificationService({ db, email, logger: app.log });
  const payments = createPaymentService({ db, gateway, logger: app.log, notifications });
  const admin = createAdminService({ db, gateway, payments });

  // ---- ROUTES ----
  // Versioned, so a breaking change never strands an older phone-app release.
  await app.register(
    async (api) => {
      // "Is the API up, and can it reach the database?"
      api.get('/health', async () => {
        await db.execute(sql`select 1`);
        return { status: 'ok' };
      });
      await api.register(authRoutes, { prefix: '/auth', auth, config });
      await api.register(customerRoutes, { prefix: '/customers', auth });
      await api.register(vehicleRoutes, { prefix: '/vehicles', db });
      await api.register(providerRoutes, { prefix: '/providers', db, gateway, config });
      await api.register(bookingRoutes, { prefix: '/bookings', db, notifications });
      await api.register(notificationRoutes, { prefix: '/notifications', notifications });
      await api.register(messageRoutes, { prefix: '/messages', db });
      await api.register(paymentRoutes, { prefix: '/payments', payments });
      await api.register(depositRoutes, { prefix: '/deposits', payments });
      await api.register(webhookRoutes, { prefix: '/webhooks', payments, gateway });
      await api.register(adminRoutes, { prefix: '/admin', db, config, admin, adminAuth });
      // Later phases register verification, rewards, notifications, ... here.
    },
    { prefix: '/api/v1' },
  );

  if (deps.extend) await deps.extend(app);
  return app;
}
