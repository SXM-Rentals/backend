// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The web addresses for SXM Rentals staff, under
// /api/v1/admin. This is the highest-value part of the platform, so:
//
//   - Signing in takes a password AND a code from an authenticator app. The
//     password alone gets a session that can do nothing but finish signing in.
//   - Every other address here is refused unless that code has been given, and
//     (where an address allowlist is set) unless the request comes from one of
//     those addresses.
//   - Every change requires a written reason and is recorded in the audit log.
//
//   POST /admin/auth/login        step one: email and password
//   POST /admin/auth/mfa/enroll   set up an authenticator app (first sign-in)
//   POST /admin/auth/mfa/verify   step two: the code. This completes sign-in
//   POST /admin/auth/logout       sign out
//   GET  /admin/me                who am I
//   GET  /admin/summary           the headline figures
//   GET  /admin/queue             everything waiting, oldest first
//   GET  /admin/audit             who changed what, and why
//   GET  /admin/analytics         money, bookings and sign-ups over time
//   users · providers · vehicles · bookings · deposits · refunds · disputes
//   payments (ledger and payouts, read only) · staff

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { parseInput } from '../../lib/validate.js';
import { adminSessionCookieName, requireAdmin } from '../../middleware/auth.js';
import { requireTier } from '../../services/admin/tiers.js';
import { AUTH_LIMITS } from '../../plugins/rate-limit.js';
import type { AdminAuthService } from '../../services/admin/auth.js';
import { listAudit } from '../../services/admin/audit.js';
import type { AdminService } from '../../services/admin/index.js';
import type { AdminStaffService } from '../../services/admin/staff.js';
import type { VerificationService } from '../../services/verification/index.js';
import type { SupportService } from '../../services/support/index.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../lib/passwords.js';
import type { Database } from '../../db/client.js';

export type AdminRouteOptions = {
  db: Database;
  config: Config;
  admin: AdminService;
  adminAuth: AdminAuthService;
  staffAccounts: AdminStaffService;
  verification: VerificationService;
  support: SupportService;
};

// ---- WHAT EACH REQUEST MAY CONTAIN ----
const idParam = z.object({ id: z.string().max(64) });
// Every change carries one of these. Short enough to type, long enough to mean
// something to whoever reads the log next year.
const reason = z.string().trim().min(3, 'Please give a reason — it goes into the audit log.').max(1000);

const loginBody = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1).max(128),
});
const mfaBody = z.object({ code: z.string().trim().min(6).max(10) });
const decisionBody = z.object({ approve: z.boolean(), reason });
const reasonOnlyBody = z.object({ reason });
const refundDecisionBody = z.object({
  approve: z.boolean(),
  reason,
  customerNote: z.string().trim().min(3).max(500).optional(),
});
const supportReplyBody = z.object({ body: z.string().trim().min(1).max(4000) });
const identityDecisionBody = z.object({
  decision: z.enum(['approved', 'rejected', 'resubmit']),
  reason,
  customerMessage: z.string().trim().min(3).max(500).optional(),
});
const claimBody = z.object({ amount: z.number().positive().max(100_000), reason });
const pointsBody = z.object({ points: z.number().int(), reason });
const userPatchBody = z.object({
  field: z.enum(['firstName', 'lastName', 'email', 'phone', 'accountType', 'isIslander']),
  value: z.union([z.string().max(254), z.boolean()]),
  reason,
});
const assignBody = z.object({ staffId: z.string().max(64), reason });

// Every change to a staff account also needs the actor's own authenticator
// code, checked fresh — a session left open is not enough on its own.
const code = z.string().trim().min(6).max(10);
const newStaffPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Passwords need at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Passwords can be at most ${PASSWORD_MAX_LENGTH} characters.`);

// Reads. Everything else is a change, and a viewer is refused all of it.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Granting a tier is checked again in the service against who is asking; this
// only says which words are a tier at all. "godfather" is deliberately absent:
// it cannot be granted through the panel by anybody.
const grantableTier = z.enum(['owner', 'administrator', 'viewer']);
const tierBody = z.object({ tier: grantableTier, reason, code });

const staffCreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().pipe(z.email().max(254)),
  password: newStaffPassword,
  // What the new account may do. Administrator when not said, which is the
  // everyday job and never staff management — so adding somebody can never hand
  // over more than was meant. Checked again against the actor's own level.
  tier: grantableTier.default('administrator'),
  reason,
  code,
});
const staffResetBody = z.object({
  password: newStaffPassword,
  resetAuthenticator: z.boolean().optional(),
  reason,
  code,
});
const reasonAndCodeBody = z.object({ reason, code });
// Correcting a business, one field at a time. A discriminated union rather than
// "a string or a boolean": a wrong pairing is then refused here with a message
// naming the field, instead of reaching Postgres and failing as a driver error.
const providerPatchBody = z.discriminatedUnion('field', [
  z.object({
    field: z.enum([
      'businessName',
      'town',
      'description',
      'phone',
      'legalName',
      'contactEmail',
      'website',
      'registrationNumber',
      'ownerName',
      'ownerPhone',
    ]),
    value: z.string().trim().max(500),
    reason,
  }),
  z.object({ field: z.literal('side'), value: z.enum(['dutch', 'french']), reason }),
  // A code the apps translate, never free English.
  z.object({ field: z.literal('respondsIn'), value: z.enum(['within_hour', 'within_hours', 'within_day']), reason }),
  z.object({ field: z.enum(['deliversVehicles', 'airportPickup']), value: z.boolean(), reason }),
]);
const ownPasswordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newStaffPassword,
});
const staffListQuery = z.object({ status: z.enum(['active', 'disabled', 'all']).default('active') });
const analyticsQuery = z.object({
  months: z.coerce.number().int().min(1).max(60).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
const resolveBody = z.object({ notes: z.string().trim().min(3).max(4000), reason });
const listQuery = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  reference: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export default async function adminRoutes(app: FastifyInstance, options: AdminRouteOptions) {
  const { db, config, admin, adminAuth, staffAccounts } = options;
  const cookieName = adminSessionCookieName(config);

  // Staff sessions live in a cookie page scripts cannot read, like customers',
  // but under their own name so the two can never be confused.
  function setStaffCookie(reply: FastifyReply, token: string, expiresAt: Date) {
    reply.setCookie(cookieName, token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  // ---- A VIEWER CHANGES NOTHING ----
  // Enforced BY METHOD, not by a list of routes: any admin request that is not a
  // read is refused for a viewer, including addresses added long after this was
  // written. A list of routes is a list somebody eventually forgets to add to.
  //
  // It runs before the handlers, so a viewer never reaches the code that would
  // have made the change.
  app.addHook('preHandler', async (request) => {
    if (READ_METHODS.has(request.method)) return;
    // Not signed in, or still owed a password: the handlers answer that, in
    // their own words. This hook is only about what a signed-in viewer may do.
    if (request.adminActor?.tier !== 'viewer') return;
    throw new AppError(403, 'read_only', 'Your account can see the panel but not change anything.');
  });

  // Who is asking, having passed both the password and the code.
  const staff = (request: Parameters<typeof requireAdmin>[0]) => requireAdmin(request, config);

  // The sign-in code of a session that has not finished signing in yet.
  const pendingToken = (request: { cookies: Record<string, string | undefined>; headers: Record<string, unknown> }) => {
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined;
    return request.cookies[cookieName] ?? bearer ?? '';
  };

  // ================= SIGNING IN =================

  app.post('/auth/login', { config: { rateLimit: AUTH_LIMITS.login } }, async (request, reply) => {
    const body = parseInput(loginBody, request.body);
    const result = await adminAuth.signIn(body, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    setStaffCookie(reply, result.token, result.expiresAt);
    // Not signed in yet: "enroll" means set up an authenticator app first,
    // "code" means give the code from the one already set up.
    return { next: result.next, expiresAt: result.expiresAt.toISOString() };
  });

  app.post('/auth/mfa/enroll', { config: { rateLimit: AUTH_LIMITS.login } }, async (request) => {
    return adminAuth.startMfaEnrollment(pendingToken(request));
  });

  app.post('/auth/mfa/verify', { config: { rateLimit: AUTH_LIMITS.login } }, async (request) => {
    const body = parseInput(mfaBody, request.body);
    const result = await adminAuth.confirmMfa(pendingToken(request), body.code);
    return {
      staff: result.staff,
      // True while this account still has the temporary password it was given:
      // the panel shows "set your own password" before anything else.
      mustChangePassword: result.mustChangePassword,
      expiresAt: result.expiresAt.toISOString(),
    };
  });

  // ---- CHANGING YOUR OWN PASSWORD ----
  // Allowed while the account still owes us a password of its own — that is the
  // whole point of it.
  app.post('/auth/password', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request, reply) => {
    const actor = requireAdmin(request, config, { allowPendingPassword: true });
    const body = parseInput(ownPasswordBody, request.body);
    await adminAuth.changeOwnPassword(actor, body);
    return reply.status(204).send();
  });

  app.post('/auth/logout', async (request, reply) => {
    await adminAuth.signOut(pendingToken(request));
    reply.clearCookie(cookieName, { path: '/', httpOnly: true, secure: config.isProduction, sameSite: 'lax' });
    return reply.status(204).send();
  });

  // Readable even while the account still owes us a password, so the panel can
  // tell who is signed in and show the "set your own password" screen.
  app.get('/me', async (request) => {
    const actor = requireAdmin(request, config, { allowPendingPassword: true });
    return {
      id: actor.staffId,
      name: actor.name,
      email: actor.email,
      avatarInitials: actor.avatarInitials,
      mustChangePassword: actor.mustChangePassword,
      // What this account may do, so the panel can hide the actions it cannot
      // use — while the server stays the real barrier.
      tier: actor.tier,
    };
  });

  // ================= THE DASHBOARD =================

  app.get('/summary', async (request) => {
    staff(request);
    return admin.getSummary();
  });

  app.get('/queue', async (request) => {
    staff(request);
    return admin.getQueue();
  });

  app.get('/audit', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return listAudit(db, { limit: query.limit ?? 100 });
  });

  // ---- STAFF ACCOUNTS ----
  // MANAGING STAFF IS OWNER AND ABOVE. An administrator does the everyday job —
  // verifications, listings, refunds, deposits, disputes — and cannot add a
  // colleague, reset one, switch one off, or change what anybody may do. Every
  // change below ALSO needs the actor's own authenticator code, checked fresh in
  // the request, so a session left open is never enough.
  //
  // Reading the list stays an ordinary staff action: the dispute picker needs it,
  // and knowing who your colleagues are is not a privilege.
  app.get('/staff', async (request) => {
    staff(request);
    const { status } = parseInput(staffListQuery, request.query);
    return staffAccounts.list(status);
  });

  app.post('/staff', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request, reply) => {
    const actor = staff(request);
    requireTier(actor, 'owner');
    const body = parseInput(staffCreateBody, request.body);
    await adminAuth.verifyStepUp(actor, body.code);
    const created = await staffAccounts.create(actor, body);
    return reply.status(201).send(created);
  });

  app.post('/staff/:id/reset', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    const actor = staff(request);
    requireTier(actor, 'owner');
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(staffResetBody, request.body);
    await adminAuth.verifyStepUp(actor, body.code);
    return staffAccounts.reset(actor, id, body);
  });

  app.post('/staff/:id/disable', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    const actor = staff(request);
    requireTier(actor, 'owner');
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(reasonAndCodeBody, request.body);
    await adminAuth.verifyStepUp(actor, body.code);
    return staffAccounts.disable(actor, id, body);
  });

  app.post('/staff/:id/enable', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    const actor = staff(request);
    requireTier(actor, 'owner');
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(reasonAndCodeBody, request.body);
    await adminAuth.verifyStepUp(actor, body.code);
    return staffAccounts.enable(actor, id, body);
  });

  // Promoting, demoting, or moving somebody to read-only. Refused on your own
  // account whoever you are, on anybody at your own level or above, and for any
  // level at or above your own — the three rules that keep this a hierarchy
  // rather than a ladder. Godfather cannot be granted here at all; it moves by a
  // command on the server.
  app.post('/staff/:id/tier', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    const actor = staff(request);
    requireTier(actor, 'owner');
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(tierBody, request.body);
    await adminAuth.verifyStepUp(actor, body.code);
    return staffAccounts.changeTier(actor, id, body);
  });

  // ---- ANALYTICS ----
  // Either the last few whole months, or any two dates. The bars are bucketed
  // by day, week, month or quarter to suit the span.
  app.get('/analytics', async (request) => {
    staff(request);
    const query = parseInput(analyticsQuery, request.query);
    return admin.getAnalytics(query);
  });

  // ================= CUSTOMERS =================

  app.get('/users', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listUsers({ search: query.search, limit: query.limit });
  });

  app.get('/users/:id', async (request) => {
    staff(request);
    return admin.getUser(parseInput(idParam, request.params).id);
  });

  app.patch('/users/:id', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(userPatchBody, request.body);
    return admin.updateUserField(actor, id, body);
  });

  app.patch('/users/:id/points', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(pointsBody, request.body);
    return admin.adjustPoints(actor, id, body);
  });

  // A customer's identity check, decided by staff: how checks are made when the
  // owner chooses staff over Stripe, and how Stripe's answer is overturned.
  // `customerMessage` is what the person is told; `reason` is for the log.
  app.post('/users/:id/verification', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(identityDecisionBody, request.body);
    return options.verification.decideByStaff(actor, id, body);
  });

  // ---- MESSAGES FROM CUSTOMERS ----
  // Waiting for an answer first. A viewer can read them; answering is a change,
  // which a viewer cannot make.
  app.get('/support', async (request) => {
    staff(request);
    return options.support.listForStaff();
  });

  app.get('/support/:id', async (request) => {
    staff(request);
    const { id } = parseInput(idParam, request.params);
    return options.support.conversationForStaff(id);
  });

  app.post('/support/:id/messages', async (request, reply) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(supportReplyBody, request.body);
    return reply.status(201).send(await options.support.replyAsStaff(actor, id, body));
  });

  app.delete('/users/:id', async (request, reply) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(reasonOnlyBody, request.body);
    await admin.closeAccount(actor, id, body);
    return reply.status(204).send();
  });

  // ================= RENTAL BUSINESSES =================

  app.get('/providers', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listProviders({
      status: query.status as 'pending' | 'approved' | 'rejected' | undefined,
      limit: query.limit,
    });
  });

  app.get('/providers/:id', async (request) => {
    staff(request);
    return admin.getProvider(parseInput(idParam, request.params).id);
  });

  // Closing a business, and opening it again. Both ask for the staff member's
  // authenticator code as well as a reason: this delists a whole fleet and takes
  // a business page down, so a session left open is not enough on its own.
  app.post('/providers/:id/close', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(reasonAndCodeBody, request.body);
    await adminAuth.verifyStepUp(actor, body.code);
    return admin.closeProvider(actor, id, body);
  });

  app.post('/providers/:id/reopen', { config: { rateLimit: AUTH_LIMITS.passwordChange } }, async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(reasonAndCodeBody, request.body);
    await adminAuth.verifyStepUp(actor, body.code);
    return admin.reopenProvider(actor, id, body);
  });

  // Correcting one detail. No code: this is a typo fix, the same as a customer's
  // record, and it still carries a reason and an audit entry.
  app.patch('/providers/:id', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(providerPatchBody, request.body);
    return admin.updateProviderField(actor, id, body);
  });

  app.post('/providers/:id/verification', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(decisionBody, request.body);
    return admin.decideProviderVerification(actor, id, body);
  });

  // ================= VEHICLES =================

  app.get('/vehicles', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listVehicles({
      status: query.status as 'live' | 'pending_review' | 'suspended' | undefined,
      limit: query.limit,
    });
  });

  app.get('/vehicles/:id', async (request) => {
    staff(request);
    return admin.getVehicle(parseInput(idParam, request.params).id);
  });

  app.post('/vehicles/:id/listing', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(decisionBody, request.body);
    return admin.decideVehicleListing(actor, id, body);
  });

  app.post('/vehicles/documents/:id/review', async (request, reply) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(decisionBody, request.body);
    await admin.reviewVehicleDocument(actor, id, body);
    return reply.status(204).send();
  });

  // ================= BOOKINGS =================

  app.get('/bookings', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listBookings({ reference: query.reference, limit: query.limit });
  });

  app.get('/bookings/:id', async (request) => {
    staff(request);
    return admin.getBooking(parseInput(idParam, request.params).id);
  });

  // ================= MONEY =================

  app.get('/payments', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listLedger({ limit: query.limit });
  });

  app.get('/payouts', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listPayouts({ limit: query.limit });
  });

  app.get('/deposits', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listDeposits({ status: query.status as 'not_taken' | 'held' | 'released' | 'claimed' | undefined });
  });

  app.post('/deposits/:id/release', async (request, reply) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(reasonOnlyBody, request.body);
    await admin.releaseDeposit(actor, id, body);
    return reply.status(204).send();
  });

  app.post('/deposits/:id/claim', async (request, reply) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(claimBody, request.body);
    await admin.claimDeposit(actor, id, { amountCents: Math.round(body.amount * 100), reason: body.reason });
    return reply.status(204).send();
  });

  app.get('/refunds', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listRefunds({ status: query.status as 'pending' | 'approved' | 'denied' | undefined });
  });

  app.post('/refunds/:id/decision', async (request, reply) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(refundDecisionBody, request.body);
    await admin.decideRefund(actor, id, body);
    return reply.status(204).send();
  });

  // ================= DISPUTES =================

  app.get('/disputes', async (request) => {
    staff(request);
    const query = parseInput(listQuery, request.query);
    return admin.listDisputes({ status: query.status as 'open' | 'investigating' | 'resolved' | undefined });
  });

  app.get('/disputes/:id', async (request) => {
    staff(request);
    return admin.getDispute(parseInput(idParam, request.params).id);
  });

  app.post('/disputes/:id/assign', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(assignBody, request.body);
    return admin.assignDispute(actor, id, body);
  });

  app.post('/disputes/:id/resolve', async (request) => {
    const actor = staff(request);
    const { id } = parseInput(idParam, request.params);
    const body = parseInput(resolveBody, request.body);
    return admin.resolveDispute(actor, id, body);
  });
}
