import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5175',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
