// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Adds protective instructions to every response the API
// sends, telling browsers to:
//   - only ever talk to us over HTTPS, for two years (HSTS);
//   - never guess a file's type from its contents (stops some script tricks);
//   - never show our responses inside another site's frame (clickjacking);
//   - never load scripts, styles or anything else from a response — this is a
//     data API, not a web page, so the Content-Security-Policy allows nothing;
//   - never pass our addresses on to other sites, never use the camera,
//     microphone or location for us, and never cache account data.

import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Account data must never be kept by a shared computer's browser or a proxy.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });
}
