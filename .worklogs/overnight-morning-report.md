# Overnight Report — 2026-03-30

## Test Results
- **Python:** 647 passed, 0 failed, 34 warnings (14.62s)
- **Build:** PASS (4348 modules, 7.03s) — 5 a11y warnings (EmojiPicker, ProfileCard, SettingsPanel)
- **Playwright specs:** 24 spec files in `web/e2e/`
  - app-loads, chat, messages, sidebar, keyboard, emoji-picker, context-menu
  - modals, panels, member-list, channel-modal-flow, a11y-keyboard
  - visual-regression, round6-modals, round7-keyboard, round8-edge-cases, round9-visual
  - user-stories, console-errors, theme-responsive, smoke-test-all-interactions
  - overnight-comprehensive, overnight-members-theme, test-members

## Stats
- Commits tonight: 70
- Diff (last 30 commits): 121 files changed, 4813 insertions, 170 deletions
- Lines of source code: 14,076
- Lines of test code: 8,768
- Work log files: 74

## What Was Done
- **Connection banner:** auto-hide after connect, dismiss button, mobile menu polish
- **Emoji/reactions:** picker sizing fix, reaction badge visibility, reaction bar wiring
- **TUI:** 67 tests passing, status bar, enhanced channel list, Carbon Ember palette, Ctrl+K fix
- **Error handling:** verified robustness across broker, hooks, MCP tools
- **MQTT broadcast:** reactions, pins, deletions broadcast to all clients
- **Search & settings:** filter tabs wired, ForwardPicker Svelte 5 syntax fix, settings persistence
- **User profiles:** View Profile shows other users, profile card Message/View Profile buttons wired
- **Visual polish:** DateSeparator, ReadReceipt, LinkPreview, scroll-to-bottom animation, toast progress bar
- **Testing:** 9 rounds of web UI tests (comprehensive 60-test overnight suite), gap tests, CLI/MCP/broker lifecycle tests
- **Hook installer:** hook_enabled check, comprehensive hook tests
- **Component polish:** empty states, connection status with retry info, animated indicators
- **Docs:** README and CHANGELOG updated for Sprint 2 completion

## Known Issues
- Build warning: JS chunk is 794 KB (over 500 KB limit) — consider code-splitting
- 5 Svelte a11y warnings: `dialog` role missing tabindex (EmojiPicker, ProfileCard), click without keyboard handler (ProfileCard), `state_referenced_locally` (SettingsPanel x2)
- 34 pytest warnings: mostly MQTT auth password not set (expected in test environment)
- Playwright specs exist but were not executed in this run (would need a running dev server)

## Recommended Next Steps
1. **Code-split the JS bundle** — dynamic imports for heavy components (EmojiPicker, SettingsPanel, ProfileCard) to get under 500 KB
2. **Fix the 5 a11y warnings** — add tabindex to dialog-role elements, fix SettingsPanel store references
3. **Run Playwright suite** against a live dev server to validate all 24 spec files
4. **Sprint 3 planning** — Sprint 2 is complete per README/CHANGELOG; decide next priorities
5. **Consider CI pipeline** — 647 Python tests + 24 Playwright specs + build check could be automated
