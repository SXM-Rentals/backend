// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tests that a booking's dates and times are read as
// island time (UTC−4, all year), not as UTC.
//
// Reading "10:00" as 10:00 UTC put every pickup four hours early: the deposit
// window opened 52 hours before the car was collected instead of 48, free
// cancellation ended four hours early, and after 8 in the evening on the island
// "today" was already tomorrow. Each test below fails under the old reading.

import { describe, expect, it } from 'vitest';
import { islandDate, islandMoment, islandWords } from '../src/lib/island-time.js';
import { refundDue } from '../src/services/booking-engine/index.js';
import { holdWindowOpensAt } from '../src/services/payments/holds.js';

describe('the island clock', () => {
  it('reads 10:00 on the island as 14:00 UTC', () => {
    expect(islandMoment('2026-10-12', '10:00').toISOString()).toBe('2026-10-12T14:00:00.000Z');
  });

  it('knows it is still today on the island at 9 in the evening, when UTC is already tomorrow', () => {
    expect(islandDate(new Date('2026-10-13T01:00:00Z'))).toBe('2026-10-12');
    expect(islandDate(new Date('2026-10-13T05:00:00Z'))).toBe('2026-10-13');
  });

  it('says a moment in island time, in words', () => {
    expect(islandWords(new Date('2026-10-02T14:00:00Z'))).toBe('Friday 2 October at 10:00');
  });
});

describe('the rules that depend on it', () => {
  it('opens the deposit window exactly 48 hours before the car is collected', () => {
    const opens = holdWindowOpensAt('2026-10-12', '10:00');
    const pickup = islandMoment('2026-10-12', '10:00');
    expect((pickup.getTime() - opens.getTime()) / 3_600_000).toBe(48);
    expect(opens.toISOString()).toBe('2026-10-10T14:00:00.000Z');
  });

  it('keeps cancellation free until 48 hours before the real pickup', () => {
    const booking = { startDate: '2026-10-12', pickupTime: '10:00', paidCents: 20_000 };
    // 08:00 on the island two days before: 50 hours to go, so still free.
    // (Read as UTC it was 46 hours, and only half came back.)
    expect(refundDue(booking, new Date('2026-10-10T08:00:00-04:00')).rule).toBe('free');
    expect(refundDue(booking, new Date('2026-10-10T10:30:00-04:00')).rule).toBe('late');
  });
});
