# Contributing to Claude Comms

Thanks for your interest in Claude Comms. This guide covers everything you need to get a development environment running, understand the codebase, and submit changes.

---

## Getting Started

### Prerequisites

- Python 3.10+
- Node.js 18+ (for the web UI)
- Git

### Clone and install

```bash
git clone https://github.com/Aztec03hub/claude-comms.git
cd claude-comms

# Python dependencies (editable install with dev extras)
pip install -e ".[all,dev]"

# Web UI dependencies
cd web
npm install
cd ..
```

### Run the tests

```bash
# Python tests (746+ tests, runs in < 1s)
pytest

# Web UI dev server
cd web && npx vite --port 5173

# Playwright end-to-end tests (requires dev server running)
cd web && npx playwright test
```

---

## Project Structure

```
claude-comms/
├── src/claude_comms/          # Python package
│   ├── broker.py              # Embedded amqtt MQTT broker
│   ├── cli.py                 # Typer CLI application
│   ├── config.py              # Config loading (YAML)
│   ├── mcp_server.py          # MCP HTTP server
│   ├── mcp_tools.py           # 9 comms_* tool implementations
│   ├── message.py             # Message model (Pydantic)
│   ├── mention.py             # @mention parsing and routing
│   ├── participant.py         # Presence tracking
│   ├── log_exporter.py        # .log + .jsonl file writer
│   ├── hook_installer.py      # PostToolUse hook setup
│   ├── notification_hook.sh   # Shell hook script
│   └── tui/                   # Textual terminal UI
├── tests/                     # Python test suite (pytest)
├── web/                       # Svelte 5 web client
│   ├── src/
│   │   ├── App.svelte         # Root app component
│   │   ├── components/        # 30+ Svelte components
│   │   └── lib/               # Stores, utilities
│   │       ├── mqtt-store-v2.svelte.js  # MQTT state (Svelte 5 runes)
│   │       ├── notifications.svelte.js  # Notification store
│   │       └── utils.js                 # Shared helpers
│   ├── e2e/                   # Playwright test suites (30 files)
│   ├── vite.config.js
│   └── playwright.config.js
├── pyproject.toml             # Python build config (hatchling)
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## Development Workflow

1. **Branch** from `main` with a descriptive name (`fix/phantom-participants`, `feat/message-search`).
2. **Code** your changes, following the style guidelines below.
3. **Test** -- run both Python and Playwright tests before committing.
4. **Commit** with a concise message describing the *why*, not the *what*.
5. **Push** and open a pull request against `main`.

---

## Code Style

### Python

- **Linting and formatting:** [ruff](https://docs.astral.sh/ruff/) for both lint and format.
- **Type checking:** [pyright](https://github.com/microsoft/pyright) for static type analysis.
- **Models:** Pydantic v2 for data models (`message.py`, `participant.py`, `config.py`).
- **Async:** Use `asyncio` throughout the broker, MCP server, and log exporter.

```bash
ruff check src/ tests/
ruff format src/ tests/
```

### Svelte / Web UI

- **Svelte 5 runes** -- use `$state`, `$derived`, `$effect`, not legacy stores. Stores use the `.svelte.js` extension.
- **Overlays** (modals, context menus, popovers) -- use [bits-ui](https://www.bits-ui.com/) components.
- **Icons** -- use [Lucide](https://lucide.dev/) icons via `lucide-svelte`. Do not use inline SVGs.
- **JSDoc** -- add JSDoc comments on all components describing their purpose, props, and events.
- **CSS** -- Tailwind utility classes. The design system is "Carbon Ember" (dark backgrounds, warm ember/amber accents).

---

## Testing

### Python (pytest)

The test suite has **746+ tests** covering the broker, CLI, config, MCP tools, messages, mentions, participants, log exporter, hook installer, TUI, and API endpoints.

```bash
# Run all tests
pytest

# Run a specific test file
pytest tests/test_mcp_tools.py

# Run with verbose output
pytest -v
```

Tests use `pytest-asyncio` for async test cases. Always run the full suite before committing.

### Web UI (Playwright)

End-to-end tests live in `web/e2e/` and cover sidebar interactions, chat, panels, modals, context menus, emoji picker, keyboard navigation, theming, responsive layouts, and more.

```bash
cd web

# Run all Playwright tests
npx playwright test

# Run a specific suite
npx playwright test e2e/chat.spec.js

# Run with headed browser for debugging
npx playwright test --headed
```

See `.testing-context.md` for the full `data-testid` inventory, test template, and known infrastructure issues.

---

## Bundle size

CI enforces these gzipped ceilings on web bundle chunks. The check lives at `web/scripts/check-bundle-size.mjs` and runs after every `npm run build:check`:

| Chunk             | Ceiling (gzipped) |
|-------------------|-------------------|
| `vendor-markdown` | 130 KB            |
| `vendor-diff`     | 25 KB             |
| `index`           | 180 KB            |

Run locally:

```bash
cd web
npm run build:check      # build + bundle-size check
# or separately
npm run build
npm run check:bundle-size
```

A failing check exits non-zero and prints which chunk(s) exceeded.

### Fallback ladder

If `vendor-markdown` exceeds its ceiling, apply this ladder (documented in the plan at §"Version pinning & CI size check"):

1. **Drop eager-loaded Shiki langs one at a time**, starting with the least-used. Order: `python`, then `json`, then `bash`. Move the dropped lang to a dynamic `import()` inside the `markedHighlight()` `highlight` callback in `src/lib/markdown.js`, so it only loads when a code fence with that language is actually encountered.
2. **Drop `typescript` or `javascript`** if truly necessary. Chat UX would suffer — consider this a last resort before (3).
3. **Swap Shiki for `highlight.js` common bundle** (~40 KB gzipped) and accept reduced theme fidelity. Set the runtime fallback flag `web.use_legacy_codeblock_highlighter: true` in config so operators can opt in without redeploying.

Raising a ceiling requires explicit review. Document the rationale in the PR description and link to the measurement output.

### Related kill switches

If the Shiki pipeline breaks in production, `getHighlighter()` in `src/lib/markdown.js` already falls back to escaped plain text automatically — no outage, just no colors. The `web.use_legacy_codeblock_highlighter` flag exists as a harder revert path. For markdown rendering problems that DOMPurify config changes cannot resolve, the escape hatch `web.markdown_render_enabled: false` causes `renderMarkdown()` to return escaped plain text (users see raw markdown source).

CI gate override: in rare hotfix cases where the ship-critical work is orthogonal to bundle size, the check can be overridden by including an `allow-oversized-bundle` git-commit-trailer on the merge commit. Use sparingly and document why.

---

## Component Conventions

### data-testid attributes

Every interactive element in the web UI must have a `data-testid` attribute. This is how Playwright tests locate elements without coupling to CSS classes or DOM structure.

- Static IDs: `data-testid="message-input"`, `data-testid="send-button"`
- Dynamic IDs: `data-testid="channel-item-{channel.id}"`, `data-testid="message-{message.id}"`

See `.testing-context.md` section 2 for the complete inventory.

### Overlay components

Use **bits-ui** for all overlay UI:
- Modals -- `ChannelModal.svelte`, `ConfirmDialog.svelte`
- Context menus -- `ContextMenu.svelte`
- Popovers -- `EmojiPicker.svelte`, `MentionDropdown.svelte`

### Icons

Use **Lucide** icons exclusively (`lucide-svelte`). Do not add inline `<svg>` elements.

### Color palette

The design follows the **Carbon Ember** palette:
- Dark backgrounds with warm ember/amber accents
- Light theme variant available via `ThemeToggle.svelte`
- All theme colors defined in Tailwind config

---

## Known Gotchas

### mqtt.js blocks the event loop in Playwright

The mqtt.js library's WebSocket reconnection cycle (every ~3 seconds) blocks the browser event loop, causing Playwright's `page.click()`, `page.fill()`, and `page.evaluate()` to hang indefinitely. **Always use the WebSocket mock** in test setup via `page.addInitScript()` before `page.goto()`. See `.testing-context.md` Issue A for the full mock implementation.

### ConnectionStatus $effect must use untrack()

The `ConnectionStatus` component has a `$effect` that reads and writes the same reactive state. Without `untrack()` on the self-referencing read, this creates an infinite reactivity loop. If you modify `ConnectionStatus.svelte`, verify that `untrack()` wraps any state reads that the same effect also writes to.

### Async MQTT callbacks may need flushSync()

When MQTT message callbacks update Svelte state, the DOM may not reflect changes immediately because MQTT callbacks run outside Svelte's reactivity microtask. If you see stale DOM in tests after an MQTT-driven state change, wrap the state update in `flushSync()` from `svelte` to force synchronous DOM reconciliation.

### WSL2 slow page loads

Vite dev server under WSL2 can have intermittent slow page loads (10-40 seconds). Playwright tests use extended timeouts (60 seconds per test) and `waitUntil: 'domcontentloaded'` to mitigate this. See `.testing-context.md` Issue B.

### Port allocation

Multiple dev servers or concurrent test agents must use separate ports:
- `5173` -- Vite default (manual dev)
- `5175` -- Playwright config default
- `6001-6010` -- Agent-assigned (one per concurrent agent)

---

## License

Claude Comms is [MIT licensed](https://opensource.org/licenses/MIT). By contributing, you agree that your contributions will be licensed under the same terms.
