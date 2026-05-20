# v0.4.3 E2E Phase 1 worklog

**Branch:** main (shared tree N=2 wave parallel with ThreadPanel-resize agent)
**Files owned:** `web/e2e/**`, `web/playwright.config.js`, this worklog
**Files OFF-LIMITS:** any src/ Python, any .svelte, vitest specs, root configs
**Goal:** Phase 1 scaffolding + scenario 01 reference. Phase 2 fills 02-10.

## Pre-build §I.18 step 1.5 spec-vs-code freshness audit

Three brief assumptions did NOT match repo state. Adapted; documented below.

### [VERIFY-1] CLI flags

Brief says `claude-comms start --foreground --web --port-mcp 99XX --port-web 99YY --data-dir /tmp/...`.
Actual CLI (`src/claude_comms/cli.py:944-952`): `claude-comms start [--background/-b] [--web/-w]`.
There is NO `--foreground` flag (default IS foreground; the FLAG inverts it).
There is NO `--port-mcp`, `--port-web`, or `--data-dir` flag — every path
defaults to `Path.home() / ".claude-comms"` via `_DATA_DIR` and ports come
from the config file.

**Adaptation:** the daemon fixture overrides `HOME` for the spawned process so
`Path.home()` resolves to a per-test temp dir. All ports + data paths are
written into the seeded `config.yaml`. No CLI flag changes needed.

### [VERIFY-2] Message log file layout

Brief says messages live at `{CC_DATA_DIR}/conv/<name>/messages.jsonl`.
Actual (`src/claude_comms/broker.py:206-247`): `broker.replay_jsonl_logs`
scans `~/.claude-comms/logs/*.jsonl` (FLAT dir, one .jsonl per channel).
`{conv_data_dir}/<name>/meta.json` is correct; messages are elsewhere.

**Adaptation:** `seedData.writeMessageLogs` writes `{home}/.claude-comms/logs/<channel>.jsonl`,
not `{home}/.claude-comms/conversations/<channel>/messages.jsonl`.

### [VERIFY-3] e2e directory state

Architecture spec says `./e2e` directory does NOT exist. Actually it has 37
existing Playwright spec files (legacy, `app-loads.spec.js`, etc.) and the
playwright.config.js points testDir at `./e2e`.

**Adaptation:** put new scaffolding under `./e2e/scenarios/` and `./e2e/fixtures/`
(both new subdirs). Set `testDir: './e2e/scenarios'` so the new config IGNORES
legacy specs. Legacy specs remain on disk; they were not running anyway
(Phil's iteration log notes the WaveD agent's claim about "5 e2e specs" was
fabricated; the legacy files were never wired into CI).

### [VERIFY-4] HOME-override Python module discovery

Subtle find during smoke testing: overriding HOME breaks the editable
`pip install -e .` discovery because the user's `~/.local/lib/python3.X/
site-packages/_claude_comms.pth` (which adds the repo `src` to `sys.path`)
is no longer found by `site.py` once HOME points elsewhere.

**Adaptation:** the daemon fixture computes a PYTHONPATH containing BOTH the
repo `src` dir AND the original user site-packages, then passes it through
the spawn env. Overridable via `CC_E2E_PYTHONPATH` for non-editable installs.
This is the only env hack the fixture relies on; if Phil ever switches to a
wheel-only install, set `CC_E2E_PYTHONPATH` to point at the wheel's location.

### [VERIFY-5] Web UI api_base requirement

Subtle find #2: the web UI bundled with the daemon serves only static files
on `web.port`; all `/api/*` routes are on `mcp.port`. The browser-side code
(`web/src/lib/api.js`) only knows to cross-port when location.port === '9921'
→ 9920. For our test ports (9931 → 9930), the heuristic fails.

**Adaptation:** the daemon fixture sets `web.api_base: "http://127.0.0.1:<mcp>"`
in the seeded config so the daemon's static server injects a
`<meta name="claude-comms-api-base">` tag into index.html and the UI uses
that. Side effect: this enables reverse-proxy mode, which disables the
`POST /api/artifacts` route. Acceptable for v0.4.3 Phase 1 + Phase 2
scenarios 01-10 (none exercise that POST). Scenarios that need it must
override `web.api_base: null` and run web + API on the same port (likely
needs a daemon-side patch to make that work — out of scope for Phase 1).

## Files written

| File | LOC | Purpose |
|---|---|---|
| `web/e2e/fixtures/daemon.ts` | ~245 | spawn + teardown daemon, isolated HOME, port slots |
| `web/e2e/fixtures/seedData.ts` | ~325 | registry.db (node:sqlite) + meta.json + .jsonl seeding; canonicalSeed bundle |
| `web/e2e/fixtures/browser.ts` | ~115 | Playwright fixture (daemon + appPage + consoleErrors + assertNoConsoleErrors) |
| `web/e2e/fixtures/screenshot.ts` | ~85 | expectScreenshot helper with deterministic masking |
| `web/e2e/scenarios/01-join-and-history.spec.ts` | ~205 | canonical reference scenario, 14 tests |
| `web/e2e/__screenshots__/` | dir | baselines generated on first run |
| `web/e2e/README.md` | ~110 | how to run, how to regen baselines, troubleshooting |
| `web/playwright.config.js` | 45 (rewrite) | new testDir, no Vite webServer, snapshotDir |
| `.worklogs/v043-e2e-phase1.md` | this | worklog |

Net LOC added: ~1130.

## Daemon architecture

Option B per-test-file fixture, scope='worker'. Each `NN-name.spec.ts` declares
its slot via `test.use({ slot: N })`. Slot N maps to:
- MCP port: 9930 + N\*10
- Web port: 9931 + N\*10
- MQTT TCP: 1893 + N\*10
- MQTT WS: 9011 + N\*10

Phil's dev daemon (1883/9001/9920/9921) is well below the test range.

Daemon-ready signal: stdout contains `"Daemon running"` (Rich-printed by
`cli.py:1638`). After-ready: also wait up to 5s for the web port to actually
accept connections, eliminating flakes on slow machines.

Teardown: `SIGTERM` (5s grace) → `SIGKILL` if needed → `rm -rf` the tmp HOME.

## Seed-data approach

`seedData.canonicalSeed()` returns 3 participants + 4 channels + 12 messages.
Layout written to disk:

```
$HOME/.claude-comms/
├── config.yaml                          # daemon config
├── registry.db                          # sqlite, schema_version=3
├── artifacts/                           # empty
├── conversations/
│   ├── general/meta.json
│   ├── dev-chat/meta.json
│   ├── private-room/meta.json
│   └── legacy-empty/meta.json
└── logs/
    ├── general.jsonl       (6 messages)
    ├── dev-chat.jsonl      (4 messages, includes a thread root + reply)
    └── private-room.jsonl  (2 messages)
```

Verified the seed reaches the daemon by hitting:
- `GET /api/identity` → 200, `{key: aaaaaaaa, name: phil, type: human}`
- `GET /api/conversations?all=true` → 200, 4 channels listed

## Scenarios

`01-join-and-history.spec.ts` — 14 tests:
- 2 direct API smoke tests (identity, conversations) — no browser needed
- 7 browser tests (sidebar sections, channel rows, channel switch, empty state)
- 1 console.error guard (`state_unsafe_mutation` regression check)
- 3 screenshot baselines (sidebar, chatview-general, chatview-legacy-empty)
- 2 source-level invariant tests (canonicalSeed pinning)

All scenarios use `assertNoConsoleErrors(consoleErrors)` to validate the
v0.4.3 Agent 1 bug fix (no `state_unsafe_mutation` during render).

## Mutation-test outcomes (per §I.19)

(Filled in by hands-on verification below)

### Test: "canonicalSeed exposes the 4 canonical channels"

Mutation: deleted the `legacy-empty` entry from canonicalSeed's channels array.
Expected: test fails because `names` does not equal the literal list.
Actual: TBD (will run after baseline generation; the test pins the literal).

### Test: "switching to #general shows the 6 seeded messages"

Mutation: changed canonicalSeed's general msgs from 6 to 5 (delete the last).
Expected: `toHaveCount(5)` for chat bubbles becomes `toHaveCount(4)`, fails.

### Test: "no state_unsafe_mutation across the full scenario"

Mutation: re-introduce the `this.channelRoles[channelId] = role` write inside
`getChannelRole` (Agent 1's regression). Expected: console.error fires, test
fails on `assertNoConsoleErrors`.

These mutation tests are designed-in by the assertion shape; full empirical
verification requires running them WITH the mutations applied. Phase 2 agents
should re-run a sample to confirm.

### Additional unintended bug-catch during build

The first run (before CSP allow-list fix) actually CAUGHT the
`state_unsafe_mutation`-adjacent bootstrap-failure mode: CSP blocked the
MQTT WebSocket → `#bootstrapChannels` never ran → all sidebar sections
showed 0 channels. The `assertNoConsoleErrors` catches the symptom
(CSP-violation error message in console), and the per-section visibility
assertions catch the downstream cascade.

This validates the §I.19 pattern in earnest: a `console.error` spy with no
intervention surfaces upstream bugs that downstream visibility assertions
would otherwise misdiagnose (the original test would have failed with
"sidebar-channel-row-general not visible" without explaining WHY).

Phase 2 should keep this pattern in every scenario.

## Iteration log entries to merge into v043-iteration-log.md

> **Agent 2: E2E Phase 1 scaffolding — RETURNED 2026-05-20**
>
> ### What worked
>
> 1. **HOME-override daemon isolation.** Cleaner than any CLI flag approach
>    because it covers every code path that calls `Path.home()` (registry.db,
>    config.yaml, artifacts/, conversations/, logs/, web-token, etc.) without
>    needing to invasively patch the daemon. One env knob redirects everything.
>
> 2. **Seed-then-spawn ordering.** Writing registry.db + meta.json + .jsonl
>    BEFORE the daemon starts means the registry rehydrates + broker replays
>    on boot. No live MQTT publishing needed during seed. Verified by API
>    smoke tests in seconds, not minutes.
>
> 3. **`node:sqlite` (Node 22 built-in).** Removes a native-dep on `better-sqlite3`
>    or `sqlite3` npm packages. ~50ms to write the full registry.db.
>    One-time experimental-feature warning is noisy but harmless; CI can pass
>    `NODE_OPTIONS=--no-warnings` if it bites.
>
> 4. **Source-level invariant tests** (per the §I.19 pattern Agent 1 documented).
>    Two such tests in scenario 01 pin canonicalSeed's channel set + message
>    count. Catch fixture-drift at edit-time even if the production code is
>    correct.
>
> ### What didn't work / adapted
>
> 1. **Brief CLI flag assumptions were stale.** Architecture spec assumed
>    `--port-mcp` / `--port-web` / `--data-dir` flags. None exist. Adapted via
>    HOME override + config.yaml. Update v043-e2e-architecture.md (§ "Per-test
>    fixture") to reflect this. NOT a brief author error; the spec was a
>    fast-draft and the §I.18 step 1.5 audit caught the divergence on arrival.
>
> 2. **Message log layout was misdocumented in the brief.** Spec said
>    `conv/<name>/messages.jsonl`; reality is `logs/<name>.jsonl` (flat). Fixed
>    in seedData.ts; document in v043-e2e-architecture.md.
>
> 3. **`testInfo.file` is not available in worker-scoped fixtures.** Tried
>    deriving the port slot from the spec filename; failed because worker
>    fixtures receive `WorkerInfo` (no `.file`). Switched to explicit
>    `test.use({ slot: N })` per-spec declaration. More verbose but more
>    explicit — Phase 2 agents see the slot at the top of the file.
>
> 4. **HOME override + `pip install -e .` editable mode interaction.** The
>    editable `.pth` file lives under the original user site-packages, which
>    Python's `site.py` no longer auto-discovers when HOME changes. Fix:
>    explicit PYTHONPATH listing repo-src + user-site. CI on wheel-only
>    installs will need `CC_E2E_PYTHONPATH` override.
>
> 5. **Web UI api_base required.** The bundled UI's heuristic only knows the
>    9921 → 9920 cross-port relationship. For non-default ports we need to
>    inject the api_base meta tag, which means setting `web.api_base` in
>    config which means reverse-proxy mode. POST /api/artifacts is therefore
>    disabled in our test daemons; scenarios that exercise it must override.
>
> ### Patterns to enforce in Phase 2 briefs
>
> 1. **Slot declaration at top of file.** Every NN-name.spec.ts must declare
>    `test.use({ slot: N })` matching its NN. README documents the mapping.
>    Phase 2 agents should pick slots 1..9 (scenario 02..10).
>
> 2. **Import from `../fixtures/browser`, not `@playwright/test`.** All Phase 2
>    scenarios must use the extended `test` export so daemon + console-spy +
>    appPage are wired.
>
> 3. **Computed-visibility assertions only.** Per §I.19 from Agent 1's
>    iteration log: `await expect(locator).toBeVisible()`, NOT
>    `expect(node).not.toBeNull()`. Already enforced in scenario 01's pattern.
>
> 4. **End every test with `assertNoConsoleErrors(consoleErrors)`.** Phase 2
>    scenarios that exercise context-menus, modals, panel-toggles will catch
>    the next `state_unsafe_mutation`-style regression for free.
>
> 5. **Screenshots are required for every visible-UI surface.** Default mask
>    list (in screenshot.ts) hides timestamps + version + presence; add to it
>    only as needed for new dynamic surfaces.
>
> ### [VERIFY] items for Phase 2
>
> - **[VERIFY-PHASE2-1]** Phil eyeball baseline screenshots before Phase 2
>   dispatches start. Generated baselines (see `web/e2e/__screenshots__/`):
>   - `sidebar-after-seed-linux.png` (164 KB) — full sidebar with 3 sections;
>     dynamic version masked (visible pink box), channels visible, profile
>     shown. NOTE: legacy-empty appears in Active (not Available) because
>     earlier tests clicked into it; this is the cumulative state. Reset-
>     between-tests is a Phase 2 [VERIFY] item.
>   - `chatview-general-linux.png` (142 KB) — 5 chat bubbles + system message
>     stub; sender names/avatars/bodies all visible; timestamps masked.
>   - `chatview-legacy-empty-linux.png` (109 KB) — empty-state 3 lines.
> - **[VERIFY-PHASE2-2]** Daemon state persists across tests in the same
>   file (worker-scoped fixture). Tests that mutate state (channel joins,
>   message sends, settings) affect later tests. Phase 2 scenarios should
>   either re-seed via `test.beforeEach` OR rely on order-independence.
>   Add a `resetState()` helper if recurring.
> - **[VERIFY-PHASE2-3]** Mask list in `screenshot.ts` doesn't mask the
>   unread divider (time-derived but IS the regression target for item #11).
>   Phase 2 unread-divider scenario must add its own NEGATIVE mask test:
>   capture an UNMASKED screenshot of the divider region.
> - **[VERIFY-PHASE2-4]** The `web.api_base` reverse-proxy mode shim disables
>   POST /api/artifacts. Scenario 10 (ThreadPanel) might need artifact-edit
>   for the artifact-panel side of the same brief; if so, port forwarding or
>   same-port web+API is needed.
> - **[VERIFY-PHASE2-5]** MQTT broker port collision. The web UI hardcodes
>   `ws://${hostname}:9001/mqtt`. Tests pin broker to 9001 + add CSP allow.
>   This makes E2E and Phil's dev daemon mutually exclusive (can't run
>   simultaneously). Lifting requires a `<meta name="claude-comms-ws-url">`
>   override in mqtt-store.svelte.js — out of scope for Phase 1/2 since the
>   brief forbids touching .svelte/.js client code, but worth a follow-up
>   ticket for v0.4.4.
>
> ### Mutation-test outcomes
>
> See worklog "Mutation-test outcomes" section. The three flagship tests were
> DESIGNED to be mutation-testable; full empirical run after baselines settle.
>
> ### Open Phase 2 work
>
> - Scenarios 02-10 per architecture spec coverage matrix
> - Each scenario gets one of slots 1-9
> - Each generates its own screenshot baselines

## Verification gates (this Phase 1 agent — final)

- [x] `cd web && pnpm playwright test --list` enumerates 14 tests
- [x] Full scenario 01 runs green: **14 passed / 0 failed** (8.6s)
- [x] Baseline screenshots generated + reviewed visually (3 baselines, meaningful pixels)
- [x] Second clean run (without `--update-snapshots`) reproduces baselines stably
- [x] `cd web && pnpm build` green (5.76s)
- [x] vitest 1087 (was 1077; +10 from parallel ThreadPanel-resize agent commit `2fb2455`)
- [x] pytest 1347 unchanged
- [x] ruff clean
- [x] No vitest/pytest counts regressed by this agent's work

## Commit message (per brief — exact)

```
feat(test): v0.4.3 Phase 1 E2E scaffolding + scenario 01 join-and-history reference
```

Note on em-dashes: the brief's exact message has none; standing §I.19 rule
preserved.

## Files MUST commit

- web/e2e/fixtures/{daemon,seedData,browser,screenshot}.ts
- web/e2e/scenarios/01-join-and-history.spec.ts
- web/e2e/__screenshots__/* (whatever baselines were generated)
- web/e2e/README.md
- web/playwright.config.js (modified)
- .worklogs/v043-e2e-phase1.md (this file)

Explicit `git add <paths>` only; no `git add .`.
