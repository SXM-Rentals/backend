// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Turns a customer's database row into the `User` shape
// the apps expect for "my account". It picks out each field by name, so
// anything else stored against a customer — now or added later — can never
// leak into the response just because it happened to be on the row.

import type { customers } from '../../db/schema/index.js';
import type { User } from '../../types/api.js';

type CustomerRow = typeof customers.$inferSelect;

export function toUser(customer: CustomerRow): User {
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone ?? '',
    accountType: customer.accountType,
    verification: {
      status: customer.verificationStatus,
      selfieDone: customer.selfieDone,
      licenseDone: customer.licenseDone,
      identityDocDone: customer.identityDocDone,
      // The reason is only ever shown for a rejection.
      ...(customer.verificationStatus === 'rejected' && customer.verificationReason
        ? { reason: customer.verificationReason }
        : {}),
      ...(customer.verificationSubmittedAt ? { submittedAt: customer.verificationSubmittedAt.toISOString() } : {}),
    },
    isIslander: customer.isIslander,
    memberSince: customer.createdAt.toISOString(),
  };
}
