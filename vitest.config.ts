// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The settings for the test runner. Tests live in test/,
// run in Node (there is no browser here), and each test file gets its own
// throwaway in-memory database, so no test can see another test's data.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Building the database from the migrations takes a moment on first run.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
