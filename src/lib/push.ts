// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The one place that actually sends a push to a phone,
// through Expo's push service — and a stand-in that sends nothing until Expo is
// set up.
//
// THE ACCESS TOKEN STAYS HERE. With Expo's "enhanced push security" switched on,
// a push is only accepted with this token, which lives on Render and nowhere
// else. Without it, anybody who learned a phone's push address could send to
// that phone as SXM Rentals.
//
// WHAT A PUSH SAYS is decided by the callers, not here, and it is shown on a
// locked phone for anybody at the table to read: never a phone number, an email
// address, the text of a message, card details or an amount of money.

export type PushMessage = {
  // The phone's Expo address, "ExponentPushToken[…]".
  to: string;
  title: string;
  body: string;
  // Only where to go when it is tapped — never anything personal.
  data: { type: string; id: string };
};

// What Expo says straight away about each message, in the same order.
export type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type PushReceipt = { status: 'ok' | 'error'; details?: { error?: string } };

export type PushSender = {
  // Whether anything is actually sent. False until Expo is set up.
  readonly live: boolean;
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>>;
};

const EXPO_SEND = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS = 'https://exp.host/--/api/v2/push/getReceipts';
// Expo takes at most 100 messages, and 1000 receipt ids, in one request.
const SEND_BATCH = 100;
const RECEIPT_BATCH = 1000;

export function createExpoPushSender(options: {
  accessToken: string;
  logger: { warn: (obj: object, msg: string) => void };
  // Only for tests.
  fetchImpl?: typeof fetch;
}): PushSender {
  const call = options.fetchImpl ?? fetch;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${options.accessToken}`,
  };

  return {
    live: true,

    async send(messages) {
      const tickets: PushTicket[] = [];
      for (let start = 0; start < messages.length; start += SEND_BATCH) {
        const batch = messages.slice(start, start + SEND_BATCH).map((message) => ({ ...message, sound: 'default' }));
        const response = await call(EXPO_SEND, { method: 'POST', headers, body: JSON.stringify(batch) });
        const payload = (await response.json().catch(() => ({}))) as { data?: PushTicket[] };
        if (!response.ok || !Array.isArray(payload.data)) {
          options.logger.warn({ status: response.status }, 'Expo would not take a batch of pushes');
          // Keep the list in step with the messages, so each ticket still
          // lines up with its phone.
          tickets.push(...batch.map(() => ({ status: 'error' as const, message: 'Not accepted by Expo' })));
          continue;
        }
        tickets.push(...payload.data);
      }
      return tickets;
    },

    async receipts(ticketIds) {
      const all: Record<string, PushReceipt> = {};
      for (let start = 0; start < ticketIds.length; start += RECEIPT_BATCH) {
        const ids = ticketIds.slice(start, start + RECEIPT_BATCH);
        const response = await call(EXPO_RECEIPTS, { method: 'POST', headers, body: JSON.stringify({ ids }) });
        const payload = (await response.json().catch(() => ({}))) as { data?: Record<string, PushReceipt> };
        Object.assign(all, payload.data ?? {});
      }
      return all;
    },
  };
}

// Before Expo is set up: nothing is sent, and nothing pretends it was.
export function createDisabledPushSender(): PushSender {
  return {
    live: false,
    async send() {
      return [];
    },
    async receipts() {
      return {};
    },
  };
}
