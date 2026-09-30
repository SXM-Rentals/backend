// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests "Send it to us" — a business asking SXM Rentals'
// team to set its fleet up, with photos or files of what it has — and the queue
// staff answer it from.
//
// The tests that matter most are about the files, which may be registration and
// insurance papers: only real PDFs, photos and spreadsheets are taken, whatever
// they are called; they are never at a public address; and only staff can open
// them, as a download.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSignedInStaff,
  createTestContext,
  createVerifiedAccount,
  signInMobile,
  uniqueIp,
  WEB_ORIGIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let ownerToken: string;
let rivalToken: string;
let staffCookie: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, origin: WEB_ORIGIN });
const send = (method: 'GET' | 'POST', url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: auth(token), remoteAddress: uniqueIp(), ...(payload ? { payload } : {}) });
const asStaff = (method: 'GET' | 'POST', url: string, payload?: object) =>
  ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: staffCookie, origin: WEB_ORIGIN },
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

// The first bytes of real files, padded out.
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0x20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const file = (fileName: string, bytes: Buffer) => ({ fileName, contentBase64: bytes.toString('base64') });

const aRequest = async (token = ownerToken) =>
  send('POST', '/providers/me/fleet-requests', token, {
    fleetSize: '6-10',
    recordFormat: 'paper',
    contact: 'WhatsApp me on +1 721 555 0188 after 5pm',
    notes: 'Most papers are in a binder at the office.',
  });

beforeAll(async () => {
  ctx = await createTestContext({ env: { FEATURES: 'uploadRequest' } });
  const owner = await createVerifiedAccount(ctx);
  ownerToken = await signInMobile(ctx, owner.email, owner.password);
  await send('POST', '/providers/apply', ownerToken, application('Paper Fleet'));
  const rival = await createVerifiedAccount(ctx);
  rivalToken = await signInMobile(ctx, rival.email, rival.password);
  await send('POST', '/providers/apply', rivalToken, application('Rival Paper'));
  staffCookie = (await createSignedInStaff(ctx)).cookie;
});
afterAll(async () => {
  await ctx.close();
});

describe('asking staff to set the fleet up', () => {
  it('is received, and says when someone will be in touch', async () => {
    const res = await aRequest();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      message: 'Someone from our team will be in touch within a working day.',
    });
  });

  it('takes real PDFs and photos, one at a time, and refuses anything else', async () => {
    const { id } = (await aRequest()).json();
    const pdf = await send('POST', `/providers/me/fleet-requests/${id}/files`, ownerToken, file('insurance.pdf', PDF));
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json()).toEqual({ fileName: 'insurance.pdf' });

    // A web page dressed up as a PDF is refused: the content decides, not the name.
    const page = await send('POST', `/providers/me/fleet-requests/${id}/files`, ownerToken, file('ledger.pdf', Buffer.from('<html><script>alert(1)</script></html>')));
    expect(page.json().error.code).toBe('file_unreadable');

    const tooBig = await send('POST', `/providers/me/fleet-requests/${id}/files`, ownerToken, file('huge.jpg', Buffer.concat([JPEG, Buffer.alloc(720 * 1024)])));
    expect(tooBig.json().error.code).toBe('file_too_large');
  });

  it('carries up to five files', async () => {
    const { id } = (await aRequest()).json();
    for (let i = 1; i <= 5; i += 1) {
      const res = await send('POST', `/providers/me/fleet-requests/${id}/files`, ownerToken, file(`page-${i}.jpg`, JPEG));
      expect(res.statusCode).toBe(201);
    }
    const sixth = await send('POST', `/providers/me/fleet-requests/${id}/files`, ownerToken, file('page-6.jpg', JPEG));
    expect(sixth.json().error.code).toBe('too_many_files');
  });

  it('belongs to the business that sent it', async () => {
    const { id } = (await aRequest()).json();
    const res = await send('POST', `/providers/me/fleet-requests/${id}/files`, rivalToken, file('mine.pdf', PDF));
    expect(res.statusCode).toBe(404);
  });
});

describe('the admin panel queue', () => {
  it('lists waiting requests with their files, in the queue, and hands a file over only as a download', async () => {
    const { id } = (await aRequest()).json();
    await send('POST', `/providers/me/fleet-requests/${id}/files`, ownerToken, file('../../etc/registration papers.pdf', PDF));

    const queue = (await asStaff('GET', '/admin/queue')).json();
    expect(queue.some((item: { kind: string; id: string }) => item.kind === 'fleet_request' && item.id === id)).toBe(true);

    const list = (await asStaff('GET', '/admin/fleet-requests')).json();
    const listed = list.find((request: { id: string }) => request.id === id);
    expect(listed).toMatchObject({
      businessName: 'Paper Fleet',
      fleetSize: '6-10',
      recordFormat: 'paper',
      contact: 'WhatsApp me on +1 721 555 0188 after 5pm',
      status: 'waiting',
    });
    // The name is made safe: no path, no quotes.
    expect(listed.files).toEqual([
      { id: expect.any(String), fileName: 'registration papers.pdf', contentType: 'application/pdf', size: PDF.length },
    ]);

    const download = await asStaff('GET', `/admin/fleet-requests/${id}/files/${listed.files[0].id}`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toBe('attachment; filename="registration papers.pdf"');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.rawPayload.equals(PDF)).toBe(true);

    // Nobody but staff: a business, even the one that sent it, cannot fetch it here.
    const asOwner = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/admin/fleet-requests/${id}/files/${listed.files[0].id}`,
      headers: auth(ownerToken),
      remoteAddress: uniqueIp(),
    });
    expect(asOwner.statusCode).toBe(401);

    const done = await asStaff('POST', `/admin/fleet-requests/${id}/done`);
    expect(done.json().status).toBe('done');
    const again = await asStaff('POST', `/admin/fleet-requests/${id}/done`);
    expect(again.json().error.code).toBe('already_done');
    const queueAfter = (await asStaff('GET', '/admin/queue')).json();
    expect(queueAfter.some((item: { id: string }) => item.id === id)).toBe(false);
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
        url: '/api/v1/providers/me/fleet-requests',
        payload: { fleetSize: '1-5', recordFormat: 'paper', contact: 'call me' },
        headers: auth(token),
        remoteAddress: uniqueIp(),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
