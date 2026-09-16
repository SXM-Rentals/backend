// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Reads every setting the backend needs (which database,
// which port, which websites may call it) from the environment, checks each
// one, and hands back a single tidy settings object. If something required is
// missing or malformed, the server refuses to start and prints exactly which
// setting is wrong — far better than starting half-configured and failing on
// the first real request. Secrets are only ever read from the environment,
// never written into code.

import { z } from 'zod';

// ---- WHAT A VALID SET OF SETTINGS LOOKS LIKE ----
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    DATABASE_URL: z.string().min(1).optional(),
    CORS_ORIGINS: z.string().default(''),
    APP_URL: z.string().min(1).default('http://localhost:3000'),
    BREACHED_PASSWORD_CHECK: z.enum(['true', 'false']).default('true'),
    // Stripe. Until these are set, the payment and deposit endpoints answer
    // "not switched on yet" rather than pretending to take money.
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    CURRENCY: z.string().length(3).default('usd'),
    // How many proxies (Render, Cloudflare) sit in front of the server. Needed
    // to see each visitor's real address for rate limiting. 0 = none.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  // Production has stricter rules than a developer's laptop.
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'is required in production' });
    }
    for (const origin of splitList(env.CORS_ORIGINS)) {
      if (!origin.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGINS'],
          message: `"${origin}" must use https in production`,
        });
      }
    }
  });

// The settings object the rest of the backend actually uses.
export type Config = {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  databaseUrl: string | undefined;
  corsOrigins: string[];
  appUrl: string;
  breachedPasswordCheck: boolean;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  currency: string;
  trustProxyHops: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

// Turns "a, b ,c" into ["a", "b", "c"], dropping blanks.
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// ---- LOADING THE SETTINGS ----
// Reads the environment, treats empty values as "not set", validates, and
// either returns the settings or stops with a readable list of problems.
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(cleaned);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(settings)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`The backend's settings are not valid:\n${problems}`);
  }

  const env = result.data;
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: splitList(env.CORS_ORIGINS),
    appUrl: env.APP_URL.replace(/\/+$/, ''),
    breachedPasswordCheck: env.BREACHED_PASSWORD_CHECK === 'true',
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    currency: env.CURRENCY.toLowerCase(),
    trustProxyHops: env.TRUST_PROXY_HOPS,
    logLevel: env.LOG_LEVEL,
  };
}
