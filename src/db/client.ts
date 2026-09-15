// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Opens the connection to the database that everything in
// the backend reads from and writes to. There are two kinds:
//   - the real Postgres on Neon, used whenever DATABASE_URL is set; and
//   - PGlite, a full Postgres that runs inside this program, used by the tests
//     (a fresh, empty one for every test file) and on a developer's laptop when
//     no Neon branch has been set up, so the backend runs with zero setup.
// Both speak the same Postgres, so the same code and migrations work on each.
// Also applies the migrations — only when asked, never silently on start-up.

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as schema from './schema/index.js';

// The database handle every service receives.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DatabaseConnection = {
  db: Database;
  kind: 'postgres' | 'pglite';
  // Brings the database up to the latest schema.
  migrate: () => Promise<void>;
  close: () => Promise<void>;
};

// The SQL migration files. Resolved from this file's location so it works both
// from src/ (development, tests) and from dist/ (the built server).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

// ---- THE REAL DATABASE (NEON) ----
export function connectPostgres(databaseUrl: string): DatabaseConnection {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzlePostgres(pool, { schema });
  return {
    db: db as unknown as Database,
    kind: 'postgres',
    migrate: () => migratePostgres(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => pool.end(),
  };
}

// ---- THE BUILT-IN DATABASE (TESTS AND ZERO-SETUP DEVELOPMENT) ----
// With no folder it lives only in memory and vanishes when the program stops.
export async function connectPglite(dataDir?: string): Promise<DatabaseConnection> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  return {
    db: db as unknown as Database,
    kind: 'pglite',
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
}

// ---- PICKING ONE ----
// Neon when DATABASE_URL is set; otherwise the built-in database saved in .data/.
export async function connectDatabase(databaseUrl: string | undefined): Promise<DatabaseConnection> {
  if (databaseUrl) return connectPostgres(databaseUrl);
  return connectPglite(fileURLToPath(new URL('../../.data/pglite', import.meta.url)));
}
