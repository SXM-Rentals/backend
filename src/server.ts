// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Starts the real API server. It reads the settings,
// connects to the database, assembles the API (see app.ts) and starts
// listening for requests. When the server is told to stop — a new deploy, or
// Ctrl+C on a laptop — it finishes the requests already in progress and closes
// the database connection cleanly before exiting.
//
// It does NOT change the database layout on start-up. Run `npm run db:migrate`
// first; on deploy that is its own explicit step.

import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { connectDatabase } from './db/client.js';

// ---- SETTINGS ----
// A bad setting stops everything here with a readable list, not a stack trace.
let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// ---- DATABASE AND API ----
const connection = await connectDatabase(config.databaseUrl);
const app = await buildApp({ config, db: connection.db });

if (connection.kind === 'pglite') {
  app.log.info('Using the built-in local database in .data/ (set DATABASE_URL to use a Neon branch).');
}

// ---- STOPPING CLEANLY ----
let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'Shutting down');
  try {
    await app.close();
    await connection.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'Error while shutting down');
    process.exit(1);
  }
}
process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

// ---- START LISTENING ----
try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ err: error }, 'Server failed to start');
  await connection.close();
  process.exit(1);
}
