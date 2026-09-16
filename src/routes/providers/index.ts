// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for rental businesses, under
// /api/v1/providers.
//
//   GET /providers      the businesses on the platform
//   GET /providers/:id  one business's public page
//
// These return the PUBLIC half of a business only — what any customer may see.
// The private half (legal name, registration, the owner's own mobile, earnings)
// lives in another table and is never read here. The business's own dashboard
// endpoints, which do show that, arrive in Phase 5 behind a membership check.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { providers } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import { parseInput } from '../../lib/validate.js';
import { toProvider } from '../../services/serializers/vehicles.js';

export type ProviderRouteOptions = { db: Database };

const listQuery = z.object({
  side: z.enum(['dutch', 'french']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
const idParam = z.object({ id: z.string().max(64) });

export default async function providerRoutes(app: FastifyInstance, options: ProviderRouteOptions) {
  const { db } = options;

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
