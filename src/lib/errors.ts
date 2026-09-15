// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Defines the "expected" kinds of failure — not signed in,
// not found, too many attempts, bad input — so any part of the backend can
// stop a request with a clear reason. The error handler turns these into the
// one consistent error response every app receives. Anything that is NOT one
// of these is treated as an unexpected fault and its details are hidden.

// ---- THE ERROR ITSELF ----
// statusCode: the HTTP status sent back (404, 429, ...)
// code:       a short, stable machine-readable name the apps can switch on
// message:    a sentence safe to show a person
// details:    optional extra information, e.g. which form fields were wrong
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// ---- SHORTCUTS FOR THE COMMON CASES ----

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = 'You need to be signed in to do that.') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You are not allowed to do that.') =>
  new AppError(403, 'forbidden', message);

// Also used when a record exists but belongs to someone else, so a caller can
// never learn whether an ID they guessed is real. See lib/ownership.ts.
export const notFound = (message = 'We could not find that.') =>
  new AppError(404, 'not_found', message);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const tooManyRequests = (retryAfterSeconds: number, message?: string) =>
  new AppError(
    429,
    'rate_limited',
    message ?? `Too many attempts. Please try again in ${retryAfterSeconds} seconds.`,
    { retryAfterSeconds },
  );
