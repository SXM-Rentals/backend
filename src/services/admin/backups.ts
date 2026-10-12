// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The Godfather's saved versions — a copy of the audit log,
// bookings, payments, payouts, deposits, refund requests and disputes, saved when
// the Godfather presses "Save a version", that only the Godfather can browse,
// search, sort and restore from. It is the undo for the clears and deletes in
// test-data.ts: anything removed since a version was saved can be put back.
//
// WHAT IT DOES AND DOES NOT DO
//   - A version is saved ONLY when asked for. Nothing is copied in the
//     background, so a clear or delete leaves no copy behind unless a version was
//     saved first. That is deliberate: it keeps "nothing is left behind" true.
//   - Restoring PUTS BACK WHAT IS MISSING. It never overwrites a record that is
//     there now and never changes one: a booking that has been edited since stays
//     as it is, and a record that is still present is counted as "already there".
//   - A record whose car, customer, business or booking has since been deleted
//     cannot be put back on its own: it is reported with the reason, and the rest
//     still goes back. Restoring a whole version goes in the order the database
//     needs (payouts, bookings, deposits, payments, refunds, disputes, then the
//     audit log), so a booking and its deposit return together.
//   - A booking goes back WITH its price lines, signature, date changes and review.
//     A payment line whose booking is gone goes back detached from it, as the
//     clear leaves them; a booking's link to a payout or discount that is gone is
//     dropped (the payout is owed again) rather than blocking it.
//   - Nothing here writes an audit entry, saving, restoring or deleting a version.
//
// GODFATHER ONLY, always — saving and browsing need only the sign-in; restoring
// and deleting a version also need the authenticator code (checked by the route).
// It keeps working after Stripe has run live: putting records back harms nobody.
// At most 20 versions are kept, so copies cannot quietly fill the database.

import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import {
  adminStaff,
  auditLog,
  bookingPriceLines,
  bookings,
  bookingSignatures,
  businessPromotions,
  dataVersionRecords,
  dataVersions,
  dateChangeRequests,
  deposits,
  disputes,
  ledgerEntries,
  payouts,
  promoCodes,
  refundRequests,
  reviews,
} from '../../db/schema/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import type { AdminActor } from './auth.js';
import { requireTier } from './tiers.js';

export const MAX_VERSIONS = 20;
const PAGE_LIMIT = 200;

export const BACKUP_KINDS = ['audit_log', 'bookings', 'payments', 'payouts', 'deposits', 'refunds', 'disputes'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const KIND_LABELS: Record<BackupKind, string> = {
  audit_log: 'Audit log',
  bookings: 'Bookings',
  payments: 'Payments',
  payouts: 'Payouts',
  deposits: 'Deposits',
  refunds: 'Refund requests',
  disputes: 'Disputes',
};

// The order a whole version goes back in: what is pointed at before what points.
const RESTORE_ORDER: BackupKind[] = ['payouts', 'bookings', 'deposits', 'payments', 'refunds', 'disputes', 'audit_log'];

const TABLES: Record<BackupKind, PgTable> = {
  audit_log: auditLog,
  bookings,
  payments: ledgerEntries,
  payouts,
  deposits,
  refunds: refundRequests,
  disputes,
};
const idColumn = (kind: BackupKind) => getTableColumns(TABLES[kind]).id as AnyPgColumn;

// A booking's own records, saved inside it and put back with it.
const BOOKING_CHILDREN = {
  priceLines: bookingPriceLines,
  signature: bookingSignatures,
  dateChanges: dateChangeRequests,
  review: reviews,
} as const;
type ChildKey = keyof typeof BOOKING_CHILDREN;
const CHILD_KEYS = Object.keys(BOOKING_CHILDREN) as ChildKey[];

// A row as plain data: dates become text, nothing else changes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const toJson = (value: unknown): Row => JSON.parse(JSON.stringify(value)) as Row;

// Plain data back into a row the database accepts: text becomes dates again.
function revive(table: PgTable, json: Row): Row {
  const values: Row = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const value = json[key];
    values[key] = value === undefined || value === null ? null : column.dataType === 'date' ? new Date(value as string) : value;
  }
  return values;
}

// ---- WHAT EACH RECORD IS CALLED, WHEN IT IS DATED, AND WORTH ----
type Described = { summary: string; at: Date | null; amountCents: number | null };
const withBooking = (refs: Map<string, string>, bookingId: string | null) => {
  const reference = bookingId ? refs.get(bookingId) : undefined;
  return reference ? ` · booking ${reference}` : '';
};

function describe(kind: BackupKind, row: Row, refs: Map<string, string>): Described {
  switch (kind) {
    case 'audit_log':
      return { summary: `${row.subjectLabel} · ${row.field} · ${row.action}`, at: new Date(row.at), amountCents: null };
    case 'bookings':
      return {
        summary: `${row.reference} · ${row.status} · ${row.startDate} to ${row.endDate}`,
        at: new Date(row.createdAt),
        amountCents: row.grossCents,
      };
    case 'payments':
      return {
        summary: `${row.kind} · ${row.stripeRef}${withBooking(refs, row.bookingId)}`,
        at: new Date(row.occurredAt),
        amountCents: row.amountCents,
      };
    case 'payouts':
      return {
        summary: `${row.reference} · ${row.status} · ${row.periodStart} to ${row.periodEnd}`,
        at: new Date(row.createdAt),
        amountCents: row.amountCents,
      };
    case 'deposits':
      return { summary: `Deposit · ${row.status}${withBooking(refs, row.bookingId)}`, at: new Date(row.createdAt), amountCents: row.amountCents };
    case 'refunds':
      return {
        summary: `Refund request · ${row.status}${withBooking(refs, row.bookingId)}`,
        at: new Date(row.requestedAt),
        amountCents: row.amountCents,
      };
    case 'disputes':
      return { summary: `${row.reference} · ${row.subject}`, at: new Date(row.openedAt), amountCents: row.amountAtStakeCents };
  }
}

// ---- WHY A RECORD COULD NOT BE PUT BACK ----
function pgCode(error: unknown): string | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.code === 'string' && current.code.length === 5) return current.code;
    current = current.cause as typeof current;
  }
  return undefined;
}

function whyNot(kind: BackupKind, error: unknown): string {
  const code = pgCode(error);
  if (code === '23503') {
    return {
      audit_log: 'the staff account it belongs to no longer exists',
      bookings: 'its car, customer or business has since been deleted',
      payments: 'something it belongs to has since been deleted',
      payouts: 'its business has since been deleted',
      deposits: 'its booking is not there — put the booking back first',
      refunds: 'its booking is not there — put the booking back first',
      disputes: 'its booking is not there — put the booking back first',
    }[kind];
  }
  if (code === '23505') return 'a different record with the same reference exists now';
  return 'the database would not take it';
}

export type VersionView = {
  id: string;
  note: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  // How many of each kind were saved.
  counts: Record<string, number>;
  // How many of each kind are NOT in the live tables now — what a restore would bring back.
  missing: Record<string, number>;
};

export function createBackupsService(deps: { db: Database }) {
  const { db } = deps;

  // "Is this saved record gone from the live table?" as SQL, per kind.
  const missingIn = (kind: BackupKind) =>
    sql`not exists (select 1 from ${TABLES[kind]} where ${idColumn(kind)}::text = ${dataVersionRecords.recordId})`;

  async function loadVersion(id: string) {
    const missing = notFound('We could not find that saved version.');
    if (!isUuid(id)) throw missing;
    const [version] = await db.select().from(dataVersions).where(eq(dataVersions.id, id)).limit(1);
    if (!version) throw missing;
    return version;
  }

  async function views(versions: (typeof dataVersions.$inferSelect)[]): Promise<VersionView[]> {
    if (versions.length === 0) return [];
    const ids = versions.map((version) => version.id);
    // One count per kind across all versions, not one per version.
    const missing = new Map<string, Record<string, number>>();
    for (const kind of BACKUP_KINDS) {
      const rows = await db
        .select({ versionId: dataVersionRecords.versionId, value: count() })
        .from(dataVersionRecords)
        .where(and(inArray(dataVersionRecords.versionId, ids), eq(dataVersionRecords.kind, kind), missingIn(kind)))
        .groupBy(dataVersionRecords.versionId);
      for (const row of rows) missing.set(row.versionId, { ...(missing.get(row.versionId) ?? {}), [kind]: row.value });
    }
    const staffIds = [...new Set(versions.map((version) => version.createdByStaffId).filter((id): id is string => !!id))];
    const people = staffIds.length
      ? await db.select({ id: adminStaff.id, name: adminStaff.name }).from(adminStaff).where(inArray(adminStaff.id, staffIds))
      : [];
    const nameOf = new Map(people.map((person) => [person.id, person.name]));
    return versions.map((version) => ({
      id: version.id,
      note: version.note,
      createdAt: version.createdAt.toISOString(),
      createdBy: version.createdByStaffId ? { id: version.createdByStaffId, name: nameOf.get(version.createdByStaffId) ?? 'Former staff' } : null,
      counts: version.counts,
      missing: Object.fromEntries(BACKUP_KINDS.map((kind) => [kind, missing.get(version.id)?.[kind] ?? 0])),
    }));
  }

  // Which of these ids are in the live table right now.
  async function liveIds(kind: BackupKind, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db.select({ id: idColumn(kind) }).from(TABLES[kind]).where(inArray(idColumn(kind), ids));
    return new Set(rows.map((row) => String(row.id)));
  }

  // The ids, among these, that exist in a table — for dropping a link to a thing that is gone.
  async function existing(tx: Database, table: PgTable, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const column = getTableColumns(table).id as AnyPgColumn;
    const rows = await tx.select({ id: column }).from(table).where(inArray(column, ids));
    return new Set(rows.map((row) => String(row.id)));
  }

  // Inserts rows that are not there, by their own id. A clash on anything else
  // (a reference that now belongs to another record) raises, and is reported.
  async function insertMissing(tx: Database, kind: BackupKind, rows: Row[]): Promise<number> {
    const table = TABLES[kind];
    const inserted = await tx
      .insert(table)
      .values(rows.map((row) => revive(table, row)) as never)
      .onConflictDoNothing({ target: idColumn(kind) })
      .returning({ id: idColumn(kind) });
    return inserted.length;
  }

  // Drops links to things that are gone, so a record can still go back.
  async function loosenLinks(tx: Database, kind: BackupKind, rows: Row[]): Promise<Row[]> {
    if (kind === 'payments') {
      const present = await existing(tx, bookings, rows.map((row) => row.bookingId).filter(Boolean));
      return rows.map((row) => (row.bookingId && !present.has(row.bookingId) ? { ...row, bookingId: null } : row));
    }
    if (kind === 'bookings') {
      const [payoutsThere, codesThere, promotionsThere] = await Promise.all([
        existing(tx, payouts, rows.map((row) => row.payoutId).filter(Boolean)),
        existing(tx, promoCodes, rows.map((row) => row.promoCodeId).filter(Boolean)),
        existing(tx, businessPromotions, rows.map((row) => row.promotionId).filter(Boolean)),
      ]);
      const keep = (there: Set<string>, id: string | null) => (id && there.has(id) ? id : null);
      return rows.map((row) => ({
        ...row,
        payoutId: keep(payoutsThere, row.payoutId),
        promoCodeId: keep(codesThere, row.promoCodeId),
        promotionId: keep(promotionsThere, row.promotionId),
      }));
    }
    return rows;
  }

  return {
    // The kinds a version holds, for the panel's filters.
    kinds() {
      return BACKUP_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind] }));
    },

    // ---- SAVE ----
    async save(actor: AdminActor, input: { note?: string | undefined }) {
      requireTier(actor, 'godfather');
      const [kept] = await db.select({ value: count() }).from(dataVersions);
      if ((kept?.value ?? 0) >= MAX_VERSIONS) {
        throw conflict(
          'too_many_versions',
          `${MAX_VERSIONS} versions are saved already, which is the most kept. Delete an old one first. Nothing was saved.`,
        );
      }

      const version = await db.transaction(async (tx) => {
        const t = tx as unknown as Database;
        const [created] = await t
          .insert(dataVersions)
          .values({ note: input.note?.trim() ?? '', createdByStaffId: actor.staffId, counts: {} })
          .returning();
        const refs = new Map((await t.select({ id: bookings.id, reference: bookings.reference }).from(bookings)).map((b) => [b.id, b.reference]));
        const counts: Record<string, number> = {};

        for (const kind of BACKUP_KINDS) {
          const rows = (await t.select().from(TABLES[kind])) as Row[];
          counts[kind] = rows.length;

          // A booking is saved with the records that belong to it.
          const children = new Map<string, Row>();
          if (kind === 'bookings') {
            for (const key of CHILD_KEYS) {
              for (const child of (await t.select().from(BOOKING_CHILDREN[key])) as Row[]) {
                const forBooking = children.get(child.bookingId) ?? {};
                (forBooking[key] ??= []).push(toJson(child));
                children.set(child.bookingId, forBooking);
              }
            }
          }

          const records = rows.map((row) => {
            const said = describe(kind, row, refs);
            return {
              versionId: created!.id,
              kind,
              recordId: String(row.id),
              summary: said.summary,
              at: said.at,
              amountCents: said.amountCents,
              data: { row: toJson(row), ...(kind === 'bookings' ? { children: children.get(row.id) ?? {} } : {}) },
            };
          });
          for (let start = 0; start < records.length; start += 200) {
            await t.insert(dataVersionRecords).values(records.slice(start, start + 200));
          }
        }
        const [done] = await t.update(dataVersions).set({ counts }).where(eq(dataVersions.id, created!.id)).returning();
        return done!;
      });

      return (await views([version]))[0]!;
    },

    // ---- LOOK ----
    async list(actor: AdminActor) {
      requireTier(actor, 'godfather');
      const versions = await db.select().from(dataVersions).orderBy(desc(dataVersions.createdAt), desc(dataVersions.id));
      return { limit: MAX_VERSIONS, kinds: this.kinds(), versions: await views(versions) };
    },

    async get(actor: AdminActor, versionId: string) {
      requireTier(actor, 'godfather');
      return (await views([await loadVersion(versionId)]))[0]!;
    },

    // Everything in a version, searchable and sortable, a page at a time. inLive
    // says whether the record is in the live tables now: false means it was
    // deleted since, and restoring would bring it back.
    async records(
      actor: AdminActor,
      versionId: string,
      query: {
        kind?: BackupKind | undefined;
        q?: string | undefined;
        show?: 'all' | 'missing' | undefined;
        sort?: 'at' | 'summary' | 'amount' | 'kind' | undefined;
        dir?: 'asc' | 'desc' | undefined;
        limit?: number | undefined;
        offset?: number | undefined;
      },
    ) {
      requireTier(actor, 'godfather');
      await loadVersion(versionId);

      const anyMissing: SQL = or(...BACKUP_KINDS.map((kind) => and(eq(dataVersionRecords.kind, kind), missingIn(kind))))!;
      const where = and(
        eq(dataVersionRecords.versionId, versionId),
        query.kind ? eq(dataVersionRecords.kind, query.kind) : undefined,
        query.q ? ilike(dataVersionRecords.summary, `%${query.q.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
        query.show === 'missing' ? anyMissing : undefined,
      );

      const column = { at: dataVersionRecords.at, summary: dataVersionRecords.summary, amount: dataVersionRecords.amountCents, kind: dataVersionRecords.kind }[
        query.sort ?? 'at'
      ];
      const order = (query.dir ?? 'desc') === 'asc' ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;

      const [total] = await db.select({ value: count() }).from(dataVersionRecords).where(where);
      const page = await db
        .select({
          id: dataVersionRecords.id,
          kind: dataVersionRecords.kind,
          recordId: dataVersionRecords.recordId,
          summary: dataVersionRecords.summary,
          at: dataVersionRecords.at,
          amountCents: dataVersionRecords.amountCents,
        })
        .from(dataVersionRecords)
        .where(where)
        .orderBy(order, asc(dataVersionRecords.id))
        .limit(Math.min(query.limit ?? 50, PAGE_LIMIT))
        .offset(query.offset ?? 0);

      const live = new Map<BackupKind, Set<string>>();
      for (const kind of BACKUP_KINDS) {
        live.set(kind, await liveIds(kind, page.filter((row) => row.kind === kind).map((row) => row.recordId)));
      }
      return {
        total: total?.value ?? 0,
        records: page.map((row) => ({
          id: row.id,
          kind: row.kind,
          label: KIND_LABELS[row.kind as BackupKind] ?? row.kind,
          recordId: row.recordId,
          summary: row.summary,
          at: row.at?.toISOString() ?? null,
          amountCents: row.amountCents,
          inLive: live.get(row.kind as BackupKind)?.has(row.recordId) ?? false,
        })),
      };
    },

    // One saved record in full, exactly as it was.
    async record(actor: AdminActor, versionId: string, id: string) {
      requireTier(actor, 'godfather');
      await loadVersion(versionId);
      const missing = notFound('We could not find that saved record.');
      if (!isUuid(id)) throw missing;
      const [row] = await db
        .select()
        .from(dataVersionRecords)
        .where(and(eq(dataVersionRecords.versionId, versionId), eq(dataVersionRecords.id, id)))
        .limit(1);
      if (!row) throw missing;
      const live = await liveIds(row.kind as BackupKind, [row.recordId]);
      return {
        id: row.id,
        kind: row.kind,
        label: KIND_LABELS[row.kind as BackupKind] ?? row.kind,
        recordId: row.recordId,
        summary: row.summary,
        at: row.at?.toISOString() ?? null,
        amountCents: row.amountCents,
        inLive: live.has(row.recordId),
        data: row.data,
      };
    },

    // ---- RESTORE ----
    // Puts back what is missing — all of a version, one kind of it, or chosen
    // records — and says what went back, what was already there, and what could
    // not be put back and why. Never overwrites anything that is there now.
    async restore(actor: AdminActor, versionId: string, input: { kind?: BackupKind | undefined; recordIds?: string[] | undefined }) {
      requireTier(actor, 'godfather');
      await loadVersion(versionId);
      const chosen = await db
        .select()
        .from(dataVersionRecords)
        .where(
          and(
            eq(dataVersionRecords.versionId, versionId),
            input.kind ? eq(dataVersionRecords.kind, input.kind) : undefined,
            input.recordIds ? inArray(dataVersionRecords.id, input.recordIds) : undefined,
          ),
        );

      const byKind: Record<string, { restored: number; alreadyThere: number; failed: number }> = {};
      const failed: { id: string; kind: string; summary: string; why: string }[] = [];
      const tally = (kind: string) => (byKind[kind] ??= { restored: 0, alreadyThere: 0, failed: 0 });

      await db.transaction(async (tx) => {
        const t = tx as unknown as Database;
        for (const kind of RESTORE_ORDER) {
          const items = chosen.filter((item) => item.kind === kind).sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
          if (items.length === 0) continue;
          const counted = tally(kind);

          // One record at a time, each in its own savepoint: one that cannot go
          // back is reported and the rest still do.
          const one = async (item: (typeof items)[number]) => {
            try {
              const went = await t.transaction(async (sp) => {
                const inner = sp as unknown as Database;
                const [row] = await loosenLinks(inner, kind, [item.data.row as Row]);
                const inserted = await insertMissing(inner, kind, [row!]);
                if (inserted === 0 || kind !== 'bookings') return inserted;
                // The booking itself went back: its own records go with it.
                const children = (item.data.children ?? {}) as Record<ChildKey, Row[] | undefined>;
                for (const key of CHILD_KEYS) {
                  const saved = children[key] ?? [];
                  if (saved.length === 0) continue;
                  const table = BOOKING_CHILDREN[key];
                  await inner.insert(table).values(saved.map((child) => revive(table, child)) as never).onConflictDoNothing();
                }
                return inserted;
              });
              if (went > 0) counted.restored += 1;
              else counted.alreadyThere += 1;
            } catch (error) {
              counted.failed += 1;
              failed.push({ id: item.id, kind, summary: item.summary, why: whyNot(kind, error) });
            }
          };

          if (kind === 'bookings') {
            for (const item of items) await one(item);
            continue;
          }
          // The rest in bulk, falling back to one by one if a bulk insert is refused.
          for (let start = 0; start < items.length; start += 100) {
            const chunk = items.slice(start, start + 100);
            try {
              const went = await t.transaction(async (sp) => {
                const inner = sp as unknown as Database;
                const rows = await loosenLinks(inner, kind, chunk.map((item) => item.data.row as Row));
                return insertMissing(inner, kind, rows);
              });
              counted.restored += went;
              counted.alreadyThere += chunk.length - went;
            } catch {
              for (const item of chunk) await one(item);
            }
          }
        }
      });

      const restored = Object.values(byKind).reduce((sum, kind) => sum + kind.restored, 0);
      const alreadyThere = Object.values(byKind).reduce((sum, kind) => sum + kind.alreadyThere, 0);
      return {
        restored,
        alreadyThere,
        failedCount: failed.length,
        failed: failed.slice(0, 200),
        byKind,
        detail:
          (restored > 0 ? `${restored} record(s) put back. ` : 'Nothing needed putting back. ') +
          (alreadyThere > 0 ? `${alreadyThere} ${alreadyThere === 1 ? 'was' : 'were'} already there and left as they are. ` : '') +
          (failed.length > 0 ? `${failed.length} could not be put back — each says why.` : ''),
      };
    },

    // ---- DELETE A VERSION ----
    async remove(actor: AdminActor, versionId: string) {
      requireTier(actor, 'godfather');
      await loadVersion(versionId);
      await db.delete(dataVersions).where(eq(dataVersions.id, versionId));
      return { id: versionId, deleted: true as const };
    },
  };
}

export type BackupsService = ReturnType<typeof createBackupsService>;
