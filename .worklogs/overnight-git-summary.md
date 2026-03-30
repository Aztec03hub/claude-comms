# Overnight Git History Summary — 2026-03-30

**165 commits** from overnight agent session.

---

## Bug Fixes (28 commits)
- `81da3b8` **ROOT CAUSE** — ConnectionStatus `$effect` infinite loop (Svelte 5 reactivity)
- `ffd5855` defer fetchHistory state update for Svelte 5 reactivity
- `8156b37` patch XSS in search highlight and restrict CORS to web UI origin
- `3fbbc22` make web UI server bind address configurable via config
- `bda0728` theme toggle in settings panel + markUnread localStorage persistence
- `d5bfae6` TUI now filters stale/offline presence like web UI
- `54894de` add client field to web presence to distinguish web vs TUI participants
- `1c4b68a` filter stale/offline presence to prevent phantom participants
- `407fd15` make daemon resilient to amqtt broker crashes on WS disconnect
- `16f17da` skip own presence messages to prevent offline overwrite
- `8be9ee3` TUI test sender_key too short for Pydantic validation
- `51b92ab` URL linkification, seen tracking wiring, and file attachment architecture docs
- `2a3475c` add self to participant list on connect
- `b53558e` change "agents online" to "participants online" in banner
- `ad58db5` connection banner dismiss button and auto-hide after connect
- `33fe813` emoji picker sizing and reaction badge visibility
- `e002b3f` typing indicator re-trigger on send, add TUI typing/LWT tests
- `9b3b961` View Profile shows other users' info instead of own settings
- `bed06bd` wire profile card Message and View Profile buttons
- `573a4f7` reaction bar + button and toggle handlers
- `88bd346` emoji picker inserts emoji into input when opened from input bar
- `2a60feb` revert EmojiPicker and ProfileCard from broken bits-ui Popover
- `164f6fc` add cursor pointer + hover state to user profile bar
- `bae1d8e` make entire user profile area clickable for profile card
- `cb91bcf` wire search panel filter tabs and fix ForwardPicker Svelte 5 syntax
- `48372d7` add cleanup functions to `$effect` timers in ConnectionStatus
- `0db462a` round 8 edge cases (8 tests, 1 bug fixed)
- `ddac1c8` round 8 edge case test+fix

## Features (10 commits)
- `3da64ec` message rendering FIXED + module-level store alternative
- `e7682d0` REST API for message history + web UI persistence on refresh
- `7986178` MCP comms_join now publishes MQTT presence
- `0f1f09b` client and status fields to participants REST API response
- `47e7ecb` broadcast reactions, pins, and deletions over MQTT to all clients
- `6398b42` notification sound support, click-to-focus, improved body formatting
- `f439334` Sprint 2 Batch 3 — wire all 11 dead buttons + 3 context actions
- `d99d090` Sprint 2 Batch 2 — replace all inline SVGs with Lucide icons
- `653e4d8` TUI enhanced channel list with message previews, muted indicator, unread badges
- `0db462a` TUI status bar with connection state, typing indicators, user identity

## Tests (30 commits)
- `2116942` 36 expanded gap tests across five target modules (714 total)
- `5a43d04` REST API endpoint tests (25) + broker resilience tests
- `1c07848` comprehensive 60-test overnight web UI testing suite (all 9 rounds)
- `2088535` web UI rounds 1-5 — all pass, zero bugs
- `8760d93` round 1 — broker lifecycle tests (31 new)
- `d75ac7e` round 2 — MCP tools + ParticipantRegistry + pagination (43 new)
- `9fe4ad6` round 3 — log exporter tests (24 new)
- `0e09efa` round 4 — CLI command tests (19 new)
- `68fbf0f` round 5 — gap tests for error handling + edge cases (27 new)
- `7a8caf1` round 6 — modal flow tests (8 tests, all pass)
- `40a77a0` round 7 — keyboard shortcuts comprehensive (10 tests, all pass)
- `4d955e4` round 9 — visual consistency (10 tests, all pass)
- `bbc289f` TUI comprehensive testing — 43 tests, fix Ctrl+K binding conflict
- `6ca2b52` member list, profile card, theme toggle, responsive — 19 tests
- `b56d71f` verify all 12 user story tests passing after message rendering fix
- `97cd8d0` final test run — 746 tests pass, vite build clean
- `e296176` Svelte 5 reactivity fix confirmed with Playwright + full test suite

## Performance (4 commits)
- `2c4dd30` replace O(n) array spread with self-assignment for reaction reactivity
- `4d55bbd` IntersectionObserver O(1), timer cleanup
- `16341c9` only observe new message elements in ChatView IntersectionObserver
- `526f680` cap messages array at 5000 to prevent unbounded memory growth

## Visual Polish (10 commits)
- `0717083` LinkPreview with favicon, image placeholder, hover effects, themes
- `a1c6bce` ReadReceipt with animated checks, hover tooltip, theme support
- `a86365e` DateSeparator with gradient lines and ember glow
- `ea02d85` scroll-to-bottom entrance animation, toast progress bar, smoother scroll fade
- `2d7238a` improved connection status with retry info and animated indicators
- `f939293` improved empty states for chat view and search panel
- `cccd1f8` TUI visual styling with Carbon Ember palette refinements
- `24a157e` CodeBlock theme-independence + visual regression screenshots
- `93ed29e` smooth focus transitions and visual polish
- `6201a60` utilities: formatRelativeTime, truncateText, sanitizeHtml, parseMentions

## Cleanup/Refactor (10 commits)
- `8f85db0` move dead-code mqtt-store-v2 to _alt/ directory
- `f96961e` remove unused imports and dead code from Python source files
- `2d74b37` move misplaced import to top of EmojiPicker script block
- `a0a7842` code quality consolidation in mcp_tools.py
- `0fa714f` remove debug test message and console.debug logging
- `0445fe8` remove another debug seed message injected by agent
- `7cd67ba` broaden test-results gitignore, remove Playwright leftovers
- `f3d0e05` placeholder fixes (medium priority)
- `1396ff6` commit remaining in-flight agent artifacts
- `3208518` final screenshot gallery complete (12/12)

## Security (2 commits)
- `8156b37` patch XSS in search highlight + restrict CORS to web UI origin
- `2620956` security audit of XSS, auth, CORS, injection, path traversal

## CI/Infra (5 commits)
- `b1463b0` all 109 ruff lint errors fixed, CI passes clean
- `f0d782b` make lint job blocking now that all ruff errors are fixed
- `dc38873` Docker verification
- `df735c0` make lint job non-blocking until codebase ruff issues resolved
- `eb315c7` CI workflow verified

## Documentation (20 commits)
- `44621e6` screenshot gallery added to README
- `7d57c41` CONTRIBUTING.md with dev setup, style guides, testing, gotchas
- `1640baf` JSDoc comments for remaining 8 Svelte components
- `0b2ad6a` web app performance audit doc
- `2620956` security audit doc
- `164f6fc` README and CHANGELOG for Sprint 2 completion
- `d889d54` overnight morning report — 647 tests pass
- `5d1c16d` integration verification worklog for Web+TUI+MCP coexistence
- `6585f54` broker resilience + message history API docs
- `bebd6b8` README and CHANGELOG with late overnight progress
- Plus ~10 overnight status/progress checkpoint commits

## Overnight Status Checkpoints (~46 commits)
- Periodic `overnight:` prefixed commits tracking agent progress
- These are incremental status updates, not code changes

---

## Key Highlights for Phil

1. **Svelte 5 Reactivity Root Cause Found + Fixed** — `ConnectionStatus` had an `$effect` infinite loop. All 746 tests pass after fix.
2. **Security** — XSS vulnerability patched in search highlight, CORS locked down to web UI origin only.
3. **Performance** — IntersectionObserver optimized to O(1), message array capped at 5000, timer cleanup.
4. **Test Coverage** — Grew from ~464 to **746 tests**, all passing. Nine rounds of web UI testing completed.
5. **TUI Improvements** — Status bar, enhanced channel list, presence filtering, visual polish.
6. **REST API** — Message history endpoint added, participants API enriched with client/status fields.
7. **CI** — All 109 ruff lint errors fixed, lint job now blocking in CI.
8. **Sprint 2 Complete** — All dead buttons wired, Lucide icons, bits-ui components.
