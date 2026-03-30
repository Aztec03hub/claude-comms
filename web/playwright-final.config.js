import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 300000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:6001',
    headless: true,
    navigationTimeout: 30000,
  },
});
