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
  // The plain-text version, written to read properly on its own.
  text: string;
  // The designed version. Mail programs that cannot show it fall back to the
  // text above. Built by lib/email-templates.ts.
  html?: string;
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
      // Only the text version is printed: the designed one is hundreds of lines
      // of markup and would bury the link you are trying to click.
      logger.info(
        { email: { to: message.to, subject: message.subject, text: message.text, designed: Boolean(message.html) } },
        `Email (not sent, development mode): ${message.subject}`,
      );
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
