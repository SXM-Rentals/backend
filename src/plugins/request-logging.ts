// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The settings for the server's activity log — one
// structured line per request and per problem, each tagged with a request ID
// that also appears in any error the apps receive, so a support message
// quoting that ID leads straight to the right log line.
//
// Passwords, sign-in codes, cookies and reset links are blanked out before
// anything is written, so the logs never become a second place secrets leak
// from. Tests run with logging switched off.

import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config.js';

// Anything at these paths is replaced with "[redacted]" in every log line.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
];

export function buildLoggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.env === 'test') return false;
  return {
    level: config.logLevel,
    redact: {
      // In production the whole email (which holds sign-in links) is hidden too.
      paths: config.isProduction ? [...REDACTED_PATHS, 'email'] : REDACTED_PATHS,
      censor: '[redacted]',
    },
  };
}
