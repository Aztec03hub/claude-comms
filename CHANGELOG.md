# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Batch 4: Docker, CI, and Integration Tests

- **`Dockerfile`** -- Multi-stage build: Stage 1 (`node:22-slim`) compiles the Svelte web UI, Stage 2 (`python:3.12-slim`) installs the Python package. Exposes ports 1883 (MQTT TCP), 9001 (MQTT WS), 9920 (MCP), 9921 (Web UI). Health check probes MQTT broker every 30s.
- **`docker-compose.yml`** -- Single-service deployment with named volume `comms-data` for persistent config/logs, `CLAUDE_COMMS_PASSWORD` env var, `restart: unless-stopped` policy.
- **`.github/workflows/ci.yml`** -- GitHub Actions CI pipeline:
  - **Lint job**: `ruff check` + `ruff format --check` on `src/` and `tests/`
  - **Test job**: Matrix across Python 3.10, 3.11, 3.12 with pip caching; uploads JUnit XML results as artifacts (30-day retention)
  - **Build Web job**: Node 22 with npm caching; builds Svelte app; uploads dist as artifact
  - Concurrency control: cancels in-progress runs for same git ref
- **Integration test suite** (`tests/test_integration.py`) -- 45 tests covering cross-module interactions: config init flow, message roundtrip, mention resolution pipeline, log exporter integration, shared deduplicator, participant registry, hook installer, and MCP tools pipeline
- **E2E test suite** (`tests/test_e2e.py`) -- 22 tests covering full system flows with a `MockBroker` simulating MQTT pub/sub: two-participant chat, targeted messaging, conversation lifecycle, presence flow, name changes, log format verification, JSONL replay, notifications, and a complete end-to-end session

#### Batch 3: TUI Client and Svelte Web Client

- **TUI Client** (`src/claude_comms/tui/`) -- Textual-based terminal chat with 3-column layout (channels, chat, participants), direct MQTT connection via aiomqtt `@work()` async worker, per-conversation message storage, deterministic sender colors (MD5 hash to Carbon Ember palette), triple-backtick code block rendering (Rich Syntax, Monokai), @mention Tab completion, unread badges, presence indicators, modal new-conversation dialog
- **Svelte 5 Web Client** (`web/`) -- 35-file Svelte 5 + Vite SPA implementing the "Obsidian Forge" design language. Svelte 5 runes (`$state`, `$derived`, `$effect`), Tailwind CSS v4 with `@theme` directive, mqtt.js direct WebSocket connection to broker. Components include: channel sidebar, message bubbles with grouping, @mention autocomplete, emoji picker, thread panel, search panel, context menu, profile cards, notification toasts, scroll-to-bottom button, file attachments, link previews, read receipts, reaction bars, date separators. All mockup animations replicated (ambient drift, brand breath, badge pulse, typing wave, send shine, etc.)

### Fixed

- **Dependency conflict resolved** -- Changed `mcp[cli]` to `mcp` (without the `[cli]` extra) and pinned `typer>=0.15.0,<0.16.0` in `pyproject.toml`. The `[cli]` extra required `typer>=0.16.0` which conflicted with `amqtt`'s pin on `typer==0.15.4`.

### Design

- **Obsidian Forge design finalized** -- Evolved from "Phantom Ember" through 17 iterative adversarial refinement rounds across 11 initial concepts. Final design language: dark as polished obsidian, warm as ember glow, alive with subtle breath. Applied to both TUI (Carbon Ember palette) and Web UI (full Obsidian Forge).

---

## [0.1.0] -- 2026-03-29

Initial release. Built across three development batches by 8 parallel Claude Code agents.

### Added

#### Core Infrastructure
- **`pyproject.toml`** -- Hatchling build system, all dependencies (`amqtt`, `aiomqtt`, `mcp`, `typer>=0.15.0,<0.16.0`, `pyyaml`, `rich`, `pydantic`), optional extras (`tui`, `web`, `all`, `dev`), entry point `claude-comms`, pytest config
- **`src/claude_comms/__init__.py`** -- Package init with `__version__ = "0.1.0"`
- **`src/claude_comms/__main__.py`** -- `python -m claude_comms` entry point

#### Configuration (`config.py`)
- YAML config management at `~/.claude-comms/config.yaml`
- `load_config()` with deep merge against defaults for forward compatibility
- `save_config()` with automatic `chmod 600` enforcement
- `get_default_config()` with `secrets.token_hex(4)` identity key generation
- Password resolution chain: `CLAUDE_COMMS_PASSWORD` env var > YAML value > warning
- WSL2 chmod fallback with warning when file permissions cannot be set

#### Message Model (`message.py`)
- Pydantic v2 `Message` model with `Sender` embedded model
- Fields: `id` (UUID4), `ts` (ISO 8601 with timezone), `sender`, `recipients`, `body`, `reply_to`, `conv`
- `Message.create()` convenience constructor with auto-generated ID and timestamp
- `to_mqtt_payload()` / `from_mqtt_payload()` JSON serialization (string and bytes)
- `topic` property generating `claude-comms/conv/{conv}/messages`
- `is_broadcast` / `is_for(key)` routing helpers
- Conversation ID validation: `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` regex, reserved names (`system`, `meta`)
- Recipient key validation: 8 lowercase hex characters

#### Participant Model (`participant.py`)
- Pydantic v2 `Participant` model with `key`, `name`, `type` fields
- Key generation via `secrets.token_hex(4)` (8 lowercase hex chars, ~4 billion combinations)
- `Participant.create()` with auto-generated key
- `with_name()` for immutable name changes (key preserved)
- MQTT serialization and `registry_topic` property

#### @Mention System (`mention.py`)
- `extract_mentions(body)` -- pulls display names from `[@name1, @name2]` prefix
- `strip_mentions(body)` -- removes prefix, returns bare text
- `build_mention_prefix(names)` -- constructs `[@name1, @name2] ` prefix
- `resolve_mentions(body, name_to_key)` -- resolves names to participant keys with deduplication

#### Embedded Broker (`broker.py`)
- **`EmbeddedBroker`** -- lifecycle wrapper around `amqtt.broker.Broker`
  - `from_config()` factory, `start()` / `stop()` async lifecycle, PID file management
  - TCP (`:1883`) and WebSocket (`:9001`) listeners
  - Config-driven auth, JSONL log replay on startup
- **`MessageDeduplicator`** -- bounded LRU seen-ID set (default 10,000 entries), thread-safe
- **`MessageStore`** -- in-memory per-conversation message history (configurable cap, default 1,000)
- **`replay_jsonl_logs()`** -- reconstructs message history from `.jsonl` files on startup
- **`generate_client_id()`** -- unique MQTT client IDs: `claude-comms-{component}-{key}-{random}`

#### Log Exporter (`log_exporter.py`)
- **`LogExporter`** class with `write_message()` and `write_presence()` methods
  - Per-conversation `.log` (human-readable) and `.jsonl` (structured) files
  - UUID-based deduplication via shared `MessageDeduplicator`
  - Conversation ID validation (prevents path traversal)
  - Automatic header generation on first write
- **`format_log_entry(msg)`** -- renders timestamped message blocks with 4-space body indent
- **`format_log_header(conv_id, ts)`** -- renders `====` separator header
- **`format_presence_event(name, key, event, ts)`** -- renders `--- name (key) joined/left ---` lines
- **Log rotation** -- numbered suffix rotation (`.1`, `.2`, ...) at configurable size
- Format modes: `"text"`, `"jsonl"`, `"both"` (default)

#### MCP Server (`mcp_server.py`)
- FastMCP server with `stateless_http=True` and `json_response=True`
- Binds to `127.0.0.1:9920` (localhost security boundary)
- MQTT subscriber background task with auto-reconnect (2s backoff)
- Separate persistent publish client for outbound messages
- JSONL log replay into `MessageStore` on startup

#### MCP Tools (`mcp_tools.py`)
- **`ParticipantRegistry`** -- thread-safe in-memory participant tracking with per-conversation membership, name-to-key index, read cursors, mixed name/key recipient resolution
- **9 tool implementations:**
  - `comms_join` -- join conversation, name-based idempotency
  - `comms_leave` -- leave conversation
  - `comms_send` -- send message with name-to-key resolution and @mention prefix
  - `comms_read` -- read messages with count/since pagination + token-aware truncation
  - `comms_check` -- unread counts across conversations
  - `comms_members` -- list conversation participants
  - `comms_conversations` -- list joined conversations with unread counts
  - `comms_update_name` -- change display name (key preserved)
  - `comms_history` -- search message history by text/sender with token truncation
- Token-aware pagination: ~4 chars/token, 80,000 char cap (~20k tokens)

#### CLI (`cli.py`)
- **`init`** -- generate identity key, create config, set permissions
- **`start`** -- start daemon (broker + MCP), foreground or `--background`, optional `--web`
- **`stop`** -- SIGTERM with 10s grace period, SIGKILL escalation, stale PID cleanup
- **`send`** -- publish message via short-lived aiomqtt client, `-c` conversation, `-t` recipient
- **`status`** -- daemon PID, broker config, MCP endpoint, web UI, identity, broker connectivity probe
- **`tui`** -- launch Textual TUI
- **`web`** -- open browser to web UI URL
- **`log`** -- `tail -f` with Python polling fallback
- **`conv list`** -- discover from log files + config
- **`conv create`** -- validate conv_id, publish retained metadata to broker
- **`conv delete`** -- confirmation prompt (skip with `--force`), clear retained metadata

#### Notification Hook (`hook_installer.py`)
- **`install_hook()`** -- generates platform-appropriate script (bash/cmd), installs to `~/.claude/hooks/`, updates `~/.claude/settings.json` with PostToolUse entry
- **`uninstall_hook()`** -- removes script file and settings.json entry
- Unix script: drain stdin, check notification file, read + truncate atomically, format messages, output JSON with `additionalContext`
- Windows script: same flow using `more > nul` and PowerShell
- Idempotent (replaces existing entries, no duplicates), 5-second timeout

#### TUI Client (`tui/`)
- **`app.py`** -- 3-column layout (channels | chat | participants), MQTT via aiomqtt `@work()`, keybindings (Ctrl+Q quit, Ctrl+N new conversation, Ctrl+K cycle), modal new-conversation dialog
- **`chat_view.py`** -- Rich Panels with deterministic sender colors (MD5 hash -> Carbon Ember palette), code block highlighting (Monokai), per-conversation message storage, client-side dedup
- **`channel_list.py`** -- conversation sidebar with active highlight and amber unread badges
- **`participant_list.py`** -- presence indicators: green (online), amber (away), gray (offline)
- **`message_input.py`** -- @mention Tab completion cycling through matching participant names
- **`styles.tcss`** -- Carbon Ember themed Textual CSS

#### Web UI (`web/`)
- Svelte 5 + Vite project scaffolding
- "Obsidian Forge" design language

#### Design Mockups (`mockups/`)
- 11 initial design concepts (A through K): Discord, Modern Light, Cyberpunk, Midnight Amethyst, Carbon Ember, Deep Ocean, Obsidian Rose, Phantom Jade, Obsidian Ember, Phantom Ember, Ember Fusion
- 17 refinement rounds on Concept J (Phantom Ember -> Obsidian Forge)
- Final interactive mockup: `concept-j-phantom-ember-v2-r10-interactive.html`

#### Test Suite (360 tests, ~0.5s)
- **`tests/conftest.py`** -- shared fixtures (registry, store, publish_spy, tmp_config)
- **`tests/test_config.py`** (21 tests) -- config path, identity key, save/load, permissions, deep merge, password resolution
- **`tests/test_message.py`** (33 tests) -- creation, JSON round-trip, validation, routing
- **`tests/test_mention.py`** (21 tests) -- extract, strip, build, resolve with edge cases
- **`tests/test_participant.py`** (26+ tests) -- key generation, validation, model, serialization
- **`tests/test_broker.py`** (50+ tests) -- deduplicator, store, JSONL replay, broker lifecycle
- **`tests/test_log_exporter.py`** (46 tests) -- formatting, rotation, dedup, conv validation
- **`tests/test_mcp_tools.py`** (42 tests) -- all 9 tools, registry, token pagination
- **`tests/test_notification_hook.py`** (45 tests) -- script generation, settings manipulation, install/uninstall
- **`tests/test_integration.py`** (45 tests) -- cross-module integration: config flow, message roundtrip, mention pipeline, log exporter, dedup, registry, hook installer, MCP tools pipeline
- **`tests/test_e2e.py`** (22 tests) -- end-to-end flows with MockBroker: two-participant chat, targeted messaging, conversation lifecycle, presence, name changes, JSONL replay, notifications

### Architecture Decisions

- **MQTT 3.1.1** via amqtt -- embedded, no external broker required
- **Stateless MCP** via FastMCP with `stateless_http=True` -- each request independent, multiple Claude Code instances share one server
- **Server-side deduplication** as primary defense against QoS 1 at-least-once redelivery
- **Localhost security boundary** for MCP server (no auth layer)
- **LWT (Last Will and Testament)** for automatic offline detection
- **Retained messages** for presence state persistence
- **Token-aware pagination** to stay within MCP 25,000-token output limit
- **Config forward compatibility** via deep merge with defaults
- **Lazy imports** throughout CLI for fast startup and graceful degradation

### Design Process

- 11 initial UI concepts explored across different aesthetic directions
- Concept J (Phantom Ember) selected as winner
- 17 iterative adversarial refinement rounds producing "Obsidian Forge" final design
- Architecture plan survived 7 adversarial review rounds before APPROVED status

### Project Stats

- **64 source files** across Python, Svelte, JS, CSS, and shell scripts
- **360 tests** across 10 test modules (unit, integration, E2E)
- **27 Svelte components** (26 in `components/` + `App.svelte`)
- **18 Python source files** (14 modules + TUI subpackage)
- **4 deployment targets**: pip install, Docker, docker-compose, VPS

### Known Issues

- WSL2 with Windows-mounted filesystems may not support `chmod 600` on config files (falls back to warning)
- Architecture plan example key `phil0e8a` contains non-hex characters -- all real keys use `[0-9a-f]{8}` only

[0.1.0]: https://github.com/Aztec03Hub/claude-comms/releases/tag/v0.1.0
