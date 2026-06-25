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
 *   fixture is reused). All daemon ports are slot-scoped (e2e/fixtures/daemon.ts
 *   `portsForSlot`), so N daemons run side by side; CI runs 4 workers. The old
 *   1-worker pin (broker on a hardcoded 9001) is gone — single-origin moved the
 *   browser's broker WS onto the per-slot web port (`/mqtt` bridge).
 *
 * - Screenshot defaults: maxDiffPixelRatio=0.02 (a size-independent 2%) to
 *   absorb run-to-run icon/font anti-aliasing (audit W-6/W-7); tunable per-call
 *   via expectScreenshot's options. Animations disabled by waitForStable() in
 *   fixtures/screenshot.ts. NOTE: when both maxDiffPixels and maxDiffPixelRatio
 *   are set, Playwright applies the STRICTER (Math.min), so we use the ratio
 *   alone here and the helper only adds an absolute count to TIGHTEN a snapshot.
 *
 * - Visual snapshots run ON DEMAND only (the `E2E visual smoke` CI job is
 *   workflow_dispatch-gated), regenerated to match the CI runner via
 *   `gh workflow run ci.yml -f update_baselines=true`. The push/PR e2e gate runs
 *   with --ignore-snapshots (behavior only).
 */
export default defineConfig({
  testDir: './e2e/scenarios',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },
  // Real flakes (LWT + rename races) were fixed in PR #36, so a single retry is
  // enough to absorb rare CI hiccups without tripling the cost of a genuine
  // failure (2 retries did).
  retries: process.env.CI ? 1 : 0,
  // File-level parallelism: each spec file gets its own daemon on a dedicated
  // slot-scoped port set, so files run concurrently while tests within a file
  // share the file's daemon (hence fullyParallel stays false).
  fullyParallel: false,
  workers: process.env.CI ? 4 : undefined,
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
