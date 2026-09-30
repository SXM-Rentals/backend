// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: "Send it to us" — a business whose records are on paper,
// in a message thread, or in software nobody can export from asks SXM Rentals'
// team to set its fleet up, and sends photos or files of what it has.
//
// THE FILES ARE PRIVATE. They may be registration and insurance papers, so they
// are kept in the database rather than at any web address, and only staff can
// open them — from the admin panel, one at a time, as a download. Up to 5 per
// request, 700 KB each, and only PDFs, photos, .csv and .xlsx, checked by what
// the file actually is rather than what it is called.

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { fleetRequestFiles, fleetRequests, providers } from '../../db/schema/index.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';

export const FLEET_REQUEST_MESSAGE = 'Someone from our team will be in touch within a working day.';
export const MAX_FILES_PER_REQUEST = 5;
export const MAX_FILE_BYTES = 700 * 1024;

export type FleetRequestInput = {
  fleetSize: '1-5' | '6-10' | '11-25' | '26-50' | '50+';
  recordFormat: 'spreadsheet' | 'software' | 'paper' | 'scattered';
  contact: string;
  notes?: string | undefined;
};

export async function createFleetRequest(db: Database, providerId: string, customerId: string, input: FleetRequestInput) {
  const [row] = await db
    .insert(fleetRequests)
    .values({
      providerId,
      requestedBy: customerId,
      fleetSize: input.fleetSize,
      recordFormat: input.recordFormat,
      contact: input.contact,
      notes: input.notes ?? null,
    })
    .returning({ id: fleetRequests.id });
  return { id: row!.id, message: FLEET_REQUEST_MESSAGE };
}

// What a file really is, from its first bytes. The name is only trusted to
// tell a CSV (plain text, no signature) apart.
function sniff(fileName: string, bytes: Buffer): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // iPhone photos: an ISO box whose brand says HEIC.
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|hevc)/.test(bytes.subarray(8, 12).toString('latin1'))) {
    return 'image/heic';
  }
  if (starts(0x50, 0x4b, 0x03, 0x04) && fileName.toLowerCase().endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (fileName.toLowerCase().endsWith('.csv') && !bytes.includes(0)) return 'text/csv';
  return null;
}

// A name that is safe to put in a download header: no path, no quotes.
function cleanName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
}

export async function addFleetRequestFile(
  db: Database,
  providerId: string,
  requestId: string,
  input: { fileName: string; contentBase64: string },
) {
  if (!isUuid(requestId)) throw notFound('We could not find that request.');
  const [request] = await db
    .select({ id: fleetRequests.id })
    .from(fleetRequests)
    .where(and(eq(fleetRequests.id, requestId), eq(fleetRequests.providerId, providerId)))
    .limit(1);
  if (!request) throw notFound('We could not find that request.');

  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length === 0) throw badRequest('file_unreadable', 'That file is empty.');
  if (bytes.length > MAX_FILE_BYTES) {
    throw badRequest('file_too_large', 'Each file can be up to 700 KB. A photo can be sent smaller, or a PDF split in two.');
  }
  const contentType = sniff(input.fileName, bytes);
  if (!contentType) {
    throw badRequest('file_unreadable', 'Send a PDF, a photo (JPEG, PNG, WebP or HEIC), a .csv or an .xlsx file.');
  }

  const fileName = cleanName(input.fileName);
  // Counted and added with the request locked, so two uploads at the same
  // moment cannot both be the fifth.
  await db.transaction(async (tx) => {
    await tx.select({ id: fleetRequests.id }).from(fleetRequests).where(eq(fleetRequests.id, request.id)).for('update');
    const [files] = await tx
      .select({ value: count() })
      .from(fleetRequestFiles)
      .where(eq(fleetRequestFiles.requestId, request.id));
    if ((files?.value ?? 0) >= MAX_FILES_PER_REQUEST) {
      throw conflict('too_many_files', `A request can carry up to ${MAX_FILES_PER_REQUEST} files.`);
    }
    await tx.insert(fleetRequestFiles).values({ requestId: request.id, fileName, contentType, sizeBytes: bytes.length, content: bytes });
  });
  return { fileName };
}

// ================= THE ADMIN PANEL'S QUEUE =================

function toAdminFleetRequest(
  row: typeof fleetRequests.$inferSelect,
  businessName: string,
  files: { id: string; fileName: string; contentType: string; sizeBytes: number }[],
) {
  return {
    id: row.id,
    providerId: row.providerId,
    businessName,
    fleetSize: row.fleetSize,
    recordFormat: row.recordFormat,
    // The business's own contact detail, for staff only.
    contact: row.contact,
    notes: row.notes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    handledAt: row.handledAt?.toISOString() ?? null,
    files: files.map((file) => ({ id: file.id, fileName: file.fileName, contentType: file.contentType, size: file.sizeBytes })),
  };
}

// Waiting ones first, oldest first — the order they should be answered in.
export async function listFleetRequests(db: Database, status?: 'waiting' | 'done') {
  const rows = await db
    .select({ request: fleetRequests, businessName: providers.businessName })
    .from(fleetRequests)
    .innerJoin(providers, eq(providers.id, fleetRequests.providerId))
    .where(status ? eq(fleetRequests.status, status) : undefined)
    .orderBy(sql`case when ${fleetRequests.status} = 'waiting' then 0 else 1 end`, asc(fleetRequests.createdAt))
    .limit(200);
  const ids = rows.map((row) => row.request.id);
  const files = ids.length
    ? await db
        .select({
          id: fleetRequestFiles.id,
          requestId: fleetRequestFiles.requestId,
          fileName: fleetRequestFiles.fileName,
          contentType: fleetRequestFiles.contentType,
          sizeBytes: fleetRequestFiles.sizeBytes,
        })
        .from(fleetRequestFiles)
        .where(inArray(fleetRequestFiles.requestId, ids))
        .orderBy(asc(fleetRequestFiles.createdAt))
    : [];
  return rows.map((row) =>
    toAdminFleetRequest(row.request, row.businessName, files.filter((file) => file.requestId === row.request.id)),
  );
}

export async function getFleetRequest(db: Database, id: string) {
  if (!isUuid(id)) throw notFound('We could not find that request.');
  const [row] = await db
    .select({ request: fleetRequests, businessName: providers.businessName })
    .from(fleetRequests)
    .innerJoin(providers, eq(providers.id, fleetRequests.providerId))
    .where(eq(fleetRequests.id, id))
    .limit(1);
  if (!row) throw notFound('We could not find that request.');
  const files = await db
    .select({
      id: fleetRequestFiles.id,
      fileName: fleetRequestFiles.fileName,
      contentType: fleetRequestFiles.contentType,
      sizeBytes: fleetRequestFiles.sizeBytes,
    })
    .from(fleetRequestFiles)
    .where(eq(fleetRequestFiles.requestId, row.request.id))
    .orderBy(asc(fleetRequestFiles.createdAt));
  return toAdminFleetRequest(row.request, row.businessName, files);
}

// One file, for staff to download. Never served inline: it is handed over as
// an attachment, so a file dressed up as a web page cannot run in the panel.
export async function fleetRequestFile(db: Database, requestId: string, fileId: string) {
  if (!isUuid(requestId) || !isUuid(fileId)) throw notFound('We could not find that file.');
  const [file] = await db
    .select()
    .from(fleetRequestFiles)
    .where(and(eq(fleetRequestFiles.id, fileId), eq(fleetRequestFiles.requestId, requestId)))
    .limit(1);
  if (!file) throw notFound('We could not find that file.');
  return file;
}

export async function markFleetRequestDone(db: Database, id: string, staffId: string) {
  const request = await getFleetRequest(db, id);
  if (request.status === 'done') throw new AppError(409, 'already_done', 'That request has already been marked done.');
  await db
    .update(fleetRequests)
    .set({ status: 'done', handledAt: new Date(), handledByStaffId: staffId })
    .where(eq(fleetRequests.id, id));
  return getFleetRequest(db, id);
}

export async function waitingFleetRequests(db: Database): Promise<number> {
  const [row] = await db.select({ value: count() }).from(fleetRequests).where(eq(fleetRequests.status, 'waiting'));
  return row?.value ?? 0;
}

