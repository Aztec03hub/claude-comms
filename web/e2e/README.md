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
cd web
pnpm playwright install chromium    # one-time per machine
pnpm playwright test                # run every scenario (parallel: one worker per spec file)
pnpm playwright test scenarios/01   # just the reference scenario
PLAYWRIGHT_HEADED=1 pnpm playwright test  # see the browser
```

Every daemon port is slot-scoped, so spec files run side by side on separate
workers and there is no longer any conflict with Phil's dev daemon (which lives
on 9920/9921/1883/9001 — a different range). The fixture preflight-checks the
slot's four ports (mcp/web/broker-tcp/broker-ws) before spawning; if any are
occupied (a stale e2e daemon) it throws a clear error.

## Regenerate baselines

When intentional UI changes ship, regenerate the screenshot baselines:

```bash
cd web
pnpm playwright test --update-snapshots
```

Inspect the diff in `web/e2e/__screenshots__/` before committing. Each scenario
owns its own baselines; check that you only changed what you meant to change.

### CI-matching baselines

Baselines committed from a local machine (WSL2 fonts) drift from GitHub's
runner render (different font anti-aliasing), so a local `--update-snapshots`
baseline can diff a few percent on CI. To regenerate baselines that MATCH the
CI runner, run the `E2E visual smoke` workflow on your branch with the
`update_baselines` input set to `true`:

```bash
gh workflow run ci.yml --ref <your-branch> -f update_baselines=true
```

The job runs `playwright test --grep "screenshot:" --update-snapshots` on
`ubuntu-latest` and commits the regenerated `*-linux.png` baselines back to the
branch. Tolerance is a uniform 2% (`maxDiffPixelRatio: 0.02`, see
`fixtures/screenshot.ts`) which absorbs residual sub-2% AA noise once baselines
are CI-matched. The visual job does NOT run on push/PR (it never blocked merge,
and off-CI baselines made it perpetually red); it is on-demand only.

## Architecture (per `.worklogs/v043-e2e-architecture.md`)

- **Option B per-test-file daemon.** Each `NN-name.spec.ts` file gets a fresh
  daemon on a port-slot derived from its `NN` prefix. Slot N = ports
  `mcp=9930+N*10`, `web=9931+N*10`, `broker-tcp=9932+N*10`, `broker-ws=9933+N*10`
  (see `fixtures/daemon.ts` `portsForSlot`). Every port is slot-scoped, so N
  daemons run concurrently with full isolation. The browser never touches the
  broker WS port: single-origin (PRs #23-26) bridges the broker onto the daemon's
  own web port at `/mqtt` (`broker_ws_same_origin: true` via /api/capabilities),
  so the client connects to `ws://<page-host>:<web-port>/mqtt`. The slot's
  broker TCP/WS ports exist only for the daemon's own + non-web MQTT clients.

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

- **`E2E port <port> (slot N) is already in use`** — a previous e2e daemon
  didn't clean up its slot. `pkill -f 'claude-comms start'` and re-run. (The
  old "stop your dev daemon, MQTT ports are pinned to 1883/9001" caveat is gone:
  all ports are slot-scoped now, so the dev daemon no longer collides.)

- **`Daemon failed to emit "Daemon running"`** — usually means the daemon
  crashed during startup. The error message includes the last 30 log lines;
  check for missing dependencies (`pip install -e .` if running from source)
  or invalid config.yaml syntax.

- **Screenshot diff in CI but not locally** — fonts differ (WSL2 vs GitHub
  Actions render). Regenerate CI-matching baselines via the on-demand visual
  workflow (see "CI-matching baselines" above) rather than committing local
  baselines. Tolerance is a uniform 2% (`maxDiffPixelRatio: 0.02`).

- **`expect(consoleErrors).toEqual([])` fails** — read the failure message; it
  prints every collected error. Network 4xx/5xx during static asset load gets
  filtered automatically; anything else is a real bug.

- **`node:sqlite` experimental warning** — harmless. Node 22 ships the module
  but emits a one-time warning on import. Suppressed in CI via
  `NODE_OPTIONS=--no-warnings` if it gets noisy.
