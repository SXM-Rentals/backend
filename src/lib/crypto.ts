// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Makes the unguessable random codes used for sign-in
// sessions, email-verification links and password-reset links, and turns each
// code into a one-way fingerprint before it is saved. Only the fingerprint is
// ever stored, so someone who got a copy of the database still could not use
// it to sign in as anybody or reset their password.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

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

// ---- LOCKING A SECRET AWAY, AND GETTING IT BACK ----
// Used for values the backend has to be able to read again later, which rules
// out a one-way fingerprint — today that means staff two-factor secrets.
// Unlike the codes above, this is reversible, and only with the key held in the
// environment. Somebody with a copy of the database alone cannot read them.
//
// AES-256-GCM also detects tampering: altering a stored value makes it fail to
// unlock rather than quietly decoding to something else.

function readKey(encryptionKey: string | undefined): Buffer {
  if (!encryptionKey) {
    throw new AppError(
      503,
      'encryption_key_missing',
      'This feature is switched off because no encryption key is configured.',
    );
  }
  const key = Buffer.from(encryptionKey, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, written in base64');
  }
  return key;
}

// Returns "iv.tag.ciphertext", all base64 — everything needed to unlock it
// again except the key itself.
export function encryptSecret(plainText: string, encryptionKey: string | undefined): string {
  const key = readKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(stored: string, encryptionKey: string | undefined): string {
  const key = readKey(encryptionKey);
  const [iv, tag, encrypted] = stored.split('.');
  if (!iv || !tag || !encrypted) throw new Error('Stored secret is not in the expected form');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}
