// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: A customer's own rewards, under /api/v1/rewards:
//
//   GET /   points, level, how far to the next one, and the history
//
// It reads the rewards ledger and nothing else. How points are EARNED is not
// decided yet — until it is, they come only from staff adjustments in the admin
// panel — so nothing here invents a rule. Only while the owner has switched
// rewards on; the app says "coming soon" until then.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { requireCustomer } from '../../middleware/auth.js';
import type { AccountService } from '../../services/account/index.js';
import { requireFeature } from '../../services/capabilities/index.js';

export type RewardRouteOptions = { config: Config; account: AccountService };

export default async function rewardRoutes(app: FastifyInstance, options: RewardRouteOptions) {
  app.get('/', async (request) => {
    requireFeature(options.config, 'rewards');
    return options.account.rewards(requireCustomer(request));
  });
}
