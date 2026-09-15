// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Checks incoming data (a form body, a query string)
// against a written description of what it is allowed to look like, before
// any of it is used. Unknown fields are stripped, wrong types are rejected,
// and the caller gets a 400 listing exactly which fields were wrong. Every
// route passes its input through here — nothing from the outside world is
// trusted as-is.

import type { z } from 'zod';
import { badRequest } from './errors.js';

// Validates `data` against `schema`. Returns the cleaned, typed value, or
// stops the request with a list of problems like
// [{ field: "email", message: "Invalid email address" }].
export function parseInput<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
  throw badRequest('invalid_input', 'Some of the information sent was not valid.', details);
}
