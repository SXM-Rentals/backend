// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Where car photos are kept — Cloudinary — and how a
// business is allowed to put one there.
//
// THE PHOTOS NEVER PASS THROUGH THIS SERVER. A phone on hotel wifi uploading
// eight photos of a car would tie up the API for minutes at a time, and the API
// only accepts a 1MB request in the first place. So the backend hands out a
// signed ticket — "you may upload into this one folder, for the next hour" — the
// app uploads straight to Cloudinary, and then tells us the address it got back.
//
// WHICH MEANS THE ADDRESS IT TELLS US CANNOT BE TRUSTED. A business could claim
// any address on the internet: a competitor's photo, a tracking pixel, something
// worse. So an address is only accepted when it is served by OUR Cloudinary
// account AND sits inside the folder for that particular car, which is the
// folder we signed the ticket for. Anything else is refused.
//
// Cloudinary was chosen over plain file storage because a car listing needs the
// same photo at several sizes — a thumbnail in search, a big one on the car's
// page — and it does that from the address itself, with no work here.
//
// NOTHING IS SENT ANYWHERE UNTIL THE KEYS ARE SET. Until then every photo
// endpoint answers "not switched on yet", the same way payments do, rather than
// appearing to accept a photo that goes nowhere.

import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

// What an app needs in order to upload one photo itself.
export type UploadTicket = {
  // Where to send the file.
  uploadUrl: string;
  // Sent alongside the file, exactly as given. The signature covers them.
  fields: Record<string, string>;
  // The largest file that will be accepted, so an app can say so before
  // spending a minute uploading.
  maxBytes: number;
  // How long the ticket is good for.
  expiresAt: string;
};

export type PhotoStorage = {
  // A ticket to upload into one folder, for one car.
  ticketFor(folder: string): UploadTicket;
  // Is this address one of ours, inside that folder? Everything else is refused.
  ownsAddress(url: string, folder: string): boolean;
  // Best effort: take the file down too. A failure here is logged, never
  // allowed to stop the photo being removed from the listing.
  remove(url: string): Promise<void>;
};

// Photos are limited to keep one business from filling the free storage tier,
// and because a modern phone photo above this is already more than a listing
// needs.
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const TICKET_MINUTES = 60;

export const uploadsUnavailable = () =>
  new AppError(503, 'uploads_unavailable', 'Photo uploads are not switched on yet. Please try again later.');

// ---- THE REAL ONE: CLOUDINARY ----
export function createCloudinaryStorage(options: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  logger: { warn: (obj: object, msg: string) => void };
}): PhotoStorage {
  const { cloudName, apiKey, apiSecret, logger } = options;
  const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const deliveryPrefix = `https://res.cloudinary.com/${cloudName}/`;

  // Cloudinary's rule: take the parameters being signed, sort them by name,
  // join them as a query string, add the secret on the end, and hash it. The
  // secret itself never leaves this server — only the hash does.
  function sign(params: Record<string, string>): string {
    const toSign = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');
    return createHash('sha1').update(`${toSign}${apiSecret}`).digest('hex');
  }

  return {
    ticketFor(folder) {
      const timestamp = Math.floor(Date.now() / 1000);
      // Only these two are signed, so only these two can be relied on. The app
      // cannot widen the folder: changing it invalidates the signature.
      const signed = { folder, timestamp: String(timestamp) };
      return {
        uploadUrl,
        fields: { ...signed, api_key: apiKey, signature: sign(signed) },
        maxBytes: MAX_PHOTO_BYTES,
        expiresAt: new Date((timestamp + TICKET_MINUTES * 60) * 1000).toISOString(),
      };
    },

    ownsAddress(url, folder) {
      if (!url.startsWith(deliveryPrefix)) return false;
      // The folder appears in the address as a path segment. Requiring the
      // slashes on both sides stops "vehicles/abc" from being accepted for a
      // car whose folder is "vehicles/abcdef".
      return url.includes(`/${folder}/`);
    },

    async remove(url) {
      // The public id is everything after "/upload/" (minus any transformation
      // and the file extension) — that is what Cloudinary deletes by.
      const publicId = publicIdFromUrl(url, deliveryPrefix);
      if (!publicId) return;

      const timestamp = String(Math.floor(Date.now() / 1000));
      const signed = { public_id: publicId, timestamp };
      const body = new URLSearchParams({ ...signed, api_key: apiKey, signature: sign(signed) });

      try {
        const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
          method: 'POST',
          body,
        });
        if (!response.ok) {
          logger.warn({ publicId, status: response.status }, 'Cloudinary would not delete a photo file');
        }
      } catch (error) {
        // The listing has already lost the photo, which is what the business
        // asked for. A file left behind costs storage, not correctness.
        logger.warn({ publicId, error: String(error) }, 'Could not reach Cloudinary to delete a photo file');
      }
    },
  };
}

// "https://res.cloudinary.com/x/image/upload/v17/sxm-rentals/vehicles/1/abc.jpg"
// becomes "sxm-rentals/vehicles/1/abc".
export function publicIdFromUrl(url: string, deliveryPrefix: string): string | null {
  if (!url.startsWith(deliveryPrefix)) return null;
  const afterUpload = url.split('/upload/')[1];
  if (!afterUpload) return null;
  const withoutVersion = afterUpload.replace(/^v\d+\//, '');
  const withoutExtension = withoutVersion.replace(/\.[a-z0-9]+$/i, '');
  return withoutExtension || null;
}

// ---- NOT SWITCHED ON YET ----
export function createUnconfiguredStorage(): PhotoStorage {
  return {
    ticketFor() {
      throw uploadsUnavailable();
    },
    ownsAddress() {
      return false;
    },
    async remove() {
      // Nothing was ever stored, so there is nothing to take down.
    },
  };
}
