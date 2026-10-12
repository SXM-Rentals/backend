// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The tables behind the Godfather's saved versions — a copy
// of the audit log, bookings, payments, payouts, deposits, refund requests and
// disputes as they stood when the Godfather pressed "Save a version", kept
// where only the Godfather can look at it, so that anything deleted since can be
// browsed and put back.
//
// A version is saved ONLY when the Godfather presses the button: nothing is
// copied in the background, so deleting something leaves no copy behind unless
// a version was saved first. Nothing here is ever shown to anybody else, and
// nothing in it is written to the audit log.

import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { adminStaff } from './admin.js';
import { createdAt, moment } from './columns.js';

// One saved version: when, by whom, an optional note, and how many records of
// each kind it holds.
export const dataVersions = pgTable('data_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  note: text('note').notNull().default(''),
  createdByStaffId: uuid('created_by_staff_id').references(() => adminStaff.id, { onDelete: 'set null' }),
  // { bookings: 12, audit_log: 340, … } — what was copied.
  counts: jsonb('counts').$type<Record<string, number>>().notNull(),
  createdAt: createdAt(),
});

// One record inside a version. summary, at and amountCents exist so the list can
// be searched and sorted without opening every record; data is the whole record
// (and, for a booking, the price lines, signature, date changes and review that
// belong to it), exactly as it was.
export const dataVersionRecords = pgTable(
  'data_version_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => dataVersions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    // The record's own id in the live tables.
    recordId: text('record_id').notNull(),
    summary: text('summary').notNull(),
    at: moment('at'),
    amountCents: integer('amount_cents'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    uniqueIndex('data_version_records_unique').on(t.versionId, t.kind, t.recordId),
    index('data_version_records_kind_idx').on(t.versionId, t.kind),
  ],
);
