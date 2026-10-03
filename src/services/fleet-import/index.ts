// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Adding a business's cars from a spreadsheet, in two steps
// so that NOTHING IS SAVED UNTIL THE BUSINESS HAS SEEN EVERY ROW.
//
//   1. read   the file is read and every row checked; the rows come back with
//             their problems in plain words, one per mistake. Kept for an hour.
//   2. confirm the business picks the rows to add. Only rows with no problems;
//             confirming twice adds nothing twice.
//
// Imported cars wait for staff approval like any other added car.
//
// The file can be .csv or .xlsx, up to 500 KB and 200 cars. The columns are the
// ones on the template (GET /providers/import-template.csv) — everything the car
// form already asks for. Headings are matched loosely ("Daily rate ($)" is the
// daily rate) and values too ("4x4", "auto", "gas").

import { and, eq, isNull } from 'drizzle-orm';
import { readSheet as readXlsxSheet } from 'read-excel-file/node';
import type { Database } from '../../db/client.js';
import { fleetImports, vehicles } from '../../db/schema/index.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { isUuid } from '../../lib/ownership.js';
import { exampleTowns, findTown } from '../../lib/towns.js';
import { addVehicle, normaliseRegistration, type VehicleInput } from '../provider/index.js';

export const IMPORT_MAX_BYTES = 500 * 1024;
export const IMPORT_MAX_ROWS = 200;
const IMPORT_LIFETIME_MS = 60 * 60 * 1000;

// ---- THE COLUMNS ----
// In the template's order. "keys" are what a heading may say, once lowercased
// and stripped of everything but letters.
const COLUMNS = [
  { field: 'make', heading: 'Make', keys: ['make', 'brand'] },
  { field: 'model', heading: 'Model', keys: ['model'] },
  { field: 'year', heading: 'Year', keys: ['year'] },
  { field: 'vehicleType', heading: 'Vehicle type', keys: ['vehicletype', 'type', 'class', 'category'] },
  { field: 'registration', heading: 'Registration number', keys: ['registrationnumber', 'registration', 'plate', 'licenseplate', 'licenceplate', 'platenumber'] },
  { field: 'dailyRate', heading: 'Daily rate', keys: ['dailyrate', 'priceperday', 'dayrate', 'daily'] },
  { field: 'weeklyRate', heading: 'Weekly rate (optional)', keys: ['weeklyrate', 'weeklyrateoptional', 'priceperweek', 'weekly'] },
  { field: 'seats', heading: 'Seats', keys: ['seats'] },
  { field: 'doors', heading: 'Doors', keys: ['doors'] },
  { field: 'gearbox', heading: 'Gearbox', keys: ['gearbox', 'transmission'] },
  { field: 'fuel', heading: 'Fuel', keys: ['fuel', 'fueltype'] },
  { field: 'deposit', heading: 'Security deposit', keys: ['securitydeposit', 'deposit'] },
  { field: 'pickupTown', heading: 'Pickup town', keys: ['pickuptown', 'town', 'location', 'pickuplocation'] },
] as const;
type Field = (typeof COLUMNS)[number]['field'];
const OPTIONAL: Field[] = ['weeklyRate'];

// The template: the headings and nothing else, so it can never be imported by
// mistake with a made-up car in it.
export function importTemplateCsv(): string {
  return `${COLUMNS.map((column) => column.heading).join(',')}\r\n`;
}

const letters = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- READING THE FILE ----

// A CSV file, the way spreadsheets write them: commas, quotes around anything
// with a comma or a line break in it, "" for a quote inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  // A spreadsheet saved with semicolons (as European settings do) is read the
  // same way, judged from the heading line.
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function readSheet(fileName: string, bytes: Buffer): Promise<string[][]> {
  const lower = fileName.toLowerCase();
  // An .xlsx file is a zip: it starts with "PK".
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (lower.endsWith('.xlsx') || isZip) {
    if (!isZip) throw fileUnreadable('That file says .xlsx but is not a spreadsheet Excel can open.');
    try {
      // The first sheet: that is where the template puts the cars.
      const rows = await readXlsxSheet(bytes);
      return rows.map((row) => row.map((value) => (value === null || value === undefined ? '' : String(value))));
    } catch {
      throw fileUnreadable('We could not read that spreadsheet. Save it again as .xlsx or .csv and try once more.');
    }
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    // A CSV is text: a NUL byte means it is something else renamed.
    if (bytes.includes(0)) throw fileUnreadable('That file is not a CSV. Save the spreadsheet as .csv or .xlsx.');
    return parseCsv(bytes.toString('utf8'));
  }
  throw fileUnreadable('Upload a .csv or .xlsx file. An .xls or Numbers file can be saved as .xlsx first.');
}

function fileUnreadable(message: string) {
  return new AppError(400, 'file_unreadable', message);
}

// ---- CHECKING ONE ROW ----
export type ImportRow = {
  rowNumber: number;
  make: string;
  model: string;
  year: number | null;
  vehicleType: string | null;
  registration: string;
  dailyRate: number | null;
  weeklyRate: number | null;
  seats: number | null;
  doors: number | null;
  gearbox: string | null;
  fuel: string | null;
  securityDeposit: number | null;
  pickupTown: string;
  problems: string[];
};

const VEHICLE_TYPES: Record<string, VehicleInput['vehicleClass']> = {
  economy: 'economy',
  compact: 'compact',
  small: 'compact',
  suv: 'suv',
  jeep: 'fourByFour',
  van: 'van',
  minivan: 'van',
  '4x4': 'fourByFour',
  fourbyfour: 'fourByFour',
  '4wd': 'fourByFour',
  luxury: 'luxury',
};
const GEARBOXES: Record<string, VehicleInput['transmission']> = {
  automatic: 'automatic',
  auto: 'automatic',
  manual: 'manual',
  stick: 'manual',
  stickshift: 'manual',
};
const FUELS: Record<string, VehicleInput['fuel']> = {
  petrol: 'petrol',
  gas: 'petrol',
  gasoline: 'petrol',
  unleaded: 'petrol',
  diesel: 'diesel',
  hybrid: 'hybrid',
  electric: 'electric',
  ev: 'electric',
};

// "$1,250.00" → 1250. Nothing → null. Anything else → NaN, reported as wrong.
function money(value: string): number | null {
  const cleaned = value.replace(/[$\s,]|usd/gi, '');
  if (cleaned === '') return null;
  return /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}
function whole(value: string): number | null {
  const cleaned = value.trim();
  if (cleaned === '') return null;
  return /^\d+$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

type CheckedRow = ImportRow & { input: VehicleInput | null };

function checkRow(rowNumber: number, raw: Record<Field, string>): CheckedRow {
  const problems: string[] = [];
  const text = (field: Field) => (raw[field] ?? '').trim();

  const make = text('make');
  const model = text('model');
  if (!make) problems.push('The make is missing.');
  else if (make.length > 60) problems.push('The make is longer than 60 letters.');
  if (!model) problems.push('The model is missing.');
  else if (model.length > 60) problems.push('The model is longer than 60 letters.');

  const year = whole(text('year'));
  const maxYear = new Date().getFullYear() + 2;
  if (year === null) problems.push('The year is missing.');
  else if (Number.isNaN(year) || year < 1950 || year > maxYear) problems.push(`The year has to be between 1950 and ${maxYear}.`);

  const typeText = text('vehicleType');
  const vehicleClass = VEHICLE_TYPES[letters(typeText)] ?? VEHICLE_TYPES[typeText.toLowerCase().replace(/\s/g, '')];
  if (!typeText) problems.push('The vehicle type is missing.');
  else if (!vehicleClass) problems.push('The vehicle type has to be economy, compact, SUV, van, 4x4 or luxury.');

  const registration = text('registration') ? normaliseRegistration(text('registration')) : '';
  if (!registration) problems.push('The registration number is missing.');
  else if (registration.length > 20) problems.push('The registration number is longer than 20 characters.');

  const dailyRate = money(text('dailyRate'));
  if (dailyRate === null) problems.push('The daily rate is missing.');
  else if (Number.isNaN(dailyRate) || dailyRate <= 0 || dailyRate > 10_000) problems.push('The daily rate has to be an amount above $0, like 45.');

  const weeklyRate = money(text('weeklyRate'));
  if (weeklyRate !== null && (Number.isNaN(weeklyRate) || weeklyRate <= 0 || weeklyRate > 70_000)) {
    problems.push('The weekly rate has to be an amount above $0, or left empty.');
  }

  const seats = whole(text('seats'));
  if (seats === null) problems.push('The number of seats is missing.');
  else if (Number.isNaN(seats) || seats < 1 || seats > 20) problems.push('Seats has to be a number from 1 to 20.');

  const doors = whole(text('doors'));
  if (doors === null) problems.push('The number of doors is missing.');
  else if (Number.isNaN(doors) || doors < 1 || doors > 8) problems.push('Doors has to be a number from 1 to 8.');

  const gearboxText = text('gearbox');
  const transmission = GEARBOXES[letters(gearboxText)];
  if (!gearboxText) problems.push('The gearbox is missing.');
  else if (!transmission) problems.push('The gearbox has to be automatic or manual.');

  const fuelText = text('fuel');
  const fuel = FUELS[letters(fuelText)];
  if (!fuelText) problems.push('The fuel is missing.');
  else if (!fuel) problems.push('The fuel has to be petrol, diesel, hybrid or electric.');

  const deposit = money(text('deposit'));
  if (deposit === null) problems.push('The security deposit is missing.');
  else if (Number.isNaN(deposit) || deposit < 0 || deposit > 100_000) problems.push('The security deposit has to be an amount, like 300, or 0.');

  const townText = text('pickupTown');
  const town = townText ? findTown(townText) : null;
  if (!townText) problems.push('The pickup town is missing.');
  else if (!town) problems.push(`"${townText}" is not a town on the island we know. For example: ${exampleTowns()}.`);

  const valid = problems.length === 0;
  return {
    rowNumber,
    make,
    model,
    year: year !== null && !Number.isNaN(year) ? year : null,
    vehicleType: vehicleClass ?? (typeText || null),
    registration,
    dailyRate: dailyRate !== null && !Number.isNaN(dailyRate) ? dailyRate : null,
    weeklyRate: weeklyRate !== null && !Number.isNaN(weeklyRate) ? weeklyRate : null,
    seats: seats !== null && !Number.isNaN(seats) ? seats : null,
    doors: doors !== null && !Number.isNaN(doors) ? doors : null,
    gearbox: transmission ?? (gearboxText || null),
    fuel: fuel ?? (fuelText || null),
    securityDeposit: deposit !== null && !Number.isNaN(deposit) ? deposit : null,
    pickupTown: town?.name ?? townText,
    problems,
    input: valid
      ? {
          make,
          model,
          year: year!,
          vehicleClass: vehicleClass!,
          transmission: transmission!,
          fuel: fuel!,
          seats: seats!,
          doors: doors!,
          dailyRate: dailyRate!,
          ...(weeklyRate !== null ? { weeklyRate } : {}),
          depositAmount: deposit!,
          pickupTown: town!.name,
          side: town!.side,
          latitude: town!.latitude,
          longitude: town!.longitude,
          registration,
        }
      : null,
  };
}

// The plates this business already has on the platform.
async function platesInFleet(db: Database, providerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ registration: vehicles.registration })
    .from(vehicles)
    .where(and(eq(vehicles.providerId, providerId), isNull(vehicles.deletedAt)));
  return new Set(rows.map((row) => row.registration).filter((plate): plate is string => Boolean(plate)));
}

const publicRow = ({ input: _input, ...row }: CheckedRow): ImportRow => row;

// ---- STEP 1: READ AND CHECK ----
export async function readImport(db: Database, providerId: string, input: { fileName: string; contentBase64: string }) {
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length === 0) throw fileUnreadable('That file is empty.');
  if (bytes.length > IMPORT_MAX_BYTES) {
    throw fileUnreadable('That file is bigger than 500 KB. Split it into two, or remove photos and extra sheets.');
  }

  const sheet = (await readSheet(input.fileName, bytes)).map((row) => row.map((cell) => cell.trim()));
  // The heading row is the first one with anything in it.
  const headingIndex = sheet.findIndex((row) => row.some((cell) => cell !== ''));
  if (headingIndex === -1) throw fileUnreadable('That file has nothing in it.');
  const headings = sheet[headingIndex]!.map(letters);

  const positions = new Map<Field, number>();
  for (const column of COLUMNS) {
    const at = headings.findIndex((heading) => (column.keys as readonly string[]).includes(heading));
    if (at !== -1) positions.set(column.field, at);
  }
  const missing = COLUMNS.filter((column) => !OPTIONAL.includes(column.field) && !positions.has(column.field));
  if (missing.length > 0) {
    throw fileUnreadable(
      `We could not find these columns: ${missing.map((column) => column.heading.toLowerCase()).join(', ')}. Start from the template, or rename the headings to match it.`,
    );
  }

  const dataRows = sheet
    .map((cells, index) => ({ cells, rowNumber: index + 1 }))
    .slice(headingIndex + 1)
    .filter(({ cells }) => cells.some((cell) => cell !== ''));
  if (dataRows.length === 0) throw fileUnreadable('That file has the headings but no cars under them.');
  if (dataRows.length > IMPORT_MAX_ROWS) {
    throw fileUnreadable(`That file has ${dataRows.length} cars; up to ${IMPORT_MAX_ROWS} can be imported at once. Split it into smaller files.`);
  }

  const inFleet = await platesInFleet(db, providerId);
  const seen = new Map<string, number>();
  const rows = dataRows.map(({ cells, rowNumber }) => {
    const raw = Object.fromEntries(COLUMNS.map((column) => [column.field, cells[positions.get(column.field) ?? -1] ?? ''])) as Record<Field, string>;
    const row = checkRow(rowNumber, raw);
    if (row.registration) {
      if (inFleet.has(row.registration)) row.problems.push(`Already in your fleet (registration ${row.registration}).`);
      const earlier = seen.get(row.registration);
      if (earlier !== undefined) row.problems.push(`The same registration as row ${earlier} (${row.registration}).`);
      else seen.set(row.registration, row.rowNumber);
    }
    if (row.problems.length > 0) row.input = null;
    return row;
  });

  const expiresAt = new Date(Date.now() + IMPORT_LIFETIME_MS);
  const [saved] = await db
    .insert(fleetImports)
    .values({ providerId, fileName: input.fileName.slice(0, 200), rows, expiresAt })
    .returning({ id: fleetImports.id });
  return { importId: saved!.id, expiresAt: expiresAt.toISOString(), rows: rows.map(publicRow) };
}

// ---- STEP 2: ADD THE ROWS THE BUSINESS CHOSE ----
export async function confirmImport(
  db: Database,
  providerId: string,
  importId: string,
  rowNumbers: number[],
  // False only while the owner has switched car approval off.
  approvalRequired = true,
) {
  if (!isUuid(importId)) throw notFound('We could not find that import.');
  return db.transaction(async (tx) => {
    // Locked, so confirming twice at the same moment still adds each car once.
    const [found] = await tx
      .select()
      .from(fleetImports)
      .where(and(eq(fleetImports.id, importId), eq(fleetImports.providerId, providerId)))
      .for('update');
    if (!found) throw notFound('We could not find that import.');
    if (found.expiresAt.getTime() <= Date.now()) {
      throw new AppError(410, 'import_expired', 'That import is more than an hour old. Upload the file again.');
    }

    const rows = found.rows as CheckedRow[];
    const wanted = [...new Set(rowNumbers)];
    const chosen = wanted.map((rowNumber) => rows.find((row) => row.rowNumber === rowNumber));
    const unknown = wanted.filter((_, index) => !chosen[index]);
    if (unknown.length > 0) throw badRequest('unknown_rows', `There is no row ${unknown.join(', ')} in that file.`);
    const withProblems = chosen.filter((row) => row!.problems.length > 0 || !row!.input).map((row) => row!.rowNumber);
    if (withProblems.length > 0) {
      throw badRequest('row_has_problems', `Row ${withProblems.join(', ')} still has problems. Fix the file and upload it again.`);
    }

    // Rows added last time are not added again.
    const already = new Set(found.addedRows);
    const toAdd = chosen.filter((row) => !already.has(row!.rowNumber));

    // A plate added to the fleet since the file was read.
    const inFleet = await platesInFleet(tx as unknown as Database, providerId);
    const clashing = toAdd.filter((row) => inFleet.has(row!.registration)).map((row) => row!.rowNumber);
    if (clashing.length > 0) {
      throw badRequest('row_has_problems', `Row ${clashing.join(', ')} is already in your fleet now. Leave it out.`);
    }

    for (const row of toAdd) await addVehicle(tx as unknown as Database, providerId, row!.input!, approvalRequired);
    await tx
      .update(fleetImports)
      .set({ addedRows: [...already, ...toAdd.map((row) => row!.rowNumber)] })
      .where(eq(fleetImports.id, found.id));
    return { added: toAdd.length };
  });
}
