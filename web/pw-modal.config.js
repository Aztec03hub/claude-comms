import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 300000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5175',
    headless: true,
  },
  // No webServer — we serve statically ourselves
});
