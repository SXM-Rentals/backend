// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for bookings, under /api/v1/bookings.
//
//   POST /bookings/quote    what a rental would cost, before booking anything
//   POST /bookings          make a booking
//   GET  /bookings          your own bookings
//   GET  /bookings/:id      one of your own bookings
//   POST /bookings/:id/cancel  cancel one that has not started
//
// Everything except the price preview needs you to be signed in, and every
// query is tied to the signed-in person — so a booking that is not yours is
// simply "not found", exactly like one that does not exist.
//
// NO MONEY MOVES YET. A booking is recorded with its price worked out and its
// deposit listed as "not taken"; Stripe arrives in Phase 3.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import {
  cancelBooking,
  createBooking,
  getBookingFor,
  listBookingsFor,
  quoteFor,
} from '../../services/booking-engine/index.js';
import type { NotificationService } from '../../services/notifications/index.js';

export type BookingRouteOptions = { db: Database; notifications: NotificationService };

// A time of day as the apps send it, e.g. "10:00".
const timeField = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Please give a time like 10:00.');

const quoteBody = z.object({
  vehicleId: z.string().max(64),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  collection: z.enum(['pickup', 'delivery']).default('pickup'),
});

const createBody = quoteBody.extend({
  pickupTime: timeField.default('10:00'),
  returnTime: timeField.default('10:00'),
  location: z.string().trim().max(200).optional(),
});

const idParam = z.object({ id: z.string().max(64) });

export default async function bookingRoutes(app: FastifyInstance, options: BookingRouteOptions) {
  const { db, notifications } = options;

  // ---- WHAT WOULD THIS COST? ----
  // Public: the price is shown on a car's page before anyone signs in. The
  // deposit comes back beside the total, never inside it.
  app.post('/quote', async (request) => {
    const body = parseInput(quoteBody, request.body);
    const quote = await quoteFor(db, { ...body, pickupTime: '10:00', returnTime: '10:00' });
    return {
      days: quote.days,
      lines: quote.lines.map((line) => ({
        label: line.label,
        amount: line.amountCents / 100,
        ...(line.note ? { note: line.note } : {}),
      })),
      totalDueToday: quote.totalDueTodayCents / 100,
      depositAmount: quote.depositAmountCents / 100,
      available: quote.available,
    };
  });

  // ---- MAKE A BOOKING ----
  app.post('/', async (request, reply) => {
    const actor = requireCustomer(request);
    const body = parseInput(createBody, request.body);
    const booking = await createBooking(db, actor, body, notifications);
    return reply.status(201).send(booking);
  });

  // ---- YOUR BOOKINGS ----
  app.get('/', async (request) => listBookingsFor(db, requireCustomer(request)));

  app.get('/:id', async (request) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    return getBookingFor(db, actor, id);
  });

  app.post('/:id/cancel', async (request) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    return cancelBooking(db, actor, id, notifications);
  });
}
