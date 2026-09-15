// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for creating an account and signing in
// and out, all under /api/v1/auth. Each one checks the information sent, applies
// its own tight rate limit, and hands the real work to services/auth — this file
// only deals with the request coming in and the response going out.
//
//   POST   /signup                 create an account (then verify the email)
//   POST   /verify-email           open the link from the verification email
//   POST   /verify-email/resend    send a new verification link
//   POST   /login                  sign in
//   POST   /logout                 sign out of this device
//   POST   /logout-all             sign out of every device
//   POST   /password/forgot        email a password-reset link
//   POST   /password/reset         choose a new password from that link
//   POST   /password/change        change password while signed in
//   GET    /sessions               the devices you are signed in on
//   DELETE /sessions/:id           sign out one of those devices
//
// Signing in from the website sets an httpOnly cookie that page scripts cannot
// read. The phone app sends "client": "mobile" and receives its sign-in code in
// the response instead, to keep in the phone's secure storage.
//
// Sign in with Apple and Google come later; they need developer-account keys.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../lib/passwords.js';
import { parseInput } from '../../lib/validate.js';
import { requireCustomer, sessionCookieName } from '../../middleware/auth.js';
import { AUTH_LIMITS } from '../../plugins/rate-limit.js';
import type { AuthService } from '../../services/auth/index.js';
import type { NewSession } from '../../services/auth/sessions.js';

export type AuthRouteOptions = { auth: AuthService; config: Config };

// ---- WHAT EACH REQUEST MAY CONTAIN ----
// Stray spaces are trimmed before the address is checked.
const emailField = z.string().trim().pipe(z.email('Please enter a valid email address.').max(254));
const newPasswordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Passwords can be at most ${PASSWORD_MAX_LENGTH} characters.`);
const linkTokenField = z.string().min(1).max(256);
const clientField = z.enum(['web', 'mobile']).default('web');

const signupBody = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: emailField,
  password: newPasswordField,
  accountType: z.enum(['local', 'tourist']),
  phone: z.string().trim().max(32).optional(),
});
const loginBody = z.object({
  email: emailField,
  // Not length-checked beyond a ceiling: old rules must not lock anyone out.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  client: clientField,
});
const emailOnlyBody = z.object({ email: emailField });
const tokenOnlyBody = z.object({ token: linkTokenField });
const resetBody = z.object({ token: linkTokenField, newPassword: newPasswordField });
const changeBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordField,
});
const sessionParams = z.object({ id: z.string().max(64) });

// The same answer whether or not an account exists — see services/auth.
const CHECK_YOUR_EMAIL = {
  message: 'If an account exists for that email address, we have sent it a message. Please check your inbox.',
};

export default async function authRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  const { auth, config } = options;
  const cookieName = sessionCookieName(config);

  // ---- COOKIE HELPERS ----
  function setSessionCookie(reply: FastifyReply, session: NewSession) {
    reply.setCookie(cookieName, session.token, {
      httpOnly: true, // page scripts cannot read it
      secure: config.isProduction, // HTTPS only (localhost is plain HTTP)
      sameSite: 'lax', // not sent on requests other sites trigger in the background
      path: '/',
      expires: session.expiresAt,
    });
  }

  function clearSessionCookie(reply: FastifyReply) {
    reply.clearCookie(cookieName, { path: '/', httpOnly: true, secure: config.isProduction, sameSite: 'lax' });
  }

  // Web gets a cookie; mobile gets the code itself in the response.
  function deliverSession(reply: FastifyReply, session: NewSession, client: 'web' | 'mobile') {
    if (client === 'mobile') return { expiresAt: session.expiresAt.toISOString(), token: session.token };
    setSessionCookie(reply, session);
    return { expiresAt: session.expiresAt.toISOString() };
  }

  const clientInfo = (request: FastifyRequest) => ({
    userAgent: request.headers['user-agent'],
    ipAddress: request.ip,
  });

  // ---- CREATING AND VERIFYING AN ACCOUNT ----

  app.post('/signup', { config: { rateLimit: AUTH_LIMITS.signup } }, async (request, reply) => {
    const body = parseInput(signupBody, request.body);
    await auth.signup(body);
    return reply.status(202).send({
      message: 'Thanks! Please check your inbox for a link to confirm your email address.',
    });
  });

  app.post('/verify-email', { config: { rateLimit: AUTH_LIMITS.useLink } }, async (request) => {
    const { token } = parseInput(tokenOnlyBody, request.body);
    await auth.verifyEmail(token);
    return { message: 'Your email address is confirmed. You can now sign in.' };
  });

  app.post('/verify-email/resend', { config: { rateLimit: AUTH_LIMITS.emailLink } }, async (request, reply) => {
    const { email } = parseInput(emailOnlyBody, request.body);
    await auth.resendVerification(email);
    return reply.status(202).send(CHECK_YOUR_EMAIL);
  });

  // ---- SIGNING IN AND OUT ----

  app.post('/login', { config: { rateLimit: AUTH_LIMITS.login } }, async (request, reply) => {
    const { client, ...credentials } = parseInput(loginBody, request.body);
    const { user, session } = await auth.login(credentials, clientInfo(request));
    return { user, session: deliverSession(reply, session, client) };
  });

  app.post('/logout', async (request, reply) => {
    await auth.logout(requireCustomer(request));
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post('/logout-all', async (request, reply) => {
    await auth.logoutEverywhere(requireCustomer(request));
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  // ---- PASSWORDS ----

  app.post('/password/forgot', { config: { rateLimit: AUTH_LIMITS.emailLink } }, async (request, reply) => {
    const { email } = parseInput(emailOnlyBody, request.body);
    await auth.forgotPassword(email);
    return reply.status(202).send(CHECK_YOUR_EMAIL);
  });

  app.post('/password/reset', { config: { rateLimit: AUTH_LIMITS.useLink } }, async (request, reply) => {
    const { token, newPassword } = parseInput(resetBody, request.body);
    await auth.resetPassword(token, newPassword);
    clearSessionCookie(reply);
    return { message: 'Your password has been changed and you have been signed out everywhere. Please sign in again.' };
  });

  app.post('/password/change', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request, reply) => {
    const actor = requireCustomer(request);
    const body = parseInput(changeBody, request.body);
    const session = await auth.changePassword(actor, body, clientInfo(request));
    // Keep this device signed in the same way it was before.
    return { session: deliverSession(reply, session, actor.authMethod === 'bearer' ? 'mobile' : 'web') };
  });

  // ---- SIGNED-IN DEVICES ----

  app.get('/sessions', async (request) => {
    return { sessions: await auth.listSessions(requireCustomer(request)) };
  });

  app.delete('/sessions/:id', async (request, reply) => {
    const actor = requireCustomer(request);
    const { id } = parseInput(sessionParams, request.params);
    await auth.revokeOwnSession(actor, id);
    if (id === actor.sessionId) clearSessionCookie(reply);
    return reply.status(204).send();
  });
}
