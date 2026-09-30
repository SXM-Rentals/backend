// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The download link from the "copy of your data" email,
// under /api/v1/exports:
//
//   GET  /:token   a small page with a "Download my data" button
//   POST /:token   the button: the link is used up and the file is sent
//
// WHY TWO STEPS: mail programs open the links in an email to check them for
// danger. If opening the link downloaded the file, that check would use up the
// one-time link before the person ever saw it. A checker opens pages; it does
// not press buttons.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validate.js';
import type { AccountService } from '../../services/account/index.js';

export type ExportRouteOptions = { account: AccountService };

const tokenParam = z.object({ token: z.string().min(16).max(128) });

// Plain, self-contained, and nothing from outside: no scripts, no fonts.
const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your SXM Rentals data</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0e11;color:#f3f5f7;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;text-align:center}button{font:inherit;background:#3daeff;color:#04121d;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}p{color:#a2aab5}</style>
</head><body><main>${body}</main></body></html>`;

export default async function exportRoutes(app: FastifyInstance, options: ExportRouteOptions) {
  // A page this API serves directly, so it gets its own narrow rules: its own
  // styles, and a form that may only post back to this same address.
  const pageHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  };

  app.get('/:token', async (request, reply) => {
    const { token } = parseInput(tokenParam, request.params);
    const good = await options.account.exportLinkIsGood(token);
    return reply
      .headers(pageHeaders)
      .status(good ? 200 : 410)
      .send(
        good
          ? page(`<h1>Your SXM Rentals data</h1><p>One download, from this link. It is a file you can open in any text editor.</p>
<form method="post"><button type="submit">Download my data</button></form>`)
          : page('<h1>This link has already been used or has expired</h1><p>You can ask for a new copy from the app once a day.</p>'),
      );
  });

  app.post('/:token', async (request, reply) => {
    const { token } = parseInput(tokenParam, request.params);
    const data = await options.account.downloadExport(token);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', 'attachment; filename="sxm-rentals-my-data.json"')
      .send(JSON.stringify(data, null, 2));
  });
}
