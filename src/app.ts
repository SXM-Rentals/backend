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
import {
  createConsoleEmailSender,
  createResendEmailSender,
  createUnconfiguredEmailSender,
  type EmailSender,
} from './lib/email.js';
import { createHibpChecker, skipBreachedPasswordCheck, type BreachedPasswordChecker } from './lib/passwords.js';
import { createCloudinaryStorage, createUnconfiguredStorage, type PhotoStorage } from './lib/storage.js';
import { registerAuth } from './middleware/auth.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerCors } from './plugins/cors.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { buildLoggerOptions } from './plugins/request-logging.js';
import { registerSecurityHeaders } from './plugins/security-headers.js';
import adminRoutes from './routes/admin/index.js';
import authRoutes from './routes/auth/index.js';
import bookingRoutes from './routes/bookings/index.js';
import capabilityRoutes from './routes/capabilities/index.js';
import customerRoutes from './routes/customers/index.js';
import depositRoutes from './routes/deposits/index.js';
import messageRoutes from './routes/messages/index.js';
import notificationRoutes from './routes/notifications/index.js';
import paymentRoutes from './routes/payments/index.js';
import providerRoutes from './routes/providers/index.js';
import vehicleRoutes from './routes/vehicles/index.js';
import webhookRoutes from './routes/webhooks/index.js';
import deviceRoutes from './routes/devices/index.js';
import exportRoutes from './routes/exports/index.js';
import rewardRoutes from './routes/rewards/index.js';
import supportRoutes from './routes/support/index.js';
import { createAccountService } from './services/account/index.js';
import { createSupportService } from './services/support/index.js';
import { createDateChangeService } from './services/date-changes/index.js';
import { createDisabledPushSender, createExpoPushSender, type PushSender } from './lib/push.js';
import { createPushService } from './services/push/index.js';
import verificationRoutes from './routes/verification/index.js';
import { createVerificationService } from './services/verification/index.js';
import { createAdminAuthService } from './services/admin/auth.js';
import { createAdminService } from './services/admin/index.js';
import { createTestDataService } from './services/admin/test-data.js';
import { createAdminStaffService } from './services/admin/staff.js';
import { createAuthService } from './services/auth/index.js';
import { createNotificationService } from './services/notifications/index.js';
import { createPaymentService } from './services/payments/index.js';
import { createStripeGateway, createUnconfiguredGateway, type PaymentGateway } from './lib/stripe.js';
import { createIntegrationService, type Resolver } from './services/integrations/index.js';
import partnerRoutes from './routes/partner/index.js';
import callRoutes from './routes/calls/index.js';
import { createCallService } from './services/calls/index.js';
import { createPhoneSignInService } from './services/auth/phone.js';
import { createTwilioClient, type TwilioClient } from './lib/twilio.js';

export type AppDependencies = {
  config: Config;
  db: Database;
  // Optional stand-ins, mainly for tests. Sensible defaults are chosen otherwise.
  email?: EmailSender;
  breachedPasswords?: BreachedPasswordChecker;
  payments?: PaymentGateway;
  storage?: PhotoStorage;
  pushSender?: PushSender;
  // The web requests to businesses' own systems, and looking their names up.
  partnerSend?: typeof fetch;
  partnerResolve?: Resolver;
  // Twilio, for calls and texts. Left out, it is built from the settings.
  twilio?: TwilioClient;
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
  // How emails go out, and how a password is checked against known breaches.
  // Both are needed before sign-in is assembled, customer or staff.
  // Resend as soon as its key is set; otherwise printed to the terminal in
  // development, and refused loudly in production rather than sent nowhere.
  const email =
    deps.email ??
    (config.resendApiKey
      ? createResendEmailSender({
          apiKey: config.resendApiKey,
          from: config.emailFrom,
          replyTo: config.emailReplyTo,
          logger: app.log,
        })
      : config.isProduction
        ? createUnconfiguredEmailSender(app.log)
        : createConsoleEmailSender(app.log));
  const breachedPasswords =
    deps.breachedPasswords ?? (config.breachedPasswordCheck ? createHibpChecker(app.log) : skipBreachedPasswordCheck);

  // Staff sign in through their own realm, checked on every request alongside
  // the customer one — and never confused with it.
  const adminAuth = createAdminAuthService({ db, config, logger: app.log, breachedPasswords });
  registerAuth(app, { db, config, adminAuth });

  // ---- SERVICES ----
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
  // Where car photos are kept. All three keys or none: a half-set account
  // cannot sign an upload, so it would fail at the worst moment instead of the
  // first one.
  const storage =
    deps.storage ??
    (config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret
      ? createCloudinaryStorage({
          cloudName: config.cloudinaryCloudName,
          apiKey: config.cloudinaryApiKey,
          apiSecret: config.cloudinaryApiSecret,
          logger: app.log,
        })
      : createUnconfiguredStorage());

  // Pushes to phones, through Expo — only once its access token is set.
  const push = createPushService({
    db,
    sender:
      deps.pushSender ??
      (config.expoAccessToken
        ? createExpoPushSender({ accessToken: config.expoAccessToken, logger: app.log })
        : createDisabledPushSender()),
    logger: app.log,
  });

  // Tells customers what has happened: in the app's notification list, and by
  // email for the things that warrant one.
  const notifications = createNotificationService({
    db,
    email,
    logger: app.log,
    brand: { siteUrl: config.appUrl, logoUrl: config.emailLogoUrl, social: config.socialAccounts },
    push,
  });
  const payments = createPaymentService({ db, gateway, logger: app.log, notifications });
  // A customer's own account: rewards, details, saved cars, a copy of their data.
  const account = createAccountService({
    db,
    config,
    email,
    brand: { siteUrl: config.appUrl, logoUrl: config.emailLogoUrl, social: config.socialAccounts },
    logger: app.log,
  });
  // Customers talking to SXM Rentals staff.
  const support = createSupportService({ db, push });

  // A business's own rental software: its API key, and the bookings sent to it.
  const integrations = createIntegrationService({
    db,
    ...(deps.partnerSend ? { send: deps.partnerSend } : {}),
    ...(deps.partnerResolve ? { resolve: deps.partnerResolve } : {}),
    logger: app.log,
  });
  // So a test can wait for bookings on their way to a business's system.
  app.decorate('integrations', integrations);

  // Calls inside the app, and sign-in codes by text, both carried by Twilio.
  const twilio = deps.twilio ?? createTwilioClient(config, app.log);
  const calls = createCallService({ db, twilio, push });
  const phone = createPhoneSignInService({ db, twilio, logger: app.log });

  // Changing a rental's dates, as a request the business answers.
  const dateChanges = createDateChangeService({ db, config, gateway, notifications, push });

  // Identity checks: Stripe Identity or staff, as the owner chooses.
  const verification = createVerificationService({ db, config, gateway, notifications, logger: app.log });
  const admin = createAdminService({ db, gateway, payments, notifications, integrations });
  // The Godfather's test-data clearing, before launch only.
  const testData = createTestDataService({ db, config });
  // Staff accounts, managed from the panel. It borrows the sign-in service's
  // lockout counters and session-ending, so there is one of each.
  const staffAccounts = createAdminStaffService({ db, auth: adminAuth, breachedPasswords });

  // ---- ROUTES ----
  // Versioned, so a breaking change never strands an older phone-app release.
  await app.register(
    async (api) => {
      // "Is the API up, and can it reach the database?"
      api.get('/health', async () => {
        await db.execute(sql`select 1`);
        return { status: 'ok' };
      });
      // Which features the phone app may show. Public, and the same for everybody.
      await api.register(capabilityRoutes, { prefix: '/capabilities', config });
      await api.register(authRoutes, { prefix: '/auth', auth, config, account, phone });
      await api.register(customerRoutes, { prefix: '/customers', auth, config, push, account });
      await api.register(rewardRoutes, { prefix: '/rewards', config, account });
      await api.register(supportRoutes, { prefix: '/support', config, support });
      await api.register(exportRoutes, { prefix: '/exports', account });
      await api.register(deviceRoutes, { prefix: '/devices', config, push });
      await api.register(vehicleRoutes, { prefix: '/vehicles', db });
      await api.register(providerRoutes, { prefix: '/providers', db, gateway, config, storage, push, dateChanges, integrations });
      await api.register(bookingRoutes, { prefix: '/bookings', db, notifications, verification, dateChanges, config, integrations });
      await api.register(verificationRoutes, { prefix: '/verification', config, verification });
      await api.register(notificationRoutes, { prefix: '/notifications', notifications, config });
      await api.register(messageRoutes, { prefix: '/messages', db, push, config });
      await api.register(paymentRoutes, { prefix: '/payments', payments, config, dateChanges });
      await api.register(depositRoutes, { prefix: '/deposits', payments });
      await api.register(callRoutes, { prefix: '/calls', config, calls, twilio });
      await api.register(webhookRoutes, { prefix: '/webhooks', payments, gateway, verification });
      await api.register(adminRoutes, {
        prefix: '/admin',
        db,
        config,
        admin,
        adminAuth,
        staffAccounts,
        verification,
        support,
        testData,
      });
      // Later phases register verification, rewards, notifications, ... here.
    },
    { prefix: '/api/v1' },
  );

  // The partner API: called by businesses' own rental software with an API key,
  // outside /api/v1 because it is versioned on its own.
  await app.register(partnerRoutes, { prefix: '/partner/v1', db, config, integrations });

  if (deps.extend) await deps.extend(app);
  return app;
}
