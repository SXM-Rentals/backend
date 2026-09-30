// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Checks a signature drawn on the rental agreement before
// it is kept.
//
// STRICTLY, because staff look at signatures in the admin panel: anything
// stored here ends up drawn on a web page. So only plain lines are accepted —
// "M12.0,40.5 L13.5,41.0" and nothing else, no other SVG commands, no text —
// inside a box of a sensible size, and long enough to be a signature rather
// than a tap. The admin panel draws the lines itself, as paths; it never puts a
// stored string into the page as SVG or HTML.

import { AppError } from '../../lib/errors.js';

export type DrawnSignature = { width: number; height: number; strokes: string[] };

const STROKE = /^M\d{1,4}(\.\d)?,\d{1,4}(\.\d)?( L\d{1,4}(\.\d)?,\d{1,4}(\.\d)?)*$/;
const MAX_STROKES = 200;
const MAX_TOTAL_BYTES = 64 * 1024;
// A quick "JB" clears this easily; a tap or a dot does not.
export const MIN_SIGNATURE_LENGTH = 60;

const invalid = (message: string) => new AppError(400, 'invalid_signature', message);

// The points of one line: "M1,2 L3,4" gives [[1,2],[3,4]].
function points(stroke: string): [number, number][] {
  return stroke
    .split(' ')
    .map((part) => part.slice(1).split(',').map(Number) as [number, number]);
}

// Returns the drawing as it will be stored, or refuses it with a sentence a
// person can read.
export function checkSignature(input: unknown): DrawnSignature {
  const value = input as Partial<DrawnSignature> | null;
  if (!value || typeof value !== 'object') throw invalid('The signature is missing. Please sign again.');
  const { width, height, strokes } = value;
  const inRange = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 50 && n <= 2000;
  if (!inRange(width) || !inRange(height)) {
    throw invalid('The signature box has to be between 50 and 2000 points wide and high. Please sign again.');
  }
  if (!Array.isArray(strokes) || strokes.length < 1 || strokes.length > MAX_STROKES) {
    throw invalid('The signature has to be between 1 and 200 lines. Please sign again.');
  }
  if (strokes.some((stroke) => typeof stroke !== 'string')) throw invalid('The signature could not be read. Please sign again.');
  if (Buffer.byteLength(strokes.join(''), 'utf8') > MAX_TOTAL_BYTES) {
    throw invalid('The signature is too detailed to keep. Please sign again, a little more simply.');
  }
  if (!strokes.every((stroke) => STROKE.test(stroke))) {
    throw invalid('The signature could not be read. Please sign again.');
  }

  let length = 0;
  for (const stroke of strokes) {
    const line = points(stroke);
    for (const [x, y] of line) {
      if (x > width! || y > height!) throw invalid('Part of the signature is outside the box. Please sign again.');
    }
    for (let i = 1; i < line.length; i += 1) {
      length += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
    }
  }
  if (length < MIN_SIGNATURE_LENGTH) {
    throw invalid('That is too short to be a signature. Please sign your name or initials.');
  }
  return { width: width!, height: height!, strokes };
}
