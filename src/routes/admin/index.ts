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
import { parseInput } from '../../lib/validate.js';
import { adminSessionCookieName, requireAdmin } from '../../middleware/auth.js';
import { AUTH_LIMITS } from '../../plugins/rate-limit.js';
import type { AdminAuthService } from '../../services/admin/auth.js';
import { listAudit } from '../../services/admin/audit.js';
import type { AdminService } from '../../services/admin/index.js';
import type { Database } from '../../db/client.js';

export type AdminRouteOptions = {
  db: Database;
  config: Config;
  admin: AdminService;
  adminAuth: AdminAuthService;
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
const claimBody = z.object({ amount: z.number().positive().max(100_000), reason });
const pointsBody = z.object({ points: z.number().int(), reason });
const userPatchBody = z.object({
  field: z.enum(['firstName', 'lastName', 'email', 'phone', 'accountType', 'isIslander']),
  value: z.union([z.string().max(254), z.boolean()]),
  reason,
});
const assignBody = z.object({ staffId: z.string().max(64), reason });
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
  const { db, config, admin, adminAuth } = options;
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
    const { code } = parseInput(mfaBody, request.body);
    const result = await adminAuth.confirmMfa(pendingToken(request), code);
    return { staff: result.staff, expiresAt: result.expiresAt.toISOString() };
  });

  app.post('/auth/logout', async (request, reply) => {
    await adminAuth.signOut(pendingToken(request));
    reply.clearCookie(cookieName, { path: '/', httpOnly: true, secure: config.isProduction, sameSite: 'lax' });
    return reply.status(204).send();
  });

  app.get('/me', async (request) => {
    const actor = staff(request);
    return { id: actor.staffId, name: actor.name, email: actor.email };
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

  app.get('/staff', async (request) => {
    staff(request);
    return admin.listStaff();
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
    const body = parseInput(decisionBody, request.body);
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
