// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The one doorway the backend uses to send an email
// (account verification links, password resets, and later booking
// confirmations and receipts). No real email provider is connected yet, so
// there are three stand-ins: on a developer's laptop the email is printed to
// the terminal so the link can be clicked; in tests it is kept in a list the
// test can read; and in production it is refused loudly rather than silently
// printing someone's password-reset link into the server logs. Resend or
// Postmark plugs in here later without any other file changing.

// ---- WHAT AN EMAIL IS ----
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type EmailSender = {
  send(message: EmailMessage): Promise<void>;
};

type Logger = {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

// ---- DEVELOPMENT: PRINT IT ----
// Prints the whole email, link included, to the terminal. Only ever used
// outside production, because the text contains single-use sign-in links.
export function createConsoleEmailSender(logger: Logger): EmailSender {
  return {
    async send(message) {
      logger.info({ email: message }, `Email (not sent, development mode): ${message.subject}`);
    },
  };
}

// ---- TESTS: KEEP IT ----
// Holds every email in `sent`, newest last, so a test can pull the link out.
export type MemoryEmailSender = EmailSender & { sent: EmailMessage[] };

export function createMemoryEmailSender(): MemoryEmailSender {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

// ---- PRODUCTION WITHOUT A PROVIDER: REFUSE ----
// Logs that an email could not be sent — without its contents — so the gap is
// visible in monitoring before launch.
export function createUnconfiguredEmailSender(logger: Logger): EmailSender {
  return {
    async send(message) {
      logger.error({ subject: message.subject }, 'No email provider is configured; email was not sent');
    },
  };
}
