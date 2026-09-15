// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Everything to do with passwords. It scrambles a
// password with Argon2id (a deliberately slow, salted method built to resist
// guessing) so the real password is never stored, checks a typed password
// against the saved scramble, enforces the minimum length, and asks the
// HaveIBeenPwned service whether a password has already leaked somewhere —
// without ever sending the password itself.

import { hash, verify } from '@node-rs/argon2';
import { createHash } from 'node:crypto';

// ---- THE RULES ----
// Length is what actually makes a password strong. There are deliberately no
// "must contain a symbol" rules; they push people toward weak-but-compliant
// passwords like "Password1!".
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// ---- SCRAMBLING AND CHECKING ----
// Argon2id is the library's default algorithm. These cost settings follow the
// OWASP recommendation (19 MiB memory, 2 passes).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

// True when `password` is the one that produced `passwordHash`. A malformed
// stored hash counts as "no match" rather than crashing the sign-in.
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// A real-looking hash to check against when no account exists, so a sign-in
// for an unknown email takes as long as one for a real account. Without it,
// the response time alone would reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('sxm-rentals-timing-equaliser-not-a-real-password');
  return dummyHash;
}

// ---- THE LEAKED-PASSWORD CHECK ----
export type BreachedPasswordChecker = {
  // True when the password appears in a known data breach.
  isBreached(password: string): Promise<boolean>;
};

type Logger = { warn: (obj: object, msg: string) => void };

// Asks HaveIBeenPwned using "k-anonymity": only the first 5 characters of the
// password's SHA-1 fingerprint leave this server, and the comparison against
// the returned list happens here. If the service is slow or down, sign-up is
// NOT blocked — the check is skipped and a warning is logged.
export function createHibpChecker(logger: Logger, fetchImpl: typeof fetch = fetch): BreachedPasswordChecker {
  return {
    async isBreached(password) {
      const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
      const prefix = sha1.slice(0, 5);
      const suffix = sha1.slice(5);
      try {
        const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'sxm-rentals-backend' },
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) throw new Error(`HaveIBeenPwned answered ${response.status}`);
        const body = await response.text();
        return body.split('\n').some((line) => {
          const [hashSuffix, count] = line.trim().split(':');
          return hashSuffix === suffix && Number(count) > 0;
        });
      } catch (error) {
        logger.warn({ err: error }, 'Leaked-password check unavailable; allowing password');
        return false;
      }
    },
  };
}

// Used when the check is switched off in settings, and in tests.
export const skipBreachedPasswordCheck: BreachedPasswordChecker = {
  isBreached: async () => false,
};
