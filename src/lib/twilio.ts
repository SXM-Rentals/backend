// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The only place that talks to Twilio, which carries calls
// inside the app and the text messages that sign somebody in.
//
// No Twilio library is needed for the three things done here:
//   - a short-lived ACCESS TOKEN for one phone's calling kit — a signed JWT, so
//     Twilio's secret keys stay on this server and the app only ever holds a
//     token that expires within the hour;
//   - SENDING A TEXT, one plain request to Twilio's messages address;
//   - CHECKING that a request claiming to come from Twilio really did, by its
//     signature, before anything it says is believed.
//
// Until the keys are set, the "unconfigured" version answers "not switched on"
// and never pretends: see services/capabilities.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

export type TwilioClient = {
  // Calls can be made: the voice keys are all set.
  voiceReady: boolean;
  // Texts can be sent: an account and a sender are set.
  smsReady: boolean;
  // A token for one person's calling kit, valid for ttlSeconds.
  accessToken(identity: string, options: { ttlSeconds: number; platform?: 'ios' | 'android' | undefined }): string;
  sendSms(to: string, body: string): Promise<void>;
  // Whether a request really came from Twilio.
  isGenuine(url: string, params: Record<string, string>, signature: string | undefined): boolean;
};

const base64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export function createTwilioClient(config: Config, logger?: { warn: (details: object, message: string) => void }): TwilioClient {
  const { twilio } = config;
  const voiceReady = Boolean(twilio.accountSid && twilio.authToken && twilio.apiKeySid && twilio.apiKeySecret && twilio.twimlAppSid);
  const smsReady = Boolean(twilio.accountSid && twilio.authToken && twilio.smsFrom);

  return {
    voiceReady,
    smsReady,

    accessToken(identity, { ttlSeconds, platform }) {
      if (!voiceReady) throw new Error('Twilio voice is not set up');
      const now = Math.floor(Date.now() / 1000);
      const pushCredential = platform === 'ios' ? twilio.pushCredentialIos : platform === 'android' ? twilio.pushCredentialAndroid : undefined;
      const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
      const payload = {
        jti: `${twilio.apiKeySid}-${now}-${randomUUID().slice(0, 8)}`,
        iss: twilio.apiKeySid,
        sub: twilio.accountSid,
        iat: now,
        nbf: now,
        exp: now + ttlSeconds,
        grants: {
          identity,
          voice: {
            incoming: { allow: true },
            outgoing: { application_sid: twilio.twimlAppSid },
            ...(pushCredential ? { push_credential_sid: pushCredential } : {}),
          },
        },
      };
      const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
      const signature = createHmac('sha256', twilio.apiKeySecret!).update(unsigned).digest('base64url');
      return `${unsigned}.${signature}`;
    },

    async sendSms(to, body) {
      if (!smsReady) throw new Error('Twilio texts are not set up');
      const form = new URLSearchParams({ To: to, Body: body });
      // A messaging service (MG…) or a plain sending number.
      if (twilio.smsFrom!.startsWith('MG')) form.set('MessagingServiceSid', twilio.smsFrom!);
      else form.set('From', twilio.smsFrom!);
      const answer = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (!answer.ok) {
        // Never the number or the code in the log: only what Twilio said.
        const detail = await answer.text().catch(() => '');
        logger?.warn({ status: answer.status, detail: detail.slice(0, 300) }, 'Twilio refused a text');
        throw new Error(`Twilio answered ${answer.status}`);
      }
    },

    // Twilio's rule: the full address, then every posted field sorted by name,
    // name and value run together, signed with HMAC-SHA1 using the auth token.
    isGenuine(url, params, signature) {
      if (!twilio.authToken || !signature) return false;
      const data = url + Object.keys(params).sort().map((key) => key + params[key]).join('');
      const expected = createHmac('sha1', twilio.authToken).update(data).digest();
      const given = Buffer.from(signature, 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
