// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Makes the unguessable random codes used for sign-in
// sessions, email-verification links and password-reset links, and turns each
// code into a one-way fingerprint before it is saved. Only the fingerprint is
// ever stored, so someone who got a copy of the database still could not use
// it to sign in as anybody or reset their password.

import { createHash, randomBytes } from 'node:crypto';

// A fresh random code: 32 bytes (256 bits), written in URL-safe characters so
// it can sit inside a link or a cookie without escaping.
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

// The one-way fingerprint (SHA-256) of a code. The same code always gives the
// same fingerprint, which is how a presented code is looked up — but the code
// cannot be worked back out from it. A fast hash is right here (unlike for
// passwords) because the codes are already long and fully random.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
