// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the switchboard the phone app reads to decide which
// screens to show — GET /api/v1/capabilities.
//
// The tests that matter most:
//
//   - the answer is ONLY true and false. It is public and kept on every phone,
//     so a key or an address slipping into it would be printed on a billboard;
//   - a feature is on only when it is built, set up AND switched on. Listing a
//     feature in the settings is not enough if its keys are missing, and a
//     feature that is not built yet can never be switched on at all;
//   - a switched-off feature's own addresses refuse, so the switch is backed by
//     the server rather than trusted to the phone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { capabilities, FEATURE_NAMES, isFeatureOn, requireFeature } from '../src/services/capabilities/index.js';
import { createTestContext, uniqueIp, WEB_ORIGIN, type TestContext } from './helpers.js';

// A set of settings, as the server would read them from Render.
const settings = (env: Record<string, string>) =>
  loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: WEB_ORIGIN, APP_URL: WEB_ORIGIN, ...env });

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('the public answer', () => {
  it('needs no sign-in, names every feature, and holds nothing but true and false', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/capabilities', remoteAddress: uniqueIp() });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...FEATURE_NAMES].sort());
    // Safe to print on a billboard: no key, no address, no price.
    expect(Object.values(body).every((value) => value === true || value === false)).toBe(true);
  });

  it('can be kept for five minutes, unlike every other answer', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/capabilities', remoteAddress: uniqueIp() });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('is all off when nothing has been switched on', () => {
    expect(Object.values(capabilities(settings({}))).every((value) => value === false)).toBe(true);
  });
});

describe('what makes a feature true', () => {
  it('needs the switch AND what the feature depends on', () => {
    // Switched on, but no Stripe keys: a payments screen would only fail.
    expect(isFeatureOn(settings({ FEATURES: 'payments' }), 'payments')).toBe(false);
    // Keys, but not switched on: the owner has not said yes.
    expect(isFeatureOn(settings({ STRIPE_SECRET_KEY: 'sk_test_x' }), 'payments')).toBe(false);
    // Both.
    expect(isFeatureOn(settings({ FEATURES: 'payments', STRIPE_SECRET_KEY: 'sk_test_x' }), 'payments')).toBe(true);
  });

  it('needs all three Cloudinary settings before photo uploads count', () => {
    const partial = settings({ FEATURES: 'photoUploads', CLOUDINARY_CLOUD_NAME: 'x', CLOUDINARY_API_KEY: 'y' });
    expect(isFeatureOn(partial, 'photoUploads')).toBe(false);
    const whole = settings({
      FEATURES: 'photoUploads',
      CLOUDINARY_CLOUD_NAME: 'x',
      CLOUDINARY_API_KEY: 'y',
      CLOUDINARY_API_SECRET: 'z',
    });
    expect(isFeatureOn(whole, 'photoUploads')).toBe(true);
  });

  it('accepts "all", and FEATURES_OFF takes one back out', () => {
    const everything = settings({ FEATURES: 'all', STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(isFeatureOn(everything, 'payments')).toBe(true);

    const allButPayments = settings({ FEATURES: 'all', FEATURES_OFF: 'payments', STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(isFeatureOn(allButPayments, 'payments')).toBe(false);
    expect(isFeatureOn(allButPayments, 'payouts')).toBe(true);
  });

  it('ignores a name it does not know, instead of failing to start', () => {
    const odd = settings({ FEATURES: 'payments, teleportation', STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(isFeatureOn(odd, 'payments')).toBe(true);
    expect(Object.keys(capabilities(odd))).not.toContain('teleportation');
  });
});

describe('a switched-off feature', () => {
  it('refuses its own addresses with feature_off', () => {
    let caught: unknown;
    try {
      requireFeature(settings({}), 'payments');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ statusCode: 503, code: 'feature_off' });
  });
});
