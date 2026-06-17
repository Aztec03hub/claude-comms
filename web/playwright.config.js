import { defineConfig } from '@playwright/test';

/**
 * v0.4.3 Phase 1 E2E config.
 *
 * - testDir: './e2e/scenarios' — the new scaffolded suite. Each NN-name.spec.ts
 *   file gets its own daemon on a dedicated port-slot via the worker-scoped
 *   `daemon` fixture in e2e/fixtures/browser.ts. Legacy specs in `./e2e/*.spec.js`
 *   are NOT picked up by this config; run them via vitest or a separate config
 *   if/when migrated.
 *
 * - No webServer block: the daemon serves its own pre-built static bundle from
 *   src/claude_comms/web/dist/ on the per-test web port. We do NOT rely on
 *   Vite at all in E2E mode (the old setup spawned `npx vite --port 5175` which
 *   did not connect to the daemon's API at all).
 *
 * - Workers: spec files run on separate workers so the per-file daemon fixture
 *   does not collide on ports. Tests WITHIN a file run serially (the worker
 *   fixture is reused).
 *
 * - Screenshot defaults: maxDiffPixels=500 to absorb run-to-run icon/font
 *   anti-aliasing on small element captures (audit W-6/W-7); tunable
 *   per-call via expectScreenshot's maxDiffPixels option. Animations
 *   disabled by waitForStable() in fixtures/screenshot.ts.
 */
export default defineConfig({
  testDir: './e2e/scenarios',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixels: 500,
      animations: 'disabled',
    },
  },
  retries: process.env.CI ? 2 : 0,
  // One worker per spec file (each gets its own daemon + port-slot).
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  use: {
    // baseURL is set per-test by the `appPage` fixture from daemon.baseURL.
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    navigationTimeout: 30_000,
  },
  snapshotDir: './e2e/__screenshots__',
  // No webServer: the daemon fixture owns the lifecycle.
});
