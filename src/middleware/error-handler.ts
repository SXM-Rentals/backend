// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Catches every failure from every route and turns it into
// the same response shape, so the website, the admin panel and the phone app
// only ever have to understand one kind of error:
//
//   { "error": { "code": "not_found", "message": "...", "requestId": "..." } }
//
// Expected failures (not signed in, bad input, too many attempts) keep their
// own message. Anything unexpected is logged in full on the server but the
// caller only ever sees a generic sentence — never a stack trace, a database
// message or a file path, which would help an attacker map the system.

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';

// ---- THE ONE ERROR SHAPE ----
function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return reply.status(statusCode).send({
    error: {
      code,
      message,
      requestId: request.id,
      ...(details === undefined ? {} : { details }),
    },
  });
}

// Plain-language messages for Fastify's own "your request was malformed" errors
// (broken JSON, a body that is too large, an unsupported content type).
const CLIENT_ERROR_MESSAGES: Record<number, [code: string, message: string]> = {
  400: ['bad_request', 'The request could not be read.'],
  404: ['route_not_found', 'There is nothing at this address.'],
  405: ['method_not_allowed', 'That action is not allowed here.'],
  413: ['payload_too_large', 'The request is too large.'],
  415: ['unsupported_media_type', 'That type of content is not accepted.'],
  429: ['rate_limited', 'Too many requests. Please slow down and try again shortly.'],
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    // Failures the backend raised on purpose.
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, 'Application error');
      return sendError(request, reply, error.statusCode, error.code, error.message, error.details);
    }

    // Fastify rejecting a malformed request before it reached a route.
    const statusCode = error.statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const [code, message] = CLIENT_ERROR_MESSAGES[statusCode] ?? ['bad_request', 'The request could not be completed.'];
      return sendError(request, reply, statusCode, code, message);
    }

    // Everything else is a fault on our side: log it all, reveal nothing.
    request.log.error({ err: error }, 'Unexpected error');
    return sendError(request, reply, 500, 'internal_error', 'Something went wrong on our side. Please try again.');
  });

  // An address no route answers to.
  app.setNotFoundHandler((request, reply) =>
    sendError(request, reply, 404, 'route_not_found', 'There is nothing at this address.'),
  );
}
