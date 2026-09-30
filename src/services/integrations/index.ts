// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Connecting a business's own rental software to SXM
// Rentals. Its system sends us its cars, prices and unavailable days through the
// partner API (routes/partner) with an API key; we send each booking back to an
// https address it gives us (the bookings webhook).
//
// THE KEY. Shown once, in the answer that makes it; after that only its last
// four characters are ever sent. Only a hash of it is stored, like a password.
// Making a new key cancels the old one at once. Making a key and disconnecting
// both need the owner's password again.
//
// THE WEBHOOK. https only, and never a private address — checked when it is
// saved AND again, by looking the name up, every time something is sent, so a
// name that later points inside our network is still refused. Each message is
// signed so the business's system can tell it came from us: the signature is an
// HMAC-SHA256 of "<timestamp>.<body>", keyed with the SHA-256 of their API key
// (which they can work out from the key they were shown; we never keep the key).
//
// "failing" means their system stopped answering; lastError says what happened
// in words the owner can pass to their developer. The next message that gets
// through clears it.

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { providerBusinessProfiles, providerIntegrations, providers } from '../../db/schema/index.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { getProviderBooking } from '../provider/index.js';

export type BookingEvent = 'booking.created' | 'booking.cancelled' | 'booking.dates_changed';

// How long their system has to answer before it counts as not answering.
const DELIVERY_TIMEOUT_MS = 5_000;

// ---- PRIVATE ADDRESSES, WHICH A WEBHOOK MAY NEVER POINT AT ----
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true;
  // An IPv4 address written the IPv6 way (::ffff:10.0.0.1) is checked as IPv4.
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
  return PRIVATE.check(address, version === 6 ? 'ipv6' : 'ipv4');
}

// Looks a name up. Replaceable in tests, which have no internet.
export type Resolver = (hostname: string) => Promise<string[]>;
export const dnsResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const invalidUrl = (message: string) => badRequest('invalid_url', message);

export async function assertPublicHttpsUrl(value: string, resolve: Resolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl('That is not a web address. It should look like https://example.com/sxm-bookings.');
  }
  if (url.protocol !== 'https:') throw invalidUrl('The address has to start with https://.');
  if (url.username || url.password) throw invalidUrl('The address cannot carry a username or password.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw invalidUrl('The address has to be reachable on the internet, not a private network.');
  }
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw invalidUrl(`We could not find ${host} on the internet. Check the address with your developer.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw invalidUrl('The address has to be reachable on the internet, not a private network.');
  }
  return url;
}

// ---- THE KEY ----
export const API_KEY_PREFIX = 'sxm_live_';
export const hashKey = (apiKey: string) => createHash('sha256').update(apiKey).digest('hex');

function newApiKey(): string {
  // 32 characters of letters and digits: about 190 bits.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(32);
  return API_KEY_PREFIX + Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

type IntegrationRow = typeof providerIntegrations.$inferSelect;

export type IntegrationDeps = {
  db: Database;
  resolve?: Resolver;
  // The web request itself. Replaceable in tests.
  send?: typeof fetch;
  logger?: { warn: (details: object, message: string) => void };
};

export function createIntegrationService(deps: IntegrationDeps) {
  const { db } = deps;
  const resolve = deps.resolve ?? dnsResolver;
  const send = deps.send ?? fetch;
  // Deliveries still on their way, so a test (or a shutdown) can wait for them.
  const inFlight = new Set<Promise<void>>();

  async function load(providerId: string): Promise<IntegrationRow | undefined> {
    const [row] = await db.select().from(providerIntegrations).where(eq(providerIntegrations.providerId, providerId)).limit(1);
    return row;
  }

  // base: the API's own address, e.g. https://api.sxmrentals.app. The partner
  // API and its guide live under it.
  function view(row: IntegrationRow | undefined, base: string) {
    const connected = Boolean(row?.apiKeyHash);
    return {
      status: !connected ? 'not_connected' : row!.lastError ? 'failing' : 'connected',
      apiKeyLast4: connected ? row!.apiKeyLast4 : null,
      pushEndpoint: `${base}/partner/v1`,
      bookingsWebhook: row?.webhookUrl ?? null,
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      lastError: connected ? (row!.lastError ?? null) : null,
      docsUrl: `${base}/partner/v1/docs`,
    } as const;
  }

  // The business's own record says whether it is connected, too.
  async function mirrorOnProfile(providerId: string, connected: boolean) {
    await db.update(providerBusinessProfiles).set({ apiConnected: connected }).where(eq(providerBusinessProfiles.providerId, providerId));
  }

  async function deliver(providerId: string, bookingId: string, type: BookingEvent) {
    const row = await load(providerId);
    if (!row?.apiKeyHash || !row.webhookUrl) return;

    const booking = await getProviderBooking(db, providerId, bookingId);
    const body = JSON.stringify({ id: randomUUID(), type, createdAt: new Date().toISOString(), booking });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', row.apiKeyHash).update(`${timestamp}.${body}`).digest('hex');

    let problem: string | null = null;
    try {
      // Looked up again now: an address that was public when saved may not be.
      await assertPublicHttpsUrl(row.webhookUrl, resolve);
      const answer = await send(row.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'SXM-Rentals-Webhooks/1',
          'x-sxm-event': type,
          'x-sxm-signature': `t=${timestamp},v1=${signature}`,
        },
        body,
        // A redirect could lead anywhere, so it is not followed.
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (answer.status < 200 || answer.status >= 300) {
        problem = `Your system answered ${answer.status} to a booking we sent (${type}). It should answer 200.`;
      }
    } catch (error) {
      problem =
        error instanceof AppError
          ? `Your bookings webhook address was refused: ${error.message}`
          : (error as Error)?.name === 'TimeoutError'
            ? `Your system did not answer within ${DELIVERY_TIMEOUT_MS / 1000} seconds when we sent a booking (${type}).`
            : `We could not reach your system to send a booking (${type}). Check that the webhook address is up.`;
    }

    await db
      .update(providerIntegrations)
      .set(problem ? { lastError: `${problem} (${new Date().toISOString()})` } : { lastError: null, lastSyncedAt: new Date() })
      .where(eq(providerIntegrations.providerId, providerId));
    if (problem) deps.logger?.warn({ providerId, type }, 'Partner webhook delivery failed');
  }

  return {
    async get(providerId: string, base: string) {
      return view(await load(providerId), base);
    },

    // A new key; the old one stops working the moment this answers.
    async newKey(providerId: string) {
      const apiKey = newApiKey();
      const values = { apiKeyHash: hashKey(apiKey), apiKeyLast4: apiKey.slice(-4), lastError: null };
      await db
        .insert(providerIntegrations)
        .values({ providerId, ...values })
        .onConflictDoUpdate({ target: providerIntegrations.providerId, set: { ...values, updatedAt: new Date() } });
      await mirrorOnProfile(providerId, true);
      return { apiKey };
    },

    async setWebhook(providerId: string, url: string, base: string) {
      const checked = await assertPublicHttpsUrl(url, resolve);
      await db
        .insert(providerIntegrations)
        .values({ providerId, webhookUrl: checked.toString() })
        .onConflictDoUpdate({
          target: providerIntegrations.providerId,
          set: { webhookUrl: checked.toString(), lastError: null, updatedAt: new Date() },
        });
      return view(await load(providerId), base);
    },

    async disconnect(providerId: string, base: string) {
      await db
        .update(providerIntegrations)
        .set({ apiKeyHash: null, apiKeyLast4: null, webhookUrl: null, lastError: null, updatedAt: new Date() })
        .where(eq(providerIntegrations.providerId, providerId));
      await mirrorOnProfile(providerId, false);
      return view(await load(providerId), base);
    },

    // Who a partner API key belongs to — an open business — or 401.
    async businessForKey(authorization: string | undefined): Promise<string> {
      const key = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!key || !key.startsWith(API_KEY_PREFIX)) {
        throw new AppError(401, 'invalid_api_key', 'Send your API key as "Authorization: Bearer sxm_live_…".');
      }
      const [row] = await db
        .select({ providerId: providerIntegrations.providerId, lastSyncedAt: providerIntegrations.lastSyncedAt, closed: providers.deletedAt })
        .from(providerIntegrations)
        .innerJoin(providers, eq(providers.id, providerIntegrations.providerId))
        .where(eq(providerIntegrations.apiKeyHash, hashKey(key)))
        .limit(1);
      if (!row || row.closed) throw new AppError(401, 'invalid_api_key', 'That API key is not valid. It may have been replaced.');
      // "Last synced" moves at most once a minute, not on every call.
      if (!row.lastSyncedAt || Date.now() - row.lastSyncedAt.getTime() > 60_000) {
        await db.update(providerIntegrations).set({ lastSyncedAt: new Date() }).where(eq(providerIntegrations.providerId, row.providerId));
        await db
          .update(providerBusinessProfiles)
          .set({ apiLastSyncedAt: new Date() })
          .where(eq(providerBusinessProfiles.providerId, row.providerId));
      }
      return row.providerId;
    },

    // Tells the business's system about a booking. Never holds up, or fails,
    // the request that made the booking: it runs on its own, and a failure is
    // recorded as lastError rather than thrown.
    bookingChanged(providerId: string, bookingId: string, type: BookingEvent): void {
      const job = deliver(providerId, bookingId, type)
        .catch((error: unknown) => deps.logger?.warn({ providerId, error: String(error) }, 'Partner webhook crashed'))
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    },

    // Waits for every delivery on its way. Used by tests.
    async settled(): Promise<void> {
      await Promise.all([...inFlight]);
    },
  };
}

export type IntegrationService = ReturnType<typeof createIntegrationService>;
