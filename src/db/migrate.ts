// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The command behind `npm run db:migrate`. It brings the
// database up to date by applying any migration files it has not applied yet,
// in order, and then stops. On deploy this runs as its own explicit step
// before the new version goes live — the server never changes the database
// layout by itself when it starts.

import { loadConfig } from '../config.js';
import { connectDatabase } from './client.js';

const config = loadConfig();
const connection = await connectDatabase(config.databaseUrl);

try {
  console.log(`Applying migrations to the ${connection.kind === 'postgres' ? 'Neon' : 'local built-in'} database...`);
  await connection.migrate();
  console.log('Database is up to date.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await connection.close();
}
