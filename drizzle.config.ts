// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Tells the migration tool where the table definitions
// live and where to write the SQL files it generates from them. Running
// `npm run db:generate` compares the definitions against the last migration
// and writes a new, readable .sql file for the change — which gets reviewed
// like any other code before it ever touches a real database.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
});
