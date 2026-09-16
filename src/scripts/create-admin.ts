// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The command behind `npm run admin:create`. It makes the
// first (or another) staff account for the admin panel.
//
// There is deliberately NO web address that creates a staff account. A new one
// is made on purpose, from the server, by somebody who already has access to
// it — so nobody can grant themselves admin access through the panel or the API.
//
// Usage:
//   npm run admin:create -- "Gio Bertin-Maurice" gio@example.com 'a long passphrase'
//
// The password is only used to set the account up; the person signs in with it
// and then sets up an authenticator app, which is required from then on.

import { loadConfig } from '../config.js';
import { connectDatabase } from '../db/client.js';
import { createAdminAuthService } from '../services/admin/auth.js';

const [name, email, password] = process.argv.slice(2);

if (!name || !email || !password) {
  console.error('Usage: npm run admin:create -- "Full Name" email@example.com "a long passphrase"');
  process.exit(1);
}

if (password.length < 12) {
  console.error('That password is too short. Use at least 12 characters.');
  process.exit(1);
}

const config = loadConfig();
const connection = await connectDatabase(config.databaseUrl);

try {
  const auth = createAdminAuthService({
    db: connection.db,
    config,
    logger: { warn: (obj, msg) => console.warn(msg, obj) },
  });
  const staff = await auth.createStaff({ name, email, password });

  console.log(`Staff account created for ${staff.name} <${staff.email}>.`);
  console.log('');
  console.log('Next: sign in at POST /api/v1/admin/auth/login, then set up an');
  console.log('authenticator app at POST /api/v1/admin/auth/mfa/enroll. A code from');
  console.log('that app is required on every sign-in from then on.');
  if (!config.encryptionKey) {
    console.warn('');
    console.warn('WARNING: ENCRYPTION_KEY is not set, so the two-factor secret cannot be');
    console.warn('stored safely and sign-in will refuse to complete. Set it in .env first.');
  }
} catch (error) {
  console.error(`Could not create the staff account: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await connection.close();
}
