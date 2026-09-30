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
    // The key used to encrypt the most sensitive stored values — today, staff
    // two-factor secrets. Without it, staff sign-in refuses to work rather than
    // storing a secret in plain text.
    ENCRYPTION_KEY: z.string().min(1).optional(),
    // Addresses allowed to reach the admin API, comma separated. Empty means no
    // address restriction (two-factor still applies).
    ADMIN_IP_ALLOWLIST: z.string().default(''),
    // The logo shown in emails. It MUST be reachable without signing in, or
    // mail programs show the alt text instead. Defaults to the website's own
    // copy; set this when the website is not public yet.
    EMAIL_LOGO_URL: z.string().min(1).optional(),
    // Resend. With no key, emails are printed to the terminal in development
    // and refused in production — never sent quietly into a void.
    RESEND_API_KEY: z.string().min(1).optional(),
    // Who emails appear to come from. Until a domain is verified with Resend,
    // its test address is the only one allowed, and only to your own inbox.
    EMAIL_FROM: z.string().min(3).default('SXM Rentals <onboarding@resend.dev>'),
    // Where a reply goes, if that should differ from the sender.
    EMAIL_REPLY_TO: z.string().min(3).optional(),
    // The social accounts, shown in every email's footer. Each is left out
    // until its account actually exists: the name is then plain words rather
    // than a link that goes nowhere, which reads as a broken website.
    SOCIAL_TIKTOK_URL: z.string().min(1).optional(),
    SOCIAL_INSTAGRAM_URL: z.string().min(1).optional(),
    SOCIAL_FACEBOOK_URL: z.string().min(1).optional(),
    // Cloudinary, where car photos are kept. Until these are set, the photo
    // endpoints answer "not switched on yet" rather than accepting a photo that
    // goes nowhere.
    CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
    CLOUDINARY_API_KEY: z.string().min(1).optional(),
    CLOUDINARY_API_SECRET: z.string().min(1).optional(),
    // Stripe. Until these are set, the payment and deposit endpoints answer
    // "not switched on yet" rather than pretending to take money.
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    CURRENCY: z.string().length(3).default('usd'),
    // How many proxies (Render, Cloudflare) sit in front of the server. Needed
    // to see each visitor's real address for rate limiting. 0 = none.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    // Which features the phone app may show, comma separated, or "all". A
    // feature also has to be built and set up before it counts as on — see
    // services/capabilities. Empty means none, which is safe: the app shows
    // "not connected yet" for everything.
    FEATURES: z.string().default(''),
    // Names taken back out of "all", for switching one feature off in a hurry.
    FEATURES_OFF: z.string().default(''),
  })
  // Production has stricter rules than a developer's laptop.
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'is required in production' });
    }
    if (!env.ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_KEY'],
        message: 'is required in production (staff two-factor secrets are encrypted with it)',
      });
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
  // Full address of the logo drawn at the top of every email.
  emailLogoUrl: string;
  resendApiKey: string | undefined;
  emailFrom: string;
  emailReplyTo: string | undefined;
  // TikTok, Instagram, Facebook, in the order they are shown.
  socialAccounts: { name: string; url: string | undefined }[];
  cloudinaryCloudName: string | undefined;
  cloudinaryApiKey: string | undefined;
  cloudinaryApiSecret: string | undefined;
  encryptionKey: string | undefined;
  adminIpAllowlist: string[];
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  currency: string;
  trustProxyHops: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  // The owner's feature switches. See services/capabilities.
  featuresOn: 'all' | string[];
  featuresOff: string[];
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
  const appUrl = env.APP_URL.replace(/\/+$/, '');
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: splitList(env.CORS_ORIGINS),
    appUrl,
    breachedPasswordCheck: env.BREACHED_PASSWORD_CHECK === 'true',
    emailLogoUrl: env.EMAIL_LOGO_URL ?? `${appUrl}/brand/logo-white.png`,
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    emailReplyTo: env.EMAIL_REPLY_TO,
    socialAccounts: [
      { name: 'TikTok', url: env.SOCIAL_TIKTOK_URL },
      { name: 'Instagram', url: env.SOCIAL_INSTAGRAM_URL },
      { name: 'Facebook', url: env.SOCIAL_FACEBOOK_URL },
    ],
    cloudinaryCloudName: env.CLOUDINARY_CLOUD_NAME,
    cloudinaryApiKey: env.CLOUDINARY_API_KEY,
    cloudinaryApiSecret: env.CLOUDINARY_API_SECRET,
    encryptionKey: env.ENCRYPTION_KEY,
    adminIpAllowlist: splitList(env.ADMIN_IP_ALLOWLIST),
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    currency: env.CURRENCY.toLowerCase(),
    trustProxyHops: env.TRUST_PROXY_HOPS,
    logLevel: env.LOG_LEVEL,
    featuresOn: env.FEATURES.trim().toLowerCase() === 'all' ? 'all' : splitList(env.FEATURES),
    featuresOff: splitList(env.FEATURES_OFF),
  };
}
