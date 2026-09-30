// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The switchboard. It says which features are switched on,
// so the phone app can turn a screen on the day its feature is ready — with no
// new app release, which takes days to reach people through store review.
//
// A FEATURE IS ON ONLY WHEN THREE THINGS ARE ALL TRUE:
//
//   1. it is BUILT here. A feature that is not finished can never be switched
//      on, whatever the settings say — a screen that calls an address which does
//      not exist yet is worse than a screen that says "not connected yet";
//   2. anything it NEEDS is set up — Stripe's keys for payments, Cloudinary's for
//      photos, and so on;
//   3. the owner has SWITCHED IT ON, in the FEATURES setting on Render.
//
// The answer is only ever true or false, the same for everybody, and public. It
// is kept on every phone, so it must never carry a key, an address, a price or a
// message — nothing that would matter if it were printed on a billboard.
//
// A SWITCH TELLS THE APP WHAT TO SHOW; IT IS NOT A LOCK. The server still checks
// everything: a new feature's own addresses refuse with 503 feature_off while it
// is off (requireFeature below), so an old or altered copy of the app cannot use
// it anyway.

import type { Config } from '../../config.js';
import { AppError } from '../../lib/errors.js';

// Every name the phone app reads. The app treats any name it does not see as
// off, so a name can be added here before or after the app learns it, and one
// can be dropped without breaking an older app.
export const FEATURE_NAMES = [
  'payments',
  'paymentMethods',
  'payouts',
  'identity',
  'push',
  'photoUploads',
  'rewards',
  'editProfile',
  'savedCars',
  'support',
  'refunds',
  'dateChanges',
  'agreementDrawing',
  'fleetImport',
  'bookingSystem',
  'uploadRequest',
  'promotions',
  'blockedDays',
  'deleteNotifications',
  'dataExport',
  'messageOptions',
  'phoneSignIn',
  'calls',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

type Feature = {
  // Whether the addresses behind it exist in this backend yet. Flipped to true
  // in the same change that builds the feature, never before.
  built: boolean;
  // What else has to be set up before it can work. Most features need nothing.
  ready?: (config: Config) => boolean;
};

const stripe = (config: Config) => Boolean(config.stripeSecretKey);
const cloudinary = (config: Config) =>
  Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);

const FEATURES: Record<FeatureName, Feature> = {
  payments: { built: true, ready: stripe },
  paymentMethods: { built: true, ready: stripe },
  payouts: { built: true, ready: stripe },
  // Staff checks need nothing set up; Stripe Identity needs Stripe's keys.
  identity: { built: true, ready: (config) => config.identityMethod === 'staff' || stripe(config) },
  push: { built: true, ready: (config) => Boolean(config.expoAccessToken) },
  photoUploads: { built: true, ready: cloudinary },
  rewards: { built: true },
  editProfile: { built: true },
  savedCars: { built: true },
  support: { built: true },
  refunds: { built: true },
  dateChanges: { built: true },
  agreementDrawing: { built: false },
  fleetImport: { built: false },
  bookingSystem: { built: false },
  uploadRequest: { built: false },
  promotions: { built: true },
  blockedDays: { built: true },
  deleteNotifications: { built: true },
  dataExport: { built: true },
  messageOptions: { built: true },
  phoneSignIn: { built: false },
  calls: { built: false },
};

// Whether the owner has switched it on. FEATURES is a comma-separated list of
// names, or "all"; FEATURES_OFF takes names back out of "all", so one feature
// can be switched off in an emergency without listing every other one.
function switchedOn(config: Config, name: FeatureName): boolean {
  if (config.featuresOff.includes(name)) return false;
  return config.featuresOn === 'all' || config.featuresOn.includes(name);
}

export function isFeatureOn(config: Config, name: FeatureName): boolean {
  const feature = FEATURES[name];
  return feature.built && (feature.ready?.(config) ?? true) && switchedOn(config, name);
}

// The whole answer, every name present — true or false, nothing else.
export function capabilities(config: Config): Record<FeatureName, boolean> {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, isFeatureOn(config, name)])) as Record<
    FeatureName,
    boolean
  >;
}

// Refuses a switched-off feature's own addresses. 503 rather than 404: the
// address exists, the feature is simply not on, and the app reads feature_off
// as "treat this as off" the same way it reads a false switch.
export function requireFeature(config: Config, name: FeatureName): void {
  if (!isFeatureOn(config, name)) {
    throw new AppError(503, 'feature_off', 'This is not switched on yet.');
  }
}
