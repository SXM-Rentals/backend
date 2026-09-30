// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for calls inside the app, under
// /api/v1/calls. See services/calls for how a call goes.
//
//   POST /calls                   call the other side of a conversation
//   POST /calls/register          a token so this phone can ring for calls
//   POST /calls/:id/answer        pick up
//   POST /calls/:id/decline       turn it down
//   POST /calls/:id/end           hang up
//   POST /calls/twiml             Twilio asking who to ring (signed by Twilio)
//   POST /calls/:id/dial-status   Twilio saying how it finished (signed)
//
// "Emergency 911" is never routed through here: it is always a real phone call
// from the app, and nothing should stand between somebody and help.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { TwilioClient } from '../../lib/twilio.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import { notFromTwilio, type CallService } from '../../services/calls/index.js';
import { requireFeature } from '../../services/capabilities/index.js';

export type CallRouteOptions = { config: Config; calls: CallService; twilio: TwilioClient };

const idParam = z.object({ id: z.string().max(64) });
const platform = z.enum(['ios', 'android']);
const startBody = z.object({ threadId: z.string().max(64), platform: platform.optional() });
const registerBody = z.object({ platform });
const answerBody = z.object({ platform: platform.optional() });

export default async function callRoutes(app: FastifyInstance, options: CallRouteOptions) {
  const { config, calls, twilio } = options;

  // Twilio posts forms, not JSON. Read only here.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const here = (request: FastifyRequest) => `${request.protocol}://${request.host}`;

  // A request from Twilio, or nothing at all.
  const twilioParams = (request: FastifyRequest): Record<string, string> => {
    const params = (request.body ?? {}) as Record<string, string>;
    const signature = request.headers['x-twilio-signature'];
    if (!twilio.isGenuine(`${here(request)}${request.url}`, params, typeof signature === 'string' ? signature : undefined)) {
      throw notFromTwilio();
    }
    return params;
  };
  const xml = (reply: FastifyReply, body: string) => reply.header('content-type', 'text/xml; charset=utf-8').send(body);

  app.post('/', async (request, reply) => {
    requireFeature(config, 'calls');
    const actor = requireCustomer(request);
    const { threadId, platform: from } = parseInput(startBody, request.body);
    return reply.status(201).send(await calls.start(actor, threadId, from));
  });

  app.post('/register', async (request) => {
    requireFeature(config, 'calls');
    const actor = requireCustomer(request);
    return calls.register(actor, parseInput(registerBody, request.body).platform);
  });

  app.post('/:id/answer', async (request) => {
    requireFeature(config, 'calls');
    const actor = requireCustomer(request);
    const { id } = parseInput(idParam, request.params);
    return calls.answer(actor, id, parseInput(answerBody, request.body ?? {}).platform);
  });

  app.post('/:id/decline', async (request, reply) => {
    requireFeature(config, 'calls');
    const actor = requireCustomer(request);
    await calls.decline(actor, parseInput(idParam, request.params).id);
    return reply.status(204).send();
  });

  app.post('/:id/end', async (request, reply) => {
    requireFeature(config, 'calls');
    const actor = requireCustomer(request);
    await calls.end(actor, parseInput(idParam, request.params).id);
    return reply.status(204).send();
  });

  app.post('/twiml', async (request, reply) => {
    const params = twilioParams(request);
    const statusUrl = (callId: string) => `${here(request)}/api/v1/calls/${callId}/dial-status`;
    return xml(reply, await calls.whoToRing(params, statusUrl));
  });

  app.post('/:id/dial-status', async (request, reply) => {
    const params = twilioParams(request);
    await calls.dialFinished(parseInput(idParam, request.params).id, params);
    return xml(reply, '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });
}
