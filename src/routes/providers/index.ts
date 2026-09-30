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
import { AppError, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import type { PhotoStorage } from '../../lib/storage.js';
import type { PaymentGateway } from '../../lib/stripe.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import { AUTH_LIMITS } from '../../plugins/rate-limit.js';
import { PASSWORD_MAX_LENGTH } from '../../lib/passwords.js';
import { assertOwnPassword } from '../../services/auth/credentials.js';
import {
  addVehicle,
  applyAsProvider,
  attachVehiclePhoto,
  closeBusiness,
  listVehiclePhotos,
  ownVehicleId,
  photoUploadTicket,
  removeVehiclePhoto,
  reorderVehiclePhotos,
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
  messageAboutBooking,
  replyAsProvider,
} from '../../services/messaging/index.js';
import { toProvider } from '../../services/serializers/vehicles.js';

export type ProviderRouteOptions = { db: Database; gateway: PaymentGateway; config: Config; storage: PhotoStorage };

// ---- WHAT EACH REQUEST MAY CONTAIN ----
const listQuery = z.object({
  side: z.enum(['dutch', 'french']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const idParam = z.object({ id: z.string().max(64) });
const photoParams = z.object({ id: z.string().max(64), photoId: z.string().max(64) });
const closeBody = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
// Only an address, and only one that storage recognises as this car's — the
// check that matters happens in the service, not here.
const photoBody = z.object({ url: z.url().max(500) });
const photoOrderBody = z.object({ order: z.array(z.string().max(64)).min(1).max(12) });

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
  // What bringing the car to the customer costs, per rental, in dollars. 0 is
  // free delivery.
  deliveryFee: z.number().min(0).max(1_000).optional(),
  description: z.string().trim().max(2000).optional(),
  // What the business declares about the car's past. Sent as the whole list,
  // because that is how the form shows it. Capped so one car cannot carry a
  // novel.
  accidentHistory: z
    .array(
      z.object({
        date: z.iso.date(),
        description: z.string().trim().min(3).max(500),
        repaired: z.boolean(),
      }),
    )
    .max(20)
    .optional(),
});
// Editing: the same fields, all optional — plus null for a weekly rate, which is
// how one is taken away. Without it a missing value means "no change", so a rate
// could be set and never removed.
const vehiclePatchBody = vehicleBody.partial().extend({
  weeklyRate: z.number().positive().max(70_000).nullable().optional(),
});
// A reply is words, a car to suggest, or both.
const providerMessageBody = z.object({
  body: z.string().trim().max(4000).optional(),
  vehicleId: z.string().max(64).optional(),
});

export default async function providerRoutes(app: FastifyInstance, options: ProviderRouteOptions) {
  const { db, gateway, config , storage } = options;

  // Who is signed in, and which business they act for.
  const businessFor = async (request: Parameters<typeof requireCustomer>[0]) =>
    requireProviderFor(db, requireCustomer(request));

  // ---- THE PUBLIC HALF ----
  app.get('/', async (request) => {
    const filters = parseInput(listQuery, request.query);
    // ONLY BUSINESSES STAFF HAVE CHECKED. Before this, anybody who signed up
    // and applied appeared in the public list of rental companies the same
    // minute — a stranger's business, on a live site, with nobody having looked
    // at it. The list is empty until staff approve one, which is the honest
    // state rather than a filled list nobody vouched for.
    //
    // GET /providers/:id still serves an unverified business, so a direct link
    // a business was given to check its own page keeps working.
    const conditions = [isNull(providers.deletedAt), eq(providers.isVerified, true)];
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

  // Closing the business for good. Every car comes off the site and nobody can
  // act for it again — so it is refused while a rental is running, a deposit is
  // held, or a payment to them is still on its way.
  app.post('/me/close', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    const actor = requireCustomer(request);
    const { providerId, role } = await requireProviderFor(db, actor);
    // Staff who work for the business cannot close it; only whoever owns it.
    if (role !== 'owner') {
      throw new AppError(403, 'owner_only', 'Only the owner of the business can close it.');
    }
    // THE PASSWORD AGAIN, as closing an account asks for it. This delists every
    // car and takes the business page down, and a session left open on a
    // borrowed laptop should not be enough to do that. Rate-limited like the
    // other password routes so it cannot be used to guess one.
    const { password } = parseInput(closeBody, request.body);
    await assertOwnPassword(db, actor.customerId, password);
    return closeBusiness(db, providerId);
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

  // ---- THE CAR'S PHOTOS ----
  // The photo itself never comes through here: the app asks for a ticket,
  // uploads straight to Cloudinary with it, then tells us the address. See
  // lib/storage.ts for why, and what stops an address being made up.
  app.get('/me/vehicles/:id/photos', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    // Confirms the car is theirs before saying anything about it.
    return listVehiclePhotos(db, await ownVehicleId(db, providerId, id));
  });

  app.post('/me/vehicles/:id/photos/upload-ticket', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    return photoUploadTicket(db, storage, providerId, id);
  });

  app.post('/me/vehicles/:id/photos', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(photoBody, request.body);
    const photos = await attachVehiclePhoto(db, storage, providerId, id, body);
    return reply.status(201).send(photos);
  });

  app.patch('/me/vehicles/:id/photos', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(photoOrderBody, request.body);
    return reorderVehiclePhotos(db, providerId, id, body);
  });

  app.delete('/me/vehicles/:id/photos/:photoId', async (request) => {
    const { providerId } = await businessFor(request);
    const { id, photoId } = parseInput(photoParams, request.params);
    return removeVehiclePhoto(db, storage, providerId, id, photoId);
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

  // Writing FIRST, about one of its own bookings — "we are at the Simpson Bay
  // office, ask for Marie". Until now a business could only reply, so it had to
  // wait for the renter to write. Tied to a booking of theirs, so a business
  // cannot open a conversation with any customer it likes.
  app.post('/me/bookings/:id/messages', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(providerMessageBody, request.body);
    const thread = await messageAboutBooking(db, providerId, id, body);
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
