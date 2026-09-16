// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for rental businesses, under
// /api/v1/providers. They come in two halves.
//
// THE PUBLIC HALF — anybody can read these, signed in or not:
//   GET /providers        the businesses on the platform
//   GET /providers/:id    one business's public page
// These return only what a customer may see. The private half of a business
// (legal name, registration, the owner's own mobile, earnings) is never in them.
//
// THE BUSINESS'S OWN HALF — "/me", and only for somebody whose account is
// linked to a business:
//   POST   /providers/apply              register a business
//   GET    /providers/me                 its own record
//   PATCH  /providers/me                 edit it
//   GET    /providers/me/summary         the dashboard headline figures
//   GET    /providers/me/vehicles        the whole fleet, approved or not
//   POST   /providers/me/vehicles        add a car (waits for staff approval)
//   PATCH  /providers/me/vehicles/:id    edit one
//   DELETE /providers/me/vehicles/:id    take one off the platform
//   GET    /providers/me/performance     how each car is doing
//   GET    /providers/me/bookings        bookings across the fleet
//   GET    /providers/me/bookings/:id    one of them
//   GET    /providers/me/messages        conversations with renters
//   GET    /providers/me/messages/:id    one conversation
//   POST   /providers/me/messages/:id/messages   reply to it
//   POST   /providers/me/messages/:id/read       mark it read
//   GET    /providers/me/payouts         what SXM Rentals has paid them
//   POST   /providers/me/payout-account  set up where the money goes
//   GET    /providers/me/payout-account  how that setup is going
//
// "me" is worked out from who is signed in, never from anything in the request,
// so there is no business id to tamper with. A business asking for another
// business's car or booking is told it does not exist.

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { providers } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import type { PaymentGateway } from '../../lib/stripe.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import {
  addVehicle,
  applyAsProvider,
  getBusinessProfile,
  getPayoutAccount,
  getProviderBooking,
  getSummary,
  listFleet,
  listPayouts,
  listPerformance,
  listProviderBookings,
  removeVehicle,
  requireProviderFor,
  startPayoutOnboarding,
  updateBusinessProfile,
  updateVehicle,
} from '../../services/provider/index.js';
import {
  getThreadForProvider,
  listThreadsForProvider,
  markReadAsProvider,
  replyAsProvider,
} from '../../services/messaging/index.js';
import { toProvider } from '../../services/serializers/vehicles.js';

export type ProviderRouteOptions = { db: Database; gateway: PaymentGateway; config: Config };

// ---- WHAT EACH REQUEST MAY CONTAIN ----
const listQuery = z.object({
  side: z.enum(['dutch', 'french']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const idParam = z.object({ id: z.string().max(64) });

const applyBody = z.object({
  businessName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(160),
  contactEmail: z.string().trim().pipe(z.email().max(254)),
  ownerName: z.string().trim().min(2).max(120),
  ownerPhone: z.string().trim().min(5).max(40),
  town: z.string().trim().min(2).max(80),
  side: z.enum(['dutch', 'french']),
  operatingSide: z.enum(['dutch', 'french', 'both']),
  phone: z.string().trim().max(40).optional(),
  description: z.string().trim().max(2000).optional(),
  website: z.string().trim().max(200).optional(),
  registrationStatus: z.enum(['registered', 'not_registered', 'pending']).optional(),
  registrationNumber: z.string().trim().max(80).optional(),
  registeredIn: z.string().trim().max(120).optional(),
  fleetSizeBand: z.string().trim().max(40).optional(),
  locations: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  deliversVehicles: z.boolean().optional(),
  airportPickup: z.boolean().optional(),
});

const profilePatchBody = z.object({
  description: z.string().trim().max(2000).optional(),
  town: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().max(40).optional(),
  deliversVehicles: z.boolean().optional(),
  airportPickup: z.boolean().optional(),
  website: z.string().trim().max(200).optional(),
  legalName: z.string().trim().min(2).max(160).optional(),
  contactEmail: z.string().trim().pipe(z.email().max(254)).optional(),
  ownerName: z.string().trim().min(2).max(120).optional(),
  ownerPhone: z.string().trim().min(5).max(40).optional(),
  fleetSizeBand: z.string().trim().max(40).optional(),
  locations: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  operatingSide: z.enum(['dutch', 'french', 'both']).optional(),
});

// Prices arrive in dollars, the way they are typed on the form.
const vehicleBody = z.object({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  year: z.number().int().min(1950).max(new Date().getFullYear() + 2),
  vehicleClass: z.enum(['economy', 'compact', 'suv', 'van', 'fourByFour', 'luxury']),
  transmission: z.enum(['automatic', 'manual']),
  fuel: z.enum(['petrol', 'diesel', 'hybrid', 'electric']),
  seats: z.number().int().min(1).max(20),
  doors: z.number().int().min(1).max(8),
  dailyRate: z.number().positive().max(10_000),
  depositAmount: z.number().min(0).max(100_000),
  pickupTown: z.string().trim().min(2).max(80),
  side: z.enum(['dutch', 'french']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  trim: z.string().trim().max(60).optional(),
  weeklyRate: z.number().positive().max(70_000).optional(),
  minimumDays: z.number().int().min(1).max(365).optional(),
  maximumDays: z.number().int().min(1).max(365).optional(),
  airConditioning: z.boolean().optional(),
  deliveryAvailable: z.boolean().optional(),
  description: z.string().trim().max(2000).optional(),
});
const vehiclePatchBody = vehicleBody.partial();
// A reply is words, a car to suggest, or both.
const providerMessageBody = z.object({
  body: z.string().trim().max(4000).optional(),
  vehicleId: z.string().max(64).optional(),
});

export default async function providerRoutes(app: FastifyInstance, options: ProviderRouteOptions) {
  const { db, gateway, config } = options;

  // Who is signed in, and which business they act for.
  const businessFor = async (request: Parameters<typeof requireCustomer>[0]) =>
    requireProviderFor(db, requireCustomer(request));

  // ---- THE PUBLIC HALF ----
  app.get('/', async (request) => {
    const filters = parseInput(listQuery, request.query);
    const conditions = [isNull(providers.deletedAt)];
    if (filters.side) conditions.push(eq(providers.side, filters.side));

    const rows = await db
      .select()
      .from(providers)
      .where(and(...conditions))
      // Best rated first, matching how the apps order them.
      .orderBy(desc(providers.rating), desc(providers.reviewCount))
      .limit(filters.limit)
      .offset(filters.offset);

    return rows.map(toProvider);
  });

  // ---- REGISTERING A BUSINESS ----
  app.post('/apply', async (request, reply) => {
    const actor = requireCustomer(request);
    const body = parseInput(applyBody, request.body);
    const profile = await applyAsProvider(db, actor, body);
    return reply.status(201).send(profile);
  });

  // ---- THE BUSINESS'S OWN RECORD ----
  app.get('/me', async (request) => {
    const { providerId } = await businessFor(request);
    return getBusinessProfile(db, providerId);
  });

  app.patch('/me', async (request) => {
    const { providerId } = await businessFor(request);
    const patch = parseInput(profilePatchBody, request.body);
    return updateBusinessProfile(db, providerId, patch);
  });

  app.get('/me/summary', async (request) => {
    const { providerId } = await businessFor(request);
    return getSummary(db, providerId);
  });

  // ---- THE FLEET ----
  app.get('/me/vehicles', async (request) => {
    const { providerId } = await businessFor(request);
    return listFleet(db, providerId);
  });

  app.post('/me/vehicles', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const body = parseInput(vehicleBody, request.body);
    const vehicle = await addVehicle(db, providerId, body);
    return reply.status(201).send(vehicle);
  });

  app.patch('/me/vehicles/:id', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const patch = parseInput(vehiclePatchBody, request.body);
    return updateVehicle(db, providerId, id, patch);
  });

  app.delete('/me/vehicles/:id', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    await removeVehicle(db, providerId, id);
    return reply.status(204).send();
  });

  app.get('/me/performance', async (request) => {
    const { providerId } = await businessFor(request);
    return listPerformance(db, providerId);
  });

  // ---- BOOKINGS ACROSS THE FLEET ----
  app.get('/me/bookings', async (request) => {
    const { providerId } = await businessFor(request);
    return listProviderBookings(db, providerId);
  });

  app.get('/me/bookings/:id', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    return getProviderBooking(db, providerId, id);
  });

  // ---- CONVERSATIONS WITH RENTERS ----
  // A display name and whether they are verified, never contact details.
  app.get('/me/messages', async (request) => {
    const { providerId } = await businessFor(request);
    return listThreadsForProvider(db, providerId);
  });

  app.get('/me/messages/:id', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    return getThreadForProvider(db, providerId, id);
  });

  app.post('/me/messages/:id/messages', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(providerMessageBody, request.body);
    const thread = await replyAsProvider(db, providerId, id, body);
    return reply.status(201).send(thread);
  });

  app.post('/me/messages/:id/read', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    await markReadAsProvider(db, providerId, id);
    return reply.status(204).send();
  });

  // ---- MONEY ----
  app.get('/me/payouts', async (request) => {
    const { providerId } = await businessFor(request);
    return listPayouts(db, providerId);
  });

  app.post('/me/payout-account', async (request) => {
    const { providerId } = await businessFor(request);
    return startPayoutOnboarding(db, gateway, config, providerId);
  });

  app.get('/me/payout-account', async (request) => {
    const { providerId } = await businessFor(request);
    return getPayoutAccount(db, gateway, providerId);
  });

  // ---- ONE BUSINESS'S PUBLIC PAGE ----
  // Last, so "/me" is never read as an id.
  app.get('/:id', async (request) => {
    const { id } = parseInput(idParam, request.params);
    if (!isUuid(id)) throw notFound('We could not find that rental business.');

    const [provider] = await db
      .select()
      .from(providers)
      .where(and(eq(providers.id, id), isNull(providers.deletedAt)))
      .limit(1);
    if (!provider) throw notFound('We could not find that rental business.');

    return toProvider(provider);
  });
}
