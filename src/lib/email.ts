// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The one doorway the backend uses to send an email —
// confirmation links, password resets, booking confirmations, deposit news.
//
// There are four ways of sending, and which one is used is decided in app.ts:
//   - RESEND, the real one, used as soon as RESEND_API_KEY is set;
//   - on a developer's laptop with no key, the email is printed to the terminal
//     so the link in it can be clicked;
//   - in tests it is kept in a list the test can read;
//   - in production with no key it is refused loudly, rather than silently
//     printing somebody's password-reset link into the server logs.
//
// Whichever is used, the message itself is drawn by lib/email-templates.ts, so
// every email looks the same wherever it was sent from.

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

// ---- THE REAL ONE: RESEND ----
// Only the small part of Resend we use, written out here so a test can hand in
// a stand-in and nothing has to reach the internet.
export type ResendLike = {
  emails: {
    send(payload: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html?: string;
      replyTo?: string;
    }): Promise<{ data: { id: string } | null; error: { message: string; name?: string } | null }>;
  };
};

export type ResendOptions = {
  apiKey: string;
  // Who the email appears to come from, e.g. "SXM Rentals <bookings@sxmrentals.com>".
  from: string;
  // Where a reply goes, when that should differ from the sender.
  replyTo?: string | undefined;
  logger: Logger;
  // Only for tests.
  client?: ResendLike;
};

export function createResendEmailSender(options: ResendOptions): EmailSender {
  // Built lazily so importing this file never needs the key.
  let client = options.client;

  return {
    async send(message) {
      if (!client) {
        const { Resend } = await import('resend');
        client = new Resend(options.apiKey) as unknown as ResendLike;
      }

      const { data, error } = await client.emails.send({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      });

      // Resend reports a refusal in the answer rather than by throwing, so an
      // unchecked call would look like it worked. The address is logged, the
      // contents never are.
      if (error) {
        options.logger.error(
          { to: message.to, subject: message.subject, reason: error.message },
          'Email was refused by Resend',
        );
        throw new Error(`Email could not be sent: ${error.message}`);
      }

      options.logger.info({ to: message.to, subject: message.subject, id: data?.id }, 'Email sent');
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
