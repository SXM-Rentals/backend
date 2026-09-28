// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The command behind `npm run admin:godfather` — hands the
// Godfather role to an existing staff account, and makes whoever had it an Owner.
//
// The Godfather is the one account nobody else can disable, reset or demote, so
// the panel cannot hand it over — only somebody with access to the server can.
// You should rarely need this: the migration that introduced staff levels made
// the first account ever created the Godfather. This is for when that was the
// wrong account, or the business changes hands.
//
// Like `admin:create` and `admin:reset` it writes NO audit entry: there is no
// staff member acting, only somebody with access to the server itself.
//
// Usage:
//   npm run admin:godfather -- name@example.com

import { loadConfig } from '../config.js';
import { connectDatabase } from '../db/client.js';
import { makeGodfather } from '../services/admin/godfather.js';

const [email] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

if (!email) {
  console.error('Usage: npm run admin:godfather -- name@example.com');
  process.exit(1);
}

const config = loadConfig();

// Without a database address this quietly uses the small local database in
// .data/, where the account almost certainly does not exist — and it would look
// like it worked while the live panel stayed exactly as it was.
if (!config.databaseUrl) {
  console.warn('WARNING: DATABASE_URL is not set, so this is changing the LOCAL database in .data/,');
  console.warn('not the live server. Set it to the production address first if that is not what you meant.');
  console.warn('');
}

const connection = await connectDatabase(config.databaseUrl);

try {
  const result = await makeGodfather(connection.db, email);

  if (!result.changed) {
    console.log(`${result.name} <${result.email}> is already the Godfather. Nothing was changed.`);
  } else {
    console.log(`${result.name} <${result.email}> is now the Godfather.`);
    if (result.previous) {
      console.log(`${result.previous.name} <${result.previous.email}> was the Godfather and is now an Owner.`);
    }
    console.log('');
    console.log('Both have been signed out of the admin panel, so they sign in again to a panel');
    console.log('drawn for what they may now do.');
  }
} catch (error) {
  console.error(`Could not hand over the Godfather role: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await connection.close();
}
