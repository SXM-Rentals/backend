// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests the part that hands a finished email to Resend for
// delivery. Resend itself is stood in for, so these tests never touch the
// internet and never need a real key.
//
// The test that matters most: when Resend refuses an email — wrong key, a
// domain that is not verified, a recipient it will not deliver to — the refusal
// is noticed and raised, instead of the backend telling the customer "check your
// inbox" for an email that was never sent.

import { describe, expect, it } from 'vitest';
import { createResendEmailSender, createUnconfiguredEmailSender, type ResendLike } from '../src/lib/email.js';

// A stand-in for Resend: remembers what it was asked to send, and can be told
// to refuse, exactly as the real one does when a key or domain is wrong.
function fakeResend(refusal?: string) {
  const calls: Parameters<ResendLike['emails']['send']>[0][] = [];
  const client: ResendLike = {
    emails: {
      async send(payload) {
        calls.push(payload);
        if (refusal) return { data: null, error: { message: refusal, name: 'validation_error' } };
        return { data: { id: 'sent-1' }, error: null };
      },
    },
  };
  return { client, calls };
}

// Collects what was logged so the tests can check the address is recorded and
// the email's contents are not.
function fakeLogger() {
  const lines: { level: 'info' | 'error'; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    lines,
    info: (obj: object, msg: string) => lines.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
    error: (obj: object, msg: string) => lines.push({ level: 'error', obj: obj as Record<string, unknown>, msg }),
  };
}

describe('sending email through Resend', () => {
  it('passes the designed and plain-text versions, the sender and the reply address', async () => {
    const { client, calls } = fakeResend();
    const logger = fakeLogger();
    const sender = createResendEmailSender({
      apiKey: 'test-key',
      from: 'SXM Rentals <bookings@sxmrentals.app>',
      replyTo: 'help@sxmrentals.app',
      logger,
      client,
    });

    await sender.send({
      to: 'customer@example.com',
      subject: 'Confirm your email address',
      text: 'Open this link to confirm: https://example.com/confirm',
      html: '<p>Open this link to confirm</p>',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      from: 'SXM Rentals <bookings@sxmrentals.app>',
      to: 'customer@example.com',
      subject: 'Confirm your email address',
      replyTo: 'help@sxmrentals.app',
    });
    // Both versions travel together: mail programs that cannot show the
    // designed one still get a readable email.
    expect(calls[0]?.text).toContain('https://example.com/confirm');
    expect(calls[0]?.html).toContain('<p>');
    // The link itself is never written into the server logs.
    const logged = JSON.stringify(logger.lines);
    expect(logged).toContain('customer@example.com');
    expect(logged).not.toContain('example.com/confirm');
  });

  it('leaves out the reply address and the designed version when there are none', async () => {
    const { client, calls } = fakeResend();
    const sender = createResendEmailSender({
      apiKey: 'test-key',
      from: 'SXM Rentals <onboarding@resend.dev>',
      logger: fakeLogger(),
      client,
    });

    await sender.send({ to: 'customer@example.com', subject: 'Plain', text: 'Just words.' });

    expect(calls[0] && 'replyTo' in calls[0]).toBe(false);
    expect(calls[0] && 'html' in calls[0]).toBe(false);
  });

  // The one that would otherwise bite: Resend answers with an error rather than
  // throwing, so an unchecked call looks exactly like a successful send.
  it('raises the problem when Resend refuses to deliver', async () => {
    const { client } = fakeResend('The sxmrentals.app domain is not verified.');
    const logger = fakeLogger();
    const sender = createResendEmailSender({
      apiKey: 'test-key',
      from: 'SXM Rentals <bookings@sxmrentals.app>',
      logger,
      client,
    });

    await expect(
      sender.send({ to: 'customer@example.com', subject: 'Confirm your email address', text: 'Link inside.' }),
    ).rejects.toThrow(/not verified/);

    const failure = logger.lines.find((line) => line.level === 'error');
    expect(failure?.msg).toContain('refused');
    expect(failure?.obj.reason).toContain('not verified');
  });
});

describe('sending email with no provider connected', () => {
  it('records that the email was not sent, without its contents', async () => {
    const logger = fakeLogger();
    const sender = createUnconfiguredEmailSender(logger);

    await sender.send({ to: 'customer@example.com', subject: 'Reset your password', text: 'https://secret/reset' });

    const failure = logger.lines.find((line) => line.level === 'error');
    expect(failure?.msg).toContain('No email provider is configured');
    expect(JSON.stringify(logger.lines)).not.toContain('secret/reset');
  });
});
