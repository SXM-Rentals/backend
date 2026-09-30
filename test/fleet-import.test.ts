// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests adding a business's cars from a spreadsheet, in two
// steps so that nothing is saved until the business has seen every row.
//
// The tests that matter most: reading a file saves no car at all; every mistake
// is reported in words, one per mistake, against the row it is on; a car already
// in the fleet is recognised by its registration; only rows without problems can
// be added; confirming twice adds nothing twice; and imported cars wait for
// staff approval like any other.

import { eq } from 'drizzle-orm';
import writeExcelFile from 'write-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fleetImports, vehicles } from '../src/db/schema/index.js';
import {
  createTestContext,
  createVerifiedAccount,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let ownerToken: string;
let providerId: string;
let rivalToken: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST', url: string, token?: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: token ? auth(token) : {},
    remoteAddress: uniqueIp(),
    ...(payload ? { payload } : {}),
  });

const application = (businessName: string) => ({
  businessName,
  legalName: `${businessName} N.V.`,
  contactEmail: `hello@${businessName.toLowerCase().replace(/\W/g, '')}.sx`,
  ownerName: 'Marie Richardson',
  ownerPhone: '+1 721 555 0188',
  town: 'Simpson Bay',
  side: 'dutch' as const,
  operatingSide: 'dutch' as const,
});

const HEADINGS =
  'Make,Model,Year,Vehicle type,Registration number,Daily rate,Weekly rate (optional),Seats,Doors,Gearbox,Fuel,Security deposit,Pickup town';
const upload = (csv: string, fileName = 'fleet.csv', token = ownerToken) =>
  send('POST', '/providers/me/vehicles/import', token, {
    fileName,
    contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
  });
const fleetCount = async () =>
  (await ctx.db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.providerId, providerId))).length;

beforeAll(async () => {
  ctx = await createTestContext({ env: { FEATURES: 'fleetImport' } });
  const owner = await createVerifiedAccount(ctx);
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  providerId = (await send('POST', '/providers/apply', ownerToken, application('Spreadsheet Cars'))).json().providerId;
  const rival = await createVerifiedAccount(ctx);
  rivalToken = await signInMobile(ctx, rival.email, rival.password);
  await send('POST', '/providers/apply', rivalToken, application('Rival Sheets'));
});
afterAll(async () => {
  await ctx.close();
});

describe('the template', () => {
  it('is public, and holds the column headings and nothing else', async () => {
    const res = await send('GET', '/providers/import-template.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.trim()).toBe(HEADINGS);
  });
});

describe('reading a file', () => {
  it('checks every row, saves no car, and names each problem in words', async () => {
    const before = await fleetCount();
    const csv = [
      HEADINGS,
      'Kia,Picanto,2022,Economy,p-1234,$35.00,,4,4,Automatic,Petrol,300,Simpson Bay',
      'Suzuki,Jimny,2021,4x4,M-555,65,390,4,3,manual,gas,500,marigot',
      ',Yaris,2019,compact,T-1,,,5,4,auto,petrol,300,Atlantis',
      'Toyota,Hilux,1901,truck,,forty,,99,4,sideways,water,,Grand Case',
      '',
    ].join('\r\n');

    const res = await upload(csv);
    expect(res.statusCode).toBe(201);
    const { importId, expiresAt, rows } = res.json();
    expect(importId).toBeTruthy();
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    expect(await fleetCount()).toBe(before);

    expect(rows).toHaveLength(3 + 1);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      make: 'Kia',
      model: 'Picanto',
      year: 2022,
      registration: 'P-1234',
      dailyRate: 35,
      seats: 4,
      problems: [],
    });
    expect(rows[1]).toMatchObject({ rowNumber: 3, pickupTown: 'Marigot', weeklyRate: 390, problems: [] });
    expect(rows[2].problems).toEqual([
      'The make is missing.',
      'The daily rate is missing.',
      expect.stringContaining('"Atlantis" is not a town on the island we know.'),
    ]);
    expect(rows[3].problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('The year has to be between 1950'),
        'The vehicle type has to be economy, compact, SUV, van, 4x4 or luxury.',
        'The registration number is missing.',
        'The daily rate has to be an amount above $0, like 45.',
        'Seats has to be a number from 1 to 20.',
        'The gearbox has to be automatic or manual.',
        'The fuel has to be petrol, diesel, hybrid or electric.',
        'The security deposit is missing.',
      ]),
    );
  });

  it('recognises a car already in the fleet, and a plate twice in one file', async () => {
    const first = (await upload([HEADINGS, 'Kia,Rio,2023,compact,DUP-1,40,,5,4,automatic,petrol,300,Philipsburg'].join('\n'))).json();
    await send('POST', `/providers/me/vehicles/import/${first.importId}/confirm`, ownerToken, { rowNumbers: [2] });

    const again = (
      await upload(
        [
          HEADINGS,
          'Kia,Rio,2023,compact,dup-1,40,,5,4,automatic,petrol,300,Philipsburg',
          'Kia,Soul,2023,compact,TWICE-2,40,,5,4,automatic,petrol,300,Philipsburg',
          'Kia,Soul,2023,compact,twice-2,40,,5,4,automatic,petrol,300,Philipsburg',
        ].join('\n'),
      )
    ).json();
    expect(again.rows[0].problems).toEqual(['Already in your fleet (registration DUP-1).']);
    expect(again.rows[1].problems).toEqual([]);
    expect(again.rows[2].problems).toEqual(['The same registration as row 3 (TWICE-2).']);
  });

  it('reads semicolons, quotes and loosely written headings', async () => {
    const csv = [
      'MAKE;Model;Year;Type;Plate;Daily Rate ($);Seats;Doors;Transmission;Fuel type;Deposit;Town',
      '"Mercedes; Benz";"C ""Class""";2024;luxury;LUX-9;"1,200";5;4;automatic;diesel;2500;Maho',
    ].join('\n');
    const { rows } = (await upload(csv)).json();
    expect(rows[0]).toMatchObject({ make: 'Mercedes; Benz', model: 'C "Class"', dailyRate: 1200, problems: [] });
  });

  it('reads an .xlsx spreadsheet the same way', async () => {
    const sheet = [
      HEADINGS.split(','),
      ['Nissan', 'Kicks', 2024, 'SUV', 'XL-42', 55, null, 5, 4, 'Automatic', 'Petrol', 400, 'Grand Case'],
    ];
    const buffer = await writeExcelFile(sheet).toBuffer();
    const res = await send('POST', '/providers/me/vehicles/import', ownerToken, {
      fileName: 'fleet.xlsx',
      contentBase64: buffer.toString('base64'),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rows[0]).toMatchObject({
      rowNumber: 2,
      make: 'Nissan',
      year: 2024,
      registration: 'XL-42',
      dailyRate: 55,
      pickupTown: 'Grand Case',
      problems: [],
    });
  });

  it('refuses a file it cannot use, in a sentence the owner can act on', async () => {
    const wrongType = await upload('whatever', 'fleet.pdf');
    expect(wrongType.json().error).toMatchObject({ code: 'file_unreadable', message: expect.stringContaining('.csv or .xlsx') });

    const missingColumns = await upload('Make,Model\nKia,Picanto');
    expect(missingColumns.json().error.message).toContain('We could not find these columns: year, vehicle type');

    const noCars = await upload(`${HEADINGS}\n\n`);
    expect(noCars.json().error.message).toContain('no cars');

    const tooMany = await upload(
      [HEADINGS, ...Array.from({ length: 201 }, (_, i) => `Kia,Rio,2023,compact,R-${i},40,,5,4,automatic,petrol,300,Maho`)].join('\n'),
    );
    expect(tooMany.json().error.message).toContain('up to 200');

    const tooBig = await upload(`${HEADINGS}\n${'x'.repeat(520 * 1024)}`);
    expect(tooBig.json().error.message).toContain('500 KB');

    const fakeXlsx = await upload('not really a spreadsheet', 'fleet.xlsx');
    expect(fakeXlsx.json().error.code).toBe('file_unreadable');
  });
});

describe('adding the rows', () => {
  it('adds only rows without problems, waiting for staff approval, and never twice', async () => {
    const { importId } = (
      await upload(
        [
          HEADINGS,
          'Hyundai,i10,2022,economy,ADD-1,30,,4,5,manual,petrol,250,Cole Bay',
          'Hyundai,Tucson,2023,suv,ADD-2,70,420,5,5,automatic,hybrid,600,Orient Bay',
          'Hyundai,,2023,suv,ADD-3,70,,5,5,automatic,hybrid,600,Orient Bay',
        ].join('\n'),
      )
    ).json();
    const before = await fleetCount();

    const withProblem = await send('POST', `/providers/me/vehicles/import/${importId}/confirm`, ownerToken, { rowNumbers: [2, 4] });
    expect(withProblem.statusCode).toBe(400);
    expect(withProblem.json().error.code).toBe('row_has_problems');
    expect(await fleetCount()).toBe(before);

    const added = await send('POST', `/providers/me/vehicles/import/${importId}/confirm`, ownerToken, { rowNumbers: [2, 3] });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ added: 2 });

    const cars = await ctx.db.select().from(vehicles).where(eq(vehicles.providerId, providerId));
    const tucson = cars.find((car) => car.registration === 'ADD-2')!;
    expect(tucson).toMatchObject({
      listingStatus: 'pending_review',
      side: 'french',
      pickupTown: 'Orient Bay',
      weeklyRateCents: 42000,
      vehicleClass: 'suv',
      fuel: 'hybrid',
    });

    const twice = await send('POST', `/providers/me/vehicles/import/${importId}/confirm`, ownerToken, { rowNumbers: [2, 3] });
    expect(twice.json()).toEqual({ added: 0 });
    expect(await fleetCount()).toBe(before + 2);
  });

  it('expires after an hour, and belongs to the business that read it', async () => {
    const { importId } = (
      await upload([HEADINGS, 'Ford,Fiesta,2020,economy,OLD-1,30,,4,5,manual,petrol,250,Cay Hill'].join('\n'))
    ).json();

    const rival = await send('POST', `/providers/me/vehicles/import/${importId}/confirm`, rivalToken, { rowNumbers: [2] });
    expect(rival.statusCode).toBe(404);

    await ctx.db.update(fleetImports).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(fleetImports.id, importId));
    const late = await send('POST', `/providers/me/vehicles/import/${importId}/confirm`, ownerToken, { rowNumbers: [2] });
    expect(late.statusCode).toBe(410);
    expect(late.json().error.code).toBe('import_expired');
  });
});

describe('while switched off', () => {
  it('answers feature_off', async () => {
    const off = await createTestContext();
    try {
      const account = await createVerifiedAccount(off);
      const token = await signInMobile(off, account.email, account.password);
      const res = await off.app.inject({
        method: 'POST',
        url: '/api/v1/providers/me/vehicles/import',
        payload: { fileName: 'fleet.csv', contentBase64: 'YQ==' },
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
