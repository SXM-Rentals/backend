// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The front door to the database layout. It gathers every
// table from the files beside it into one place, so the rest of the backend
// (and the migration tool) can import the whole schema from a single spot.
//
//   identity.ts    customers, passwords, sessions, email/reset link codes
//   providers.ts   rental businesses — public page, private profile, members
//   vehicles.ts    listings, photos, accident history, paperwork
//   bookings.ts    bookings, price lines, deposits, payouts, ledger, refunds,
//                  disputes, promo codes, reviews
//   engagement.ts  conversations, notifications, rewards, AI support drafts
//   admin.ts       staff accounts, audit log, platform settings
//   security.ts    rate-limit counters, handled Stripe messages

export * from './enums.js';
export * from './identity.js';
export * from './providers.js';
export * from './vehicles.js';
export * from './bookings.js';
export * from './engagement.js';
export * from './admin.js';
export * from './security.js';
