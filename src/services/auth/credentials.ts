// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Asks a signed-in person for their password again, for the
// few actions that cannot be undone — closing an account, closing a business.
//
// WHY IT EXISTS AT ALL: a session on a borrowed or unlocked laptop is enough to
// browse and to book, and that is the right trade for everyday use. It is not
// enough to end something for good. Everything here is about that one step.
//
// It lives on its own, apart from the sign-in service, because the business
// side needs it too, and a second copy of "check the password" is how two
// checks quietly stop matching.

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { credentials, customers } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/passwords.js';

// Throws unless the password really belongs to this signed-in person.
//
// A WRONG PASSWORD IS 400, NOT 401. Inside a session that is already signed in,
// a wrong password is a typo, and the apps treat any 401 as "your session has
// ended" and throw the person back to the sign-in screen.
export async function assertOwnPassword(db: Database, customerId: string, password: string): Promise<void> {
  const [account] = await db
    .select({ passwordHash: credentials.passwordHash })
    .from(credentials)
    .innerJoin(customers, eq(customers.id, credentials.customerId))
    .where(and(eq(credentials.customerId, customerId), isNull(customers.deletedAt)))
    .limit(1);
  // No row means the account was closed under this session; the session itself
  // is already refused everywhere else, so this is the honest answer.
  if (!account) throw new AppError(401, 'unauthorized', 'Please sign in again.');

  if (!(await verifyPassword(account.passwordHash, password))) {
    throw new AppError(400, 'wrong_password', 'Your password is not correct.');
  }
}
