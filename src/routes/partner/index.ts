// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The partner API — the addresses a business's own rental
// software calls with its API key, under /partner/v1:
//
//   GET   /partner/v1/docs                       the developer guide (public)
//   GET   /partner/v1/vehicles                   its cars on SXM Rentals
//   POST  /partner/v1/vehicles                   add one (waits for staff approval)
//   PATCH /partner/v1/vehicles/:id               change its prices
//   PUT   /partner/v1/vehicles/:id/unavailable   the days it cannot be rented
//   GET   /partner/v1/bookings                   its bookings on SXM Rentals
//
// A key only ever reaches its own business's cars and bookings, and a booking
// carries no renter contact details — the same rule as everywhere else.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gt, gte, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { bookings, vehicleBlocks } from '../../db/schema/index.js';
import { badRequest } from '../../lib/errors.js';
import { parseInput } from '../../lib/validate.js';
import { today } from '../../services/availability-engine/index.js';
import { requireFeature } from '../../services/capabilities/index.js';
import type { IntegrationService } from '../../services/integrations/index.js';
import { addVehicle, listFleet, listProviderBookings, ownVehicleId, updateVehicle } from '../../services/provider/index.js';
import { vehicleBody } from '../providers/index.js';

export type PartnerRouteOptions = { db: Database; config: Config; integrations: IntegrationService };

const idParam = z.object({ id: z.string().max(64) });
const pricesBody = z
  .object({
    dailyRate: z.number().positive().max(10_000).optional(),
    weeklyRate: z.number().positive().max(70_000).nullable().optional(),
    depositAmount: z.number().min(0).max(100_000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send dailyRate, weeklyRate or depositAmount.');
const unavailableBody = z.object({
  periods: z.array(z.object({ startDate: z.iso.date(), endDate: z.iso.date() })).max(200),
});

export default async function partnerRoutes(app: FastifyInstance, options: PartnerRouteOptions) {
  const { db, config, integrations } = options;

  const businessFor = async (request: FastifyRequest) => {
    requireFeature(config, 'bookingSystem');
    return integrations.businessForKey(request.headers.authorization);
  };

  app.get('/docs', async (_request, reply) =>
    reply.header('content-type', 'text/plain; charset=utf-8').send(PARTNER_GUIDE),
  );

  app.get('/vehicles', async (request) => listFleet(db, await businessFor(request)));

  app.post('/vehicles', async (request, reply) => {
    const providerId = await businessFor(request);
    const vehicle = await addVehicle(db, providerId, parseInput(vehicleBody, request.body), config.vehicleApprovalRequired);
    return reply.status(201).send(vehicle);
  });

  app.patch('/vehicles/:id', async (request) => {
    const providerId = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    return updateVehicle(db, providerId, id, parseInput(pricesBody, request.body));
  });

  // The whole list of days the car cannot be rented, as the business's system
  // sees them. Replaces what that system sent before; blocks the owner made by
  // hand in the app are left alone. Days already booked on SXM Rentals are
  // named back, so the business's system can see a double booking at once.
  app.put('/vehicles/:id/unavailable', async (request) => {
    const providerId = await businessFor(request);
    const { id } = parseInput(idParam, request.params);
    const vehicleId = await ownVehicleId(db, providerId, id);
    const { periods } = parseInput(unavailableBody, request.body);
    const from = today();
    for (const period of periods) {
      if (period.endDate < period.startDate) {
        throw badRequest('invalid_dates', `${period.startDate} to ${period.endDate}: the last day is before the first.`);
      }
    }
    // Days already over are left out; the rest is kept from today.
    const upcoming = periods
      .filter((period) => period.endDate >= from)
      .map((period) => ({ startDate: period.startDate < from ? from : period.startDate, endDate: period.endDate }));

    const clashes = new Set<string>();
    await db.transaction(async (tx) => {
      await tx
        .delete(vehicleBlocks)
        .where(and(eq(vehicleBlocks.vehicleId, vehicleId), eq(vehicleBlocks.source, 'partner'), gte(vehicleBlocks.endDate, from)));
      for (const period of upcoming) {
        await tx.insert(vehicleBlocks).values({ vehicleId, ...period, reason: 'other', source: 'partner' });
        const booked = await tx
          .select({ reference: bookings.reference })
          .from(bookings)
          .where(
            and(
              eq(bookings.vehicleId, vehicleId),
              ne(bookings.status, 'cancelled'),
              lte(bookings.startDate, period.endDate),
              gt(bookings.endDate, period.startDate),
            ),
          );
        for (const row of booked) clashes.add(row.reference);
      }
    });
    return { periods: upcoming.length, alreadyBookedOnSxm: [...clashes] };
  });

  app.get('/bookings', async (request) => listProviderBookings(db, await businessFor(request)));
}

const PARTNER_GUIDE = `SXM Rentals partner API — a guide for developers
================================================

Your rental software can keep your cars, prices and unavailable days in step
with SXM Rentals, and hear about every booking made on SXM Rentals.

1. Your API key
---------------
The business owner makes it in the SXM Rentals app: Fleet -> Add vehicles ->
Connect your system. It is shown ONCE. Making a new key cancels the old one.
Send it on every request:

    Authorization: Bearer sxm_live_...

2. Addresses (all under /partner/v1, JSON in and out, amounts in dollars)
-------------------------------------------------------------------------
GET   /vehicles                 Your cars, including ones waiting for approval.
POST  /vehicles                 Add a car. Same fields as the app's car form:
                                make, model, year, vehicleClass (economy,
                                compact, suv, van, fourByFour, luxury),
                                transmission (automatic, manual), fuel (petrol,
                                diesel, hybrid, electric), seats, doors,
                                dailyRate, depositAmount, pickupTown, side
                                (dutch, french), latitude, longitude; optional
                                weeklyRate, registration, description.
                                New cars wait for SXM Rentals staff to approve.
PATCH /vehicles/{id}            Prices: dailyRate, weeklyRate (null removes
                                it), depositAmount.
PUT   /vehicles/{id}/unavailable
                                { "periods": [ { "startDate": "2026-10-12",
                                "endDate": "2026-10-14" } ] }
                                Both dates count. Send the WHOLE list each time:
                                it replaces what you sent before. Blocks the
                                owner made by hand in the app are not touched.
                                The answer names any SXM Rentals booking that
                                already falls on those days.
GET   /bookings                 Your bookings on SXM Rentals. A renter is shown
                                by first name and initial only; SXM Rentals
                                never shares a renter's phone or email.

3. Bookings sent to you
-----------------------
Give SXM Rentals an https address in the app. We POST to it when a booking is
made (booking.created), cancelled (booking.cancelled) or moved to new dates
(booking.dates_changed):

    { "id": "...", "type": "booking.created", "createdAt": "...",
      "booking": { ...as GET /bookings } }

Answer 200 within 5 seconds. Anything else shows as "failing" in the app, with
what went wrong, until a later message gets through.

Every message is signed. The header looks like:

    X-SXM-Signature: t=1760000000,v1=5f2c...

To check it: take the SHA-256 of your API key, written as hex — that is your
signing secret. Compute HMAC-SHA256 of "<t>.<the raw request body>" with it, and
compare with v1. Refuse a message whose t is more than 5 minutes old.

4. Errors
---------
Every error is { "error": { "code": "...", "message": "..." } }. 401
invalid_api_key means the key is wrong or was replaced; 503 feature_off means
connecting booking systems is not switched on yet.
`;
