// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for a customer's own account, under
// /api/v1/customers. For now there is one:
//
//   GET /me   the signed-in person's own account, in the `User` shape the
//             website and phone app already use for the account screens
//
// There is deliberately no "/customers/:id" for customers — a person can only
// ever ask for their own record, so there is no ID to tamper with.

import type { FastifyInstance } from 'fastify';
import { requireCustomer } from '../../middleware/auth.js';
import type { AuthService } from '../../services/auth/index.js';

export type CustomerRouteOptions = { auth: AuthService };

export default async function customerRoutes(app: FastifyInstance, options: CustomerRouteOptions) {
  app.get('/me', async (request) => options.auth.getCurrentUser(requireCustomer(request)));
}
