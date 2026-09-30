// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for a customer's own account, under
// /api/v1/customers:
//
//   GET  /me         the signed-in person's own account, in the `User` shape the
//                    website and phone app already use for the account screens
//   POST /me/close   close that account for good
//   PATCH /me        change your name or phone number
//   POST /me/email   move to a new email address, once it is confirmed
//   GET  /me/saved-cars, PUT·DELETE /me/saved-cars/:vehicleId   saved cars
//   POST /me/export  email yourself a copy of your data
//   GET  /me/notification-preferences   what they want to hear about
//   PUT  /me/notification-preferences   all six choices, every time
//
// There is deliberately no "/customers/:id" for customers — a person can only
// ever ask for their own record, so there is no ID to tamper with.
//
// CLOSING ASKS FOR THE PASSWORD AGAIN. It cannot be undone from the website, so
// somebody who finds an unlocked laptop should not be able to do it in two
// clicks. It is rate-limited like the other password routes, so the endpoint
// cannot be used to guess one either.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { clearSessionCookie, requireCustomer } from '../../middleware/auth.js';
import { AUTH_LIMITS } from '../../plugins/rate-limit.js';
import { parseInput } from '../../lib/validate.js';
import { PASSWORD_MAX_LENGTH } from '../../lib/passwords.js';
import type { AuthService } from '../../services/auth/index.js';
import type { AccountService } from '../../services/account/index.js';
import { requireFeature } from '../../services/capabilities/index.js';
import type { PushService } from '../../services/push/index.js';

export type CustomerRouteOptions = {
  auth: AuthService;
  config: Config;
  push: PushService;
  account: AccountService;
};

// Only these three. The account type (local or tourist) never changes here.
const profileBody = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(32).optional(),
});
const emailChangeBody = z.object({
  email: z.string().trim().pipe(z.email('Please enter a valid email address.').max(254)),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
const vehicleParam = z.object({ vehicleId: z.string().max(64) });

// The six switches on the app's Settings screen, sent together every time.
const preferencesBody = z.object({
  bookings: z.boolean(),
  pickupReminders: z.boolean(),
  returnReminders: z.boolean(),
  deposits: z.boolean(),
  messages: z.boolean(),
  offers: z.boolean(),
});

const closeBody = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

export default async function customerRoutes(app: FastifyInstance, options: CustomerRouteOptions) {
  const { auth, config } = options;

  app.get('/me', async (request) => auth.getCurrentUser(requireCustomer(request)));

  const { account } = options;

  app.patch('/me', async (request) => {
    requireFeature(config, 'editProfile');
    return account.updateProfile(requireCustomer(request), parseInput(profileBody, request.body));
  });

  // Asks for the password again, and is rate-limited like the other password
  // routes, so it cannot be used to guess one.
  app.post('/me/email', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request, reply) => {
    requireFeature(config, 'editProfile');
    const actor = requireCustomer(request);
    const answer = await account.requestEmailChange(actor, parseInput(emailChangeBody, request.body));
    return reply.status(202).send(answer);
  });

  app.get('/me/saved-cars', async (request) => {
    requireFeature(config, 'savedCars');
    return account.savedCars(requireCustomer(request));
  });

  app.put('/me/saved-cars/:vehicleId', async (request, reply) => {
    requireFeature(config, 'savedCars');
    const { vehicleId } = parseInput(vehicleParam, request.params);
    await account.saveCar(requireCustomer(request), vehicleId);
    return reply.status(204).send();
  });

  app.delete('/me/saved-cars/:vehicleId', async (request, reply) => {
    requireFeature(config, 'savedCars');
    const { vehicleId } = parseInput(vehicleParam, request.params);
    await account.unsaveCar(requireCustomer(request), vehicleId);
    return reply.status(204).send();
  });

  app.post('/me/export', async (request, reply) => {
    requireFeature(config, 'dataExport');
    const actor = requireCustomer(request);
    // The link points at this API, which serves the download page.
    const answer = await account.requestExport(actor, `${request.protocol}://${request.host}`);
    return reply.status(202).send(answer);
  });

  app.get('/me/notification-preferences', async (request) => {
    requireFeature(config, 'push');
    return options.push.getPreferences(requireCustomer(request));
  });

  app.put('/me/notification-preferences', async (request) => {
    requireFeature(config, 'push');
    const actor = requireCustomer(request);
    return options.push.setPreferences(actor, parseInput(preferencesBody, request.body));
  });

  app.post('/me/close', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request, reply) => {
    const actor = requireCustomer(request);
    const { password } = parseInput(closeBody, request.body);
    await auth.closeOwnAccount(actor, { password });
    // Every session was ended; take the cookie off this browser too, so the
    // person is visibly signed out rather than seeing errors.
    clearSessionCookie(reply, config);
    return reply.status(204).send();
  });
}
