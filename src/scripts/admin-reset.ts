// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The command behind `npm run admin:reset` — the way back
// into the admin panel when the panel itself cannot help: every staff account
// switched off, or the only administrator has lost the phone with their
// authenticator app on it.
//
// It gives an account a new temporary password, switches it back on if it was
// off, clears any lockout, and optionally forgets its authenticator app so a
// new one can be set up. The person must then set a password of their own
// before they can do anything else.
//
// Like `admin:create` it writes NO audit entry: there is no staff member
// acting, only somebody with access to the server itself, which is outside
// what the panel's audit log covers.
//
// Usage:
//   npm run admin:reset -- name@example.com "a new temporary passphrase"
//   npm run admin:reset -- name@example.com "a new temporary passphrase" --authenticator

import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { connectDatabase } from '../db/client.js';
import { adminSessions, adminStaff } from '../db/schema/index.js';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../lib/passwords.js';

const args = process.argv.slice(2);
const resetAuthenticator = args.includes('--authenticator');
const [email, password] = args.filter((arg) => !arg.startsWith('--'));

if (!email || !password) {
  console.error('Usage: npm run admin:reset -- name@example.com "a new temporary passphrase" [--authenticator]');
  process.exit(1);
}

if (password.length < PASSWORD_MIN_LENGTH) {
  console.error(`That password is too short. Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  process.exit(1);
}

const config = loadConfig();

// Without a database address this quietly uses the small local database in
// .data/, where the account almost certainly does not exist — and the reset
// would look like it worked while the live account stayed locked out.
if (!config.databaseUrl) {
  console.warn('WARNING: DATABASE_URL is not set, so this is resetting an account in the LOCAL');
  console.warn('database in .data/, not on the live server. Set it in .env first if that is not');
  console.warn('what you meant.');
  console.warn('');
}

const connection = await connectDatabase(config.databaseUrl);

try {
  const address = email.trim().toLowerCase();
  const [staff] = await connection.db.select().from(adminStaff).where(eq(adminStaff.email, address)).limit(1);

  if (!staff) {
    console.error(`No staff account found for ${address}.`);
    process.exitCode = 1;
  } else {
    await connection.db
      .update(adminStaff)
      .set({
        passwordHash: await hashPassword(password),
        // They must replace this temporary password before doing anything else.
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        // Switched back on, in case this is the "everybody is locked out" case.
        disabledAt: null,
        ...(resetAuthenticator ? { mfaSecretEncrypted: null, mfaEnrolledAt: null } : {}),
      })
      .where(eq(adminStaff.id, staff.id));

    // Anything that account was signed in to stops working now.
    await connection.db
      .update(adminSessions)
      .set({ revokedAt: new Date() })
      .where(eq(adminSessions.staffId, staff.id));

    console.log(`Reset ${staff.name} <${staff.email}>.`);
    console.log('  - temporary password set (they must choose their own at next sign-in)');
    console.log('  - lockout cleared, account switched on, every session signed out');
    console.log(
      resetAuthenticator
        ? '  - authenticator app forgotten: they set up a new one at next sign-in'
        : '  - authenticator app left as it was (add --authenticator to reset it too)',
    );
  }
} catch (error) {
  console.error(`Could not reset that account: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await connection.close();
}
