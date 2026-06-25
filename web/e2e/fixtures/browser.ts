// browser.ts — Playwright fixture extension.
//
// Wires the per-test-file daemon + seed into Playwright's `test` fixture.
// Each scenario imports `test` and `expect` from this file (not from
// '@playwright/test' directly) so the daemon lifecycle is bound to the
// fixture worker.
//
// Console-error spy: every scenario gets a `consoleErrors` array that auto-
// collects page console.error + pageerror events. Per the §I.19 iteration log
// pattern, scenarios assert this is empty (and specifically does NOT contain
// "state_unsafe_mutation") at the end of the test.

import { test as base, expect, Page, ConsoleMessage } from '@playwright/test';
import { spawnDaemon, DaemonHandle, IdentitySeed } from './daemon';
import { seedDataDir, canonicalSeed, SeedSpec, PHIL } from './seedData';

export interface E2EFixtures {
  /**
   * The running daemon for this test-file. Started in beforeAll, torn down
   * in afterAll. Each test in the file shares it (scenarios are read-mostly).
   */
  daemon: DaemonHandle;
  /**
   * A Playwright Page already navigated to the daemon's web UI baseURL with
   * console-error tracking armed.
   */
  appPage: Page;
  /**
   * Console errors collected during this test. Includes both console.error
   * messages and pageerror events. Assert empty (or "no state_unsafe_mutation")
   * at the end of every scenario.
   */
  consoleErrors: string[];
}

/**
 * Per-test options. Each scenario file declares its slot via
 * `test.use({ slot: N })`. Slot 0 = ports 9930/9931/1893/9011, +10 per slot.
 *
 * Override `seedSpec` for scenarios that need data beyond the canonical
 * bundle (e.g. extra channels for invite-flow tests).
 */
export interface E2EOptions {
  /**
   * Port-allocation slot for this spec file. MUST be unique across the suite.
   * Phase 1 scenario 01 = slot 0. Phase 2 scenarios 02-10 should use slots 1-9.
   */
  slot: number;
  seedSpec: SeedSpec;
  identity: IdentitySeed;
}

export const test = base.extend<E2EFixtures & E2EOptions>({
  // Worker-scoped option fixtures so the worker-scoped `daemon` can depend
  // on them. Override at the spec level with `test.use({ slot, seedSpec, ... })`.
  slot: [0, { option: true, scope: 'worker' }],
  // Default seed = canonical bundle (3 participants, 4 channels, 12 messages).
  seedSpec: [canonicalSeed(), { option: true, scope: 'worker' }],
  // Default identity = phil (matches the canonical seed's owner).
  identity: [PHIL, { option: true, scope: 'worker' }],

  // Per-test-file daemon. Scope='worker' so one daemon serves every test in
  // the spec file. Playwright runs spec files on separate workers by default,
  // so port collisions are avoided.
  daemon: [async ({ slot, seedSpec, identity }, use) => {
    const handle = await spawnDaemon({
      slot,
      identity,
      seed: (home) => seedDataDir(home, seedSpec),
    });
    await use(handle);
    await handle.stop();
  }, { scope: 'worker' }],

  // Per-test console-error collector.
  consoleErrors: async ({}, use) => {
    const errors: string[] = [];
    await use(errors);
  },

  // Pre-navigated page with errors wired.
  appPage: async ({ page, daemon, consoleErrors }, use) => {
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        const entry = `[console.error] ${msg.text()}`;
        if (!isBenignConsoleNoise(entry)) consoleErrors.push(entry);
      }
    });
    page.on('pageerror', (err: Error) => {
      const entry = `[pageerror] ${err.message}`;
      if (!isBenignConsoleNoise(entry)) consoleErrors.push(entry);
    });

    await page.goto(daemon.baseURL);
    await page.waitForLoadState('domcontentloaded');

    await use(page);
  },
});

export { expect };

/**
 * Known-benign console noise that is NOT an application defect and must not
 * fail a scenario:
 *
 *  - "Failed to load resource" — a slow / racey static-asset fetch.
 *  - "WebSocket is already in CLOSING or CLOSED state." — Chromium logs this
 *    (verbatim, both words in one phrase) when a pending publish (keepalive /
 *    LWT / presence) races the socket teardown that `page.reload()` and
 *    end-of-test navigation trigger. It is pure teardown noise: the page is
 *    being torn down, the broker connection is closing, and there is no
 *    functional impact. It surfaces only under parallel CPU contention (which
 *    shifts the reload-vs-close timing), never in steady state. Filtered here
 *    so the per-test console-error spy and assertNoConsoleErrors both ignore it.
 *
 * @param {string} entry - A collected console-error / pageerror string.
 * @returns {boolean} true when the entry is benign noise to be ignored.
 */
export function isBenignConsoleNoise(entry: string): boolean {
  return (
    /Failed to load resource/.test(entry) ||
    // Verbatim Chromium message: "WebSocket is already in CLOSING or CLOSED
    // state." Match the whole phrase — a `(CLOSING|CLOSED) state` alternation
    // does NOT match because the real text is "CLOSING or CLOSED state".
    /WebSocket is already in CLOSING or CLOSED state/.test(entry)
  );
}

/**
 * Assertion helper: verify no console.error or pageerror fired during the
 * test, and specifically that "state_unsafe_mutation" was not thrown.
 *
 * Per §I.19 iteration log: this is the regression guard for Agent 1's
 * getChannelRole pure-read fix.
 */
export function assertNoConsoleErrors(consoleErrors: string[]): void {
  // Filter out known-benign noise (slow static asset load, WS teardown race).
  // Real bugs come from app code; we want to catch THOSE.
  const real = consoleErrors.filter((e) => !isBenignConsoleNoise(e));
  expect(real, `Unexpected console errors:\n${real.join('\n')}`).toEqual([]);
  // Belt-and-braces: even if the filter let one through, ban the cascade bug.
  for (const e of consoleErrors) {
    expect(e).not.toContain('state_unsafe_mutation');
  }
}
