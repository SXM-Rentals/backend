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
//   GET    /providers/me/vehicles/:id    one of them, approved or not
//   GET · POST · DELETE /providers/me/vehicles/:id/blocks…   days taken off sale
//   GET    /providers/me/performance     how each car is doing
//   GET    /providers/me/bookings        bookings across the fleet
//   GET    /providers/me/bookings/:id    one of them
//   GET    /providers/me/messages        conversations with renters
//   GET    /providers/me/messages/:id    one conversation
//   POST   /providers/me/messages/:id/messages   reply to it
//   POST   /providers/me/messages/:id/read       mark it read
//   PATCH  /providers/me/messages/:id    mark unread, pin, mute — your copy only
//   GET    /providers/me/payouts         what SXM Rentals has paid them
//   POST   /providers/me/payout-account  set up where the money goes
//   GET    /providers/me/payout-account  how that setup is going
//
// "me" is worked out from who is signed in, never from anything in the request,
// so there is no business id to tamper with. A business asking for another
// business's car or booking is told it does not exist.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { providers } from '../../db/schema/index.js';
import { AppError, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import type { PhotoStorage } from '../../lib/storage.js';
import type { PushService } from '../../services/push/index.js';
import type { DateChangeService } from '../../services/date-changes/index.js';
import { addBlock, listBlocks, removeBlock } from '../../services/vehicle-blocks/index.js';
import { confirmImport, importTemplateCsv, readImport } from '../../services/fleet-import/index.js';
import { addFleetRequestFile, createFleetRequest } from '../../services/fleet-requests/index.js';
import type { IntegrationService } from '../../services/integrations/index.js';
import {
  createPromotion,
  deletePromotion,
  listPromotions,
  setPromotionActive,
} from '../../services/promotions/index.js';
import { requireFeature } from '../../services/capabilities/index.js';
import { threadOptionsBody } from '../messages/index.js';
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
  getFleetVehicle,
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
  setOptionsAsProvider,
} from '../../services/messaging/index.js';
import { toProvider } from '../../services/serializers/vehicles.js';

export type ProviderRouteOptions = {
  db: Database;
  gateway: PaymentGateway;
  config: Config;
  storage: PhotoStorage;
  push: PushService;
  dateChanges: DateChangeService;
  integrations: IntegrationService;
};

// ---- WHAT EACH REQUEST MAY CONTAIN ----
const listQuery = z.object({
  side: z.enum(['dutch', 'french']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const idParam = z.object({ id: z.string().max(64) });
const photoParams = z.object({ id: z.string().max(64), photoId: z.string().max(64) });
const closeBody = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
const payoutStartBody = z.object({ returnTo: z.enum(['app', 'web']).optional() });
const dateChangeParams = z.object({ id: z.string().max(64), requestId: z.string().max(64) });
// The business's own words, shown to the renter as written.
const declineBody = z.object({ note: z.string().trim().max(500).optional() });
const blockBody = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  reason: z.enum(['servicing', 'private_hire', 'held_back', 'other']),
});
const blockParams = z.object({ id: z.string().max(64), blockId: z.string().max(64) });
const promotionBody = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9]{4,16}$/, 'A code is 4 to 16 letters and digits.'),
  percentOff: z.number().int().min(5).max(50),
  minDays: z.number().int().min(1).max(365).optional(),
  startsOn: z.iso.date().optional(),
  endsOn: z.iso.date().optional(),
  maxUses: z.number().int().min(1).max(100_000).optional(),
});
const promotionPatchBody = z.object({ active: z.boolean() });
// A file sent inside JSON, as base64. The size is checked again once decoded.
const uploadBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(1_000_000),
});
const importParams = z.object({ importId: z.string().max(64) });
const webhookBody = z.object({ url: z.string().trim().min(8).max(500) });
const fleetRequestBody = z.object({
  fleetSize: z.enum(['1-5', '6-10', '11-25', '26-50', '50+']),
  recordFormat: z.enum(['spreadsheet', 'software', 'paper', 'scattered']),
  contact: z.string().trim().min(3).max(200),
  notes: z.string().trim().max(2000).optional(),
});
const confirmBody = z.object({ rowNumbers: z.array(z.number().int().min(1).max(100_000)).min(1).max(200) });
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
  // Moving the business to the other side of the island. Only with a new town
  // on that side, and only by the owner — see updateBusinessProfile.
  side: z.enum(['dutch', 'french']).optional(),
});

// Prices arrive in dollars, the way they are typed on the form. The partner
// API takes the same fields.
export const vehicleBody = z.object({
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
  // The number plate, for the business and staff only.
  registration: z.string().trim().min(1).max(20).optional(),
  // Whether the accident question has been answered — true even for "none".
  accidentHistoryDeclared: z.boolean().optional(),
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
  // null takes a registration off, like a weekly rate.
  registration: z.string().trim().min(1).max(20).nullable().optional(),
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
    const { providerId, role } = await businessFor(request);
    const patch = parseInput(profilePatchBody, request.body);
    // Where the business is based is the owner's decision, not a colleague's.
    if (patch.side !== undefined && role !== 'owner') {
      throw new AppError(403, 'owner_only', 'Only the owner can move the business to the other side of the island.');
    }
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
    const vehicle = await addVehicle(db, providerId, body, config.vehicleApprovalRequired);
    return reply.status(201).send(vehicle);
  });

  app.get('/me/vehicles/:id', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    return getFleetVehicle(db, providerId, id);
  });

  // ---- ADDING CARS FROM A SPREADSHEET ----
  // The template is public: it holds nothing but the column headings.
  app.get('/import-template.csv', async (_request, reply) => {
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="sxm-rentals-fleet-template.csv"')
      .send(importTemplateCsv());
  });

  // Step 1: read the file and check every row. Nothing is saved as a car.
  app.post('/me/vehicles/import', { bodyLimit: 1_100_000 }, async (request, reply) => {
    requireFeature(config, 'fleetImport');
    const { providerId } = await businessFor(request);
    const result = await readImport(db, providerId, parseInput(uploadBody, request.body));
    return reply.status(201).send(result);
  });

  // Step 2: add the rows the business picked.
  app.post('/me/vehicles/import/:importId/confirm', async (request, reply) => {
    requireFeature(config, 'fleetImport');
    const { providerId } = await businessFor(request);
    const { importId } = parseInput(importParams, request.params);
    const { rowNumbers } = parseInput(confirmBody, request.body);
    return reply.status(201).send(await confirmImport(db, providerId, importId, rowNumbers, config.vehicleApprovalRequired));
  });

  // ---- ITS OWN BOOKING SYSTEM ----
  // The API's own address, for the partner API and its guide.
  const apiBase = (request: FastifyRequest) => `${request.protocol}://${request.host}`;

  // Making a key or disconnecting needs the owner, and their password again.
  const ownerWithPassword = async (request: FastifyRequest) => {
    const actor = requireCustomer(request);
    const { providerId, role } = await requireProviderFor(db, actor);
    if (role !== 'owner') throw new AppError(403, 'owner_only', 'Only the owner can connect or disconnect a booking system.');
    const { password } = parseInput(closeBody, request.body);
    await assertOwnPassword(db, actor.customerId, password);
    return providerId;
  };

  app.get('/me/integration', async (request) => {
    requireFeature(config, 'bookingSystem');
    const { providerId } = await businessFor(request);
    return options.integrations.get(providerId, apiBase(request));
  });

  app.post('/me/integration/key', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request, reply) => {
    requireFeature(config, 'bookingSystem');
    const providerId = await ownerWithPassword(request);
    return reply.status(201).send(await options.integrations.newKey(providerId));
  });

  app.put('/me/integration/webhook', async (request) => {
    requireFeature(config, 'bookingSystem');
    const { providerId } = await businessFor(request);
    const { url } = parseInput(webhookBody, request.body);
    return options.integrations.setWebhook(providerId, url, apiBase(request));
  });

  app.post('/me/integration/disconnect', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    requireFeature(config, 'bookingSystem');
    const providerId = await ownerWithPassword(request);
    return options.integrations.disconnect(providerId, apiBase(request));
  });

  // ---- "SEND IT TO US" ----
  app.post('/me/fleet-requests', async (request, reply) => {
    requireFeature(config, 'uploadRequest');
    const actor = requireCustomer(request);
    const { providerId } = await businessFor(request);
    const created = await createFleetRequest(db, providerId, actor.customerId, parseInput(fleetRequestBody, request.body));
    return reply.status(201).send(created);
  });

  // One file at a time, so no single request is large.
  app.post('/me/fleet-requests/:id/files', { bodyLimit: 1_100_000 }, async (request, reply) => {
    requireFeature(config, 'uploadRequest');
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const saved = await addFleetRequestFile(db, providerId, id, parseInput(uploadBody, request.body));
    return reply.status(201).send(saved);
  });

  // ---- ITS OWN DISCOUNT CODES ----
  app.get('/me/promotions', async (request) => {
    requireFeature(config, 'promotions');
    const { providerId } = await businessFor(request);
    return listPromotions(db, providerId);
  });

  app.post('/me/promotions', async (request, reply) => {
    requireFeature(config, 'promotions');
    const { providerId } = await businessFor(request);
    const promotion = await createPromotion(db, providerId, parseInput(promotionBody, request.body));
    return reply.status(201).send(promotion);
  });

  app.patch('/me/promotions/:id', async (request) => {
    requireFeature(config, 'promotions');
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const { active } = parseInput(promotionPatchBody, request.body);
    return setPromotionActive(db, providerId, id, active);
  });

  app.delete('/me/promotions/:id', async (request, reply) => {
    requireFeature(config, 'promotions');
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    await deletePromotion(db, providerId, id);
    return reply.status(204).send();
  });

  // ---- DAYS TAKEN OFF SALE ----
  app.get('/me/vehicles/:id/blocks', async (request) => {
    requireFeature(config, 'blockedDays');
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    return listBlocks(db, providerId, id);
  });

  app.post('/me/vehicles/:id/blocks', async (request, reply) => {
    requireFeature(config, 'blockedDays');
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const block = await addBlock(db, providerId, id, parseInput(blockBody, request.body));
    return reply.status(201).send(block);
  });

  app.delete('/me/vehicles/:id/blocks/:blockId', async (request, reply) => {
    requireFeature(config, 'blockedDays');
    const { providerId } = await businessFor(request);
    const { id, blockId } = parseInput(blockParams, request.params);
    await removeBlock(db, providerId, id, blockId);
    return reply.status(204).send();
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
  // Each member of the business has their own pins, mutes and unread marks,
  // so the person looking is passed along with the business.
  app.get('/me/messages', async (request) => {
    const { providerId } = await businessFor(request);
    return listThreadsForProvider(db, providerId, requireCustomer(request).customerId);
  });

  app.get('/me/messages/:id', async (request) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    return getThreadForProvider(db, providerId, id, requireCustomer(request).customerId);
  });

  app.patch('/me/messages/:id', async (request) => {
    requireFeature(config, 'messageOptions');
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const change = parseInput(threadOptionsBody, request.body);
    return setOptionsAsProvider(db, providerId, id, requireCustomer(request).customerId, change);
  });

  app.post('/me/messages/:id/messages', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(providerMessageBody, request.body);
    const thread = await replyAsProvider(db, providerId, id, body, requireCustomer(request).customerId);
    // The renter is told a message arrived — who from, never what it says.
    await options.push.messageFromBusiness(thread.id);
    return reply.status(201).send(thread);
  });

  // ---- ANSWERING A REQUEST FOR NEW DATES ----
  // Accepting changes the booking in one step: days checked again, dates moved,
  // lines re-priced, any refund queued. Answers with the booking as it now is.
  app.post('/me/bookings/:id/date-changes/:requestId/accept', async (request) => {
    const { providerId } = await businessFor(request);
    const { id, requestId } = parseInput(dateChangeParams, request.params);
    await options.dateChanges.accept(providerId, id, requestId);
    options.integrations.bookingChanged(providerId, id, 'booking.dates_changed');
    return getProviderBooking(db, providerId, id);
  });

  app.post('/me/bookings/:id/date-changes/:requestId/decline', async (request) => {
    const { providerId } = await businessFor(request);
    const { id, requestId } = parseInput(dateChangeParams, request.params);
    const { note } = parseInput(declineBody, request.body ?? {});
    await options.dateChanges.decline(providerId, id, requestId, { note });
    return getProviderBooking(db, providerId, id);
  });

  // Writing FIRST, about one of its own bookings — "we are at the Simpson Bay
  // office, ask for Marie". Until now a business could only reply, so it had to
  // wait for the renter to write. Tied to a booking of theirs, so a business
  // cannot open a conversation with any customer it likes.
  app.post('/me/bookings/:id/messages', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(providerMessageBody, request.body);
    const thread = await messageAboutBooking(db, providerId, id, body, requireCustomer(request).customerId);
    await options.push.messageFromBusiness(thread.id);
    return reply.status(201).send(thread);
  });

  app.post('/me/messages/:id/read', async (request, reply) => {
    const { providerId } = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    await markReadAsProvider(db, providerId, id, requireCustomer(request).customerId);
    return reply.status(204).send();
  });

  // ---- MONEY ----
  app.get('/me/payouts', async (request) => {
    const { providerId } = await businessFor(request);
    return listPayouts(db, providerId);
  });

  app.post('/me/payout-account', async (request) => {
    const { providerId } = await businessFor(request);
    const { returnTo } = parseInput(payoutStartBody, request.body ?? {});
    // From the phone app: Stripe sends them to the redirect below, which hands
    // over to the app, and the in-app browser closes itself when it sees that.
    const returnUrl =
      returnTo === 'app' ? `${request.protocol}://${request.host}/api/v1/providers/payout-return` : undefined;
    return startPayoutOnboarding(db, gateway, config, providerId, returnUrl);
  });

  // Where Stripe sends a business that set up payouts from the phone app. Stripe
  // only sends people to https addresses, so this one is ours, and all it does
  // is hand over to the app. The destination is fixed — never taken from the
  // request — so it cannot be used to send anybody anywhere else.
  app.get('/payout-return', async (_request, reply) => {
    return reply.redirect('sxmrentals://business/payout', 302);
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
