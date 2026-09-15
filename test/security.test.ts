// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the protections that sit around every request
// rather than inside any one feature: the security headers, which websites may
// call the API, the block on forged cross-site requests, rate limiting, the
// single error shape (and that it never leaks internal details), the wall
// between rental businesses, and the settings checks that stop a
// misconfigured production server from starting.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { providerMembers } from '../src/db/schema/index.js';
import { assertProviderMember } from '../src/lib/ownership.js';
import {
  WEB_ORIGIN,
  createTestContext,
  createVerifiedAccount,
  seedBooking,
  signInWeb,
  uniqueIp,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext({
    // A route that fails unexpectedly, with a secret in its error message.
    extend: (app) => {
      app.get('/test/explode', async () => {
        throw new Error('connection to db-internal.neon.tech:5432 failed for user sxm_admin');
      });
    },
  });
});
afterAll(async () => {
  await ctx.close();
});

describe('security headers', () => {
  it('sends the protective headers on every response', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: uniqueIp() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('which websites may call the API (CORS)', () => {
  const preflight = (origin: string) =>
    ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: { origin, 'access-control-request-method': 'POST' },
      remoteAddress: uniqueIp(),
    });

  it('allows our own website', async () => {
    const res = await preflight(WEB_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives any other website no permission at all', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('forged cross-site requests', () => {
  it('refuses a cookie-signed change coming from another website, or from nowhere', async () => {
    const { email, password } = await createVerifiedAccount(ctx);
    const cookie = await signInWeb(ctx, email, password);
    const logout = (headers: Record<string, string>) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, ...headers }, remoteAddress: uniqueIp() });

    const foreign = await logout({ origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('forbidden');

    const noOrigin = await logout({});
    expect(noOrigin.statusCode).toBe(403);

    // Still signed in after both attempts; our own website can sign out.
    expect((await logout({ origin: WEB_ORIGIN })).statusCode).toBe(204);
  });
});

describe('rate limiting', () => {
  it('stops the 11th sign-in attempt in a minute from one address, saying when to retry', async () => {
    const remoteAddress = '203.0.113.50';
    const attempt = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'guessing@example.com', password: 'guess guess guess' },
        remoteAddress,
      });

    for (let i = 0; i < 10; i += 1) expect((await attempt()).statusCode).toBe(401);

    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json().error.code).toBe('rate_limited');
    expect(blocked.json().error.details.retryAfterSeconds).toBeGreaterThan(0);

    // A different limit (forgot password) is counted separately.
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email: 'guessing@example.com' },
      remoteAddress,
    });
    expect(other.statusCode).toBe(202);
  });
});

describe('the one error shape', () => {
  it('describes an unknown address in the standard shape', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nothing-here', remoteAddress: uniqueIp() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'route_not_found', message: expect.any(String), requestId: expect.any(String) },
    });
  });

  it('describes broken JSON without echoing internals', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
      remoteAddress: uniqueIp(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('never reveals the details of an unexpected failure', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/test/explode', remoteAddress: uniqueIp() });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal_error');
    expect(res.body).not.toMatch(/neon|5432|sxm_admin|stack|at /);
  });
});

describe('the wall between rental businesses', () => {
  it('lets a member act for their business and answers "not found" to everybody else', async () => {
    const { customer: owner, provider } = await seedBooking(ctx.db);
    const { customer: outsider } = await seedBooking(ctx.db);
    await ctx.db.insert(providerMembers).values({ providerId: provider.id, customerId: owner.id, role: 'owner' });

    const asActor = (customerId: string) => ({ customerId, sessionId: 'n/a', authMethod: 'bearer' as const });

    await expect(assertProviderMember(ctx.db, provider.id, asActor(owner.id))).resolves.toEqual({ role: 'owner' });
    await expect(assertProviderMember(ctx.db, provider.id, asActor(outsider.id))).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(assertProviderMember(ctx.db, 'not-a-real-id', asActor(owner.id))).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('settings checks', () => {
  it('refuses to start production without a database or with non-HTTPS origins', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'https://sxmrentals.com' })).toThrow(/DATABASE_URL/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', CORS_ORIGINS: 'http://sxmrentals.com' }),
    ).toThrow(/https/);
    expect(
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', CORS_ORIGINS: 'https://sxmrentals.com' })
        .isProduction,
    ).toBe(true);
  });
});
