# claude-comms E2E suite

End-to-end Playwright tests that spawn a real claude-comms daemon, seed it with
deterministic data, and exercise the web UI against it.

## Layout

```
web/e2e/
├── fixtures/
│   ├── daemon.ts           spawn + teardown daemon in isolated $HOME
│   ├── seedData.ts         programmatic seed of registry.db + meta.json + .jsonl
│   ├── browser.ts          Playwright fixture extension (daemon + appPage + consoleErrors)
│   └── screenshot.ts       snapshot helper with deterministic masking
├── scenarios/
│   └── 01-join-and-history.spec.ts   canonical reference
├── __screenshots__/        baseline PNGs (committed to repo)
└── README.md               this file
```

Legacy specs at `web/e2e/*.spec.js` (`app-loads.spec.js`, etc.) live alongside
but are NOT picked up by `playwright.config.js` (testDir is `./e2e/scenarios`).

## Run the suite

```bash
# IMPORTANT: stop any running dev daemon first (MQTT ports collide).
claude-comms stop

cd web
pnpm playwright install chromium    # one-time per machine
pnpm playwright test                # run every scenario
pnpm playwright test scenarios/01   # just the reference scenario
PLAYWRIGHT_HEADED=1 pnpm playwright test  # see the browser
```

The fixture preflight-checks ports 1883 / 9001 / 9930 / 9931 (slot 0); if any
are occupied the test throws a clear error before spawning a daemon.

## Regenerate baselines

When intentional UI changes ship, regenerate the screenshot baselines:

```bash
cd web
pnpm playwright test --update-snapshots
```

Inspect the diff in `web/e2e/__screenshots__/` before committing. Each scenario
owns its own baselines; check that you only changed what you meant to change.

## Architecture (per `.worklogs/v043-e2e-architecture.md`)

- **Option B per-test-file daemon.** Each `NN-name.spec.ts` file gets a fresh
  daemon on a port-slot derived from its `NN` prefix. Slot 0 = ports 9930/9931
  (MCP/web) + 1893/9011 (MQTT TCP/WS). Slot 1 = +10 on each. Plenty of headroom
  before colliding with Phil's dev daemon on 9920/9921/1883/9001.

- **Isolated $HOME.** The CLI doesn't expose `--data-dir` or `--port-mcp` flags.
  Instead, we spawn the daemon with `HOME=/tmp/cc-e2e-<random>` so every
  `Path.home() / ".claude-comms"` lookup lands inside the test tree. Wiped on
  teardown.

- **Seed-then-spawn.** `seedData.ts` writes registry.db + conv/<name>/meta.json
  + logs/<name>.jsonl BEFORE the daemon starts, so the registry rehydrates +
  broker replays JSONL on boot. No live MQTT publishing during seed.

- **Console-error spy.** Every `appPage` fixture wires page.on('console') and
  page.on('pageerror'). Scenarios assert `consoleErrors` is empty + does not
  contain `state_unsafe_mutation` (regression guard for v0.4.3 bug 1).

- **Screenshots are required, not optional** (Phil's mandate). Default mask
  hides timestamps + version strings + presence dots; meaningful pixels are
  captured. See `fixtures/screenshot.ts`.

## Writing a new scenario (Phase 2 agents)

1. Name the file `NN-short-name.spec.ts` (NN is two digits, used as the slot too).
2. Import `test` and `expect` from `../fixtures/browser` (NOT from `@playwright/test`).
3. Declare the unique port slot at the top of the file:
   ```ts
   test.use({ slot: 1 });   // 02 -> slot 1, 03 -> slot 2, ... 10 -> slot 9
   ```
   Slot N => ports (mcp=9930+N\*10, web=9931+N\*10, mqtt=1893+N\*10, mqtt-ws=9011+N\*10).
4. Default seed is the canonical bundle from `seedData.ts` (3 participants +
   4 channels + 12 messages). Override via:
   ```ts
   import { test } from '../fixtures/browser';
   import { canonicalSeed } from '../fixtures/seedData';

   test.use({
     slot: 1,
     seedSpec: { ...canonicalSeed(), messages: [...] },
   });
   ```
5. Use `appPage` (auto-navigated) over `page` (raw).
6. Assert computed visibility via `await expect(locator).toBeVisible()` — NOT
   just `querySelector !== null`.
7. Call `assertNoConsoleErrors(consoleErrors)` at the end of every scenario.
8. Add screenshot baselines for any visual surfaces the scenario touches; mask
   only what's actually time-dependent.

## Troubleshooting

- **`E2E port 1883/9001 is already in use`** — your dev daemon is running.
  `claude-comms stop` before E2E. The web UI hardcodes `ws://localhost:9001/mqtt`
  so we cannot reassign these ports; lifting that requires a client-side
  refactor.

- **`E2E port 9930/9931 is already in use`** — a previous e2e daemon didn't
  clean up. `pkill -f 'claude-comms start'` and re-run.

- **`Daemon failed to emit "Daemon running"`** — usually means the daemon
  crashed during startup. The error message includes the last 30 log lines;
  check for missing dependencies (`pip install -e .` if running from source)
  or invalid config.yaml syntax.

- **Screenshot diff in CI but not locally** — fonts likely differ. Phil's WSL2
  uses one font set, GitHub Actions uses another. v0.4.3 ships baselines
  generated on Phil's machine; CI tuning is deferred to v0.4.4.

- **`expect(consoleErrors).toEqual([])` fails** — read the failure message; it
  prints every collected error. Network 4xx/5xx during static asset load gets
  filtered automatically; anything else is a real bug.

- **`node:sqlite` experimental warning** — harmless. Node 22 ships the module
  but emits a one-time warning on import. Suppressed in CI via
  `NODE_OPTIONS=--no-warnings` if it gets noisy.
