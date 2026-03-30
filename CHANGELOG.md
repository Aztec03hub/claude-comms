# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Final Overnight Summary (2026-03-30)

- **818 Python tests** (up from 360) -- TUI +20, CLI +31, MCP server +20, plus hundreds of gap/integration tests across all modules
- **Security fixes** -- XSS vulnerability patched in SearchPanel (unsanitized HTML injection); CORS lockdown applied to REST API endpoints
- **Performance audit complete** -- All 8 audit findings addressed: IntersectionObserver O(1) optimization, `$effect` timer cleanup, message cap (5000), reaction array spread replaced with O(1) self-assignment, 3-chunk Vite build split
- **CONTRIBUTING.md created** -- Developer onboarding guide with setup, testing, architecture, and contribution workflow
- **Coverage report** -- 68% overall (core modules 95-100%); coverage report committed to repo
- **30 Svelte components documented** -- JSDoc annotations on all public props, events, and exported functions
- **Dead code cleanup** -- mqtt-store-v2 and other unused modules moved to `_alt/` directory
- **CI lint gate** -- Lint job now properly blocks builds; 109 ruff errors fixed across `src/` and `tests/`
- **pyright 0 type errors** -- Full type checking passes clean across the Python codebase
- **README badges added** -- Test count, coverage, pyright, ruff, and license badges

### Added

### Fixed

- **Svelte 5 reactivity in class stores -- RESOLVED** -- `$derived` state inside the `MqttStore` class was not triggering component re-renders (e.g., message list, participant list). Root cause: Svelte 5 runes (`$state`, `$derived`) must live in `.svelte.js` files to be compiled as reactive. The store was in a plain `.js` file, so runes were treated as normal variables. Fix: renamed `mqtt-store.js` to `mqtt-store.svelte.js`, which enables the Svelte compiler to process runes correctly. A module-level alternative (`mqtt-store-v2.svelte.js`) also exists for future use if the class-based pattern needs revisiting.

### Known Issues

- **TCP-to-WebSocket message bridging** -- amqtt does not bridge messages between its TCP (:1883) and WebSocket (:9001) listeners. Clients on different transports cannot see each other's messages. All clients should use the same transport (WS recommended for web+TUI interop).

#### Overnight (2026-03-30 final): Lint Cleanup, Docker Config, TUI Polish, API Tests

- **109 ruff lint errors fixed** -- All `ruff check` and `ruff format` issues resolved across `src/` and `tests/`. CI lint job now passes clean.
- **CI workflow lint job gates properly** -- Lint job no longer set to `continue-on-error`; it now fails the build on lint violations as intended.
- **Web UI host configurable for Docker** -- Web server bind address now reads from `config.yaml` (`web.host`), defaulting to `0.0.0.0` in Docker containers for proper container accessibility.
- **TUI typing indicators + LWT** -- Typing indicator re-trigger bug fixed on send; Last Will and Testament publishes to global `system/participants/{key}` topic for cross-channel offline detection.
- **25 API endpoint tests** -- New test coverage for REST API endpoints (message history, identity, participants).
- **818 Python tests passing** (up from 714) -- 104 new tests across TUI, CLI, and MCP server modules.
- **174 total commits** for the overnight build session.

#### Overnight (2026-03-30 late): Presence REST API, Build Optimization, Cross-Browser Diagnostics

- **Presence REST API** (`/api/participants/{channel}`) -- New REST endpoint returns the participant list for a given channel, including `client` (web/tui/mcp) and `status` (online/offline) fields. Enables external tooling and health checks to query channel membership without an MQTT subscription.
- **Build optimization: 3-chunk split** -- Vite `manualChunks` config splits the JS bundle into `vendor-mqtt` (mqtt.js), `vendor-ui` (bits-ui + lucide-svelte), and the app chunk. Eliminates the 500KB chunk size warning from production builds.
- **Stale presence filtering** -- Both TUI and Web UI now filter out stale/offline presence entries from the participant list, fixing phantom participants that accumulated from retained MQTT messages of disconnected clients.
- **Cross-browser integration test diagnostics** -- Documented TCP-to-WebSocket bridging gap: the MQTT broker exposes TCP (:1883) and WS (:9001) as separate listeners, but amqtt does not bridge messages between transport types. All clients using the same transport (e.g., all WS) see each other's messages; cross-transport requires protocol bridging not yet implemented.

#### Overnight (2026-03-30): Test Expansion, REST API, Broker Resilience, UI Polish

- **746 Python tests** (up from 647) -- 36 expanded gap tests across broker, log exporter, MCP tools, notification hook, and CLI modules, plus 32 new tests in the final session
- **REST API for message history** (`/api/messages/{conversation}`) -- Web UI now persists messages on page refresh via new REST endpoints backed by the MQTT message store
- **Unified identity endpoint** (`/api/identity`) -- Single REST endpoint returns the daemon's configured identity (name, key, type, client), used by Web UI and TUI to display consistent identity info
- **MCP `comms_join` publishes MQTT presence** -- Joining a conversation now publishes a retained presence message to `system/participants/{key}`, making MCP-connected agents visible to TUI and Web UI clients
- **Client type display** -- Participants show their client type in the UI: "Phil (web)", "Phil (tui)", "claude-orchestrator (mcp)". Client field included in presence messages for all connection types.
- **Broker crash resilience** -- Daemon handles amqtt broker crashes on WebSocket disconnect gracefully with a retry loop instead of terminating the entire process
- **Connection banner auto-hide + dismiss** -- Connection status banner auto-hides after successful connect; dismiss button added for manual close
- **Mobile hamburger menu** -- Responsive navigation menu for narrow viewports
- **Emoji picker enlarged** -- Picker sizing increased for better usability; reaction badges improved with better visibility
- **Full code cleanup** -- Removed unused imports and dead code from both Python source files and Svelte components; moved misplaced import to top of EmojiPicker script block
- **12 user story E2E tests** (2 rounds) -- Comprehensive end-to-end user story coverage across Web UI flows
- **~981 total tests** -- 746 Python tests + 235 Playwright E2E tests across 25 spec files
- **Debug cleanup passes** -- Removed debug seed messages and console.debug logging injected by agents
- **14,076 lines of source code** / **8,768 lines of test code** -- 98+ commits overnight across 121 files changed

#### Overnight (2026-03-29 final): Critical Daemon Fix + Feature Completion

- **MCP server + Web UI now actually start** -- The daemon's `claude-comms start` command previously only printed "MCP server ready" and "Web UI available" as placeholder messages without launching either server. Now the daemon starts the MCP server (uvicorn + FastMCP on `:9920`) and the web UI static file server (Starlette on `:9921`) as async tasks alongside the broker. Graceful shutdown added for both servers. **(Placeholder audit #1 and #2 -- CRITICAL fix)**
- **UserProfileView component** (`web/src/components/UserProfileView.svelte`) -- Slide-out panel for viewing other participants' info (avatar, name, handle, role badge, type, key, status). "View Profile" on someone's ProfileCard now shows their profile instead of opening your own Settings. Own profile still opens SettingsPanel. Added to Escape priority chain.
- **7 user story E2E tests** (`web/e2e/user-stories.spec.js`) -- End-to-end flows: new user first experience, team discussion with threads, channel management, message reactions/interactions, search/navigation, customization/settings, mobile user at 480px viewport. All 7 passing with 26 screenshots.
- **Placeholder audit completed** -- 25 items identified across Python backend and Svelte frontend; high-priority items (#1 MCP server, #2 web UI, #4 forward, #6 search filters, #7 sidebar search, #8 settings name persist) now resolved
- **Sidebar channel search** -- Sidebar search input now filters starred and unstarred channels by case-insensitive name match using `$derived` reactive state **(Placeholder audit #7)**
- **Search panel filter tabs wired** -- All/Messages/Files/Code/Links tabs now actively filter results: URL regex for links, triple-backtick detection for code, attachment markers for files. Clicking a tab re-runs the search immediately **(Placeholder audit #6)**
- **ForwardPicker component** (`web/src/components/ForwardPicker.svelte`) -- Modal overlay listing all channels except current; forwards via `store.forwardMessage()` with confirmation toast. Replaces the "Forwarding coming soon" clipboard stub **(Placeholder audit #4)**
- **Settings name persistence** -- Display name changes in SettingsPanel now persist to localStorage, surviving page reloads **(Placeholder audit #8)**
- **Component polish** -- DateSeparator (gradient lines, ember glow, hover effect), ReadReceipt (animated staggered check marks, hover tooltip with reader names, theme support), LinkPreview (favicon via Google S2, image thumbnail, hover elevation, proper `<a>` element)
- **Store improvements** -- JSDoc on all public methods, `messageCount` derived state, `getChannelById()` and `getParticipantByKey()` helpers, improved MQTT error messages (ECONNREFUSED shows broker URL, WebSocket-specific errors, offline/reconnect messages)
- **Utils improvements** -- `formatRelativeTime()` for human-readable timestamps, `sanitizeHtml()` for safe rendering, `truncateText()` with word-boundary awareness, improved `parseMentions()` edge case handling
- **Notification sound toggle** -- Web Audio API beep (880Hz sine, 300ms decay) gated by `soundEnabled` state, `toggleSound()` export, click-to-focus on notification click, channel name prefix in notification body
- **Profile card buttons functional** -- "Message" button pre-fills `@name` in input; "View Profile" opens UserProfileView for other users or SettingsPanel for self

### Fixed

#### Overnight (2026-03-30 late)

- **TUI phantom participants** -- TUI participant list showed stale/offline entries from retained MQTT presence. Now filters the same way as the Web UI.
- **Presence API missing fields** -- `/api/participants/{channel}` initially returned only name/key; added `client` and `status` fields for full participant metadata.

#### Overnight (2026-03-30)

- **MCP presence not published on join** -- `comms_join` tool did not publish an MQTT retained presence message, making MCP-connected agents invisible to TUI/Web UI participant lists. Now publishes to `system/participants/{key}`.
- **Broker crash on WS disconnect** -- amqtt broker could crash the entire daemon process when a WebSocket client disconnected ungracefully. Added exception handling to keep the daemon running.
- **Svelte 5 reactivity for historical messages** -- Deferred `fetchHistory` state update so Svelte 5 reactivity correctly renders messages loaded from the REST API on page refresh.
- **Svelte cleanup** -- Removed unused imports and dead code; fixed misplaced import in EmojiPicker component.
- **Debug artifacts removed** -- Cleaned up debug seed messages and `console.debug` logging left by overnight agents.
- **Own presence overwrite** -- Skip own presence messages to prevent offline status from overwriting online status during reconnection.

#### Overnight (2026-03-29 final)

- **View Profile showed own settings** -- Clicking "View Profile" on any user's ProfileCard always opened the SettingsPanel. Now correctly shows the target user's profile via UserProfileView.
- **ForwardPicker Svelte 5 syntax** -- Used Svelte 4 event modifier syntax (`onmousedown|stopPropagation`) which broke the build. Fixed to Svelte 5 pattern.

#### Overnight: Comprehensive Test Expansion (668+ total tests, up from 661+)

- **504 Python tests** (up from 360) -- 113 new MQTT integration tests across 5 rounds: broker lifecycle (31), MCP tools logic (43), log exporter (24), CLI commands (19), gap coverage for error handling and edge cases (27)
- **19 new CLI tests** (`tests/test_cli.py`) -- init config creation, name options, key generation, force overwrite, status commands, env var overrides, deep merge
- **43 new TUI tests** (`tests/test_tui.py`) using Textual's `app.run_test()` with `Pilot` -- app rendering, channel switching, message sending, keyboard shortcuts (Ctrl+Q/N/K), edge cases (long messages, unicode, code blocks, @mention tab completion, unread badges, presence updates)
- **60 new comprehensive web E2E tests** (`web/e2e/overnight-comprehensive.spec.js`) -- 9 rounds covering sidebar, header, input, messages, panels, modals, member list, theme/responsive, keyboard
- **19 new members/theme/responsive tests** (`web/e2e/overnight-members-theme.spec.js`) -- member list, profile card (7 tests), theme toggle (3 tests), responsive layout at 5 viewpoints (5 tests)
- **10 new accessibility Playwright tests** (`web/e2e/a11y-keyboard.spec.js`) -- Tab focus movement, focus-visible rings, Enter activation, Escape handling, ARIA roles verification, sr-only class verification

#### Overnight: Accessibility Overhaul

- **ARIA roles added to 21 components** -- `role="log"` on ChatView, `role="article"` on MessageBubble, `role="toolbar"` on MessageActions, `role="search"` on SearchPanel, `role="complementary"` on PinnedPanel/ThreadPanel/SettingsPanel, `role="status"`/`role="alert"` on ConnectionStatus, `role="alert"` on NotificationToast, `role="separator"` on DateSeparator, `role="presentation"` on backdrops, `aria-modal`/`aria-label` on dialogs
- **All 7 svelte-ignore a11y suppressions removed** -- replaced with proper semantic roles and keyboard handlers (FileAttachment, MessageBubble, PinnedPanel, EmojiPicker, ProfileCard x2, SearchPanel)
- **`.sr-only` utility class** added to `app.css` for screen reader labels on emoji search, search input, and thread reply input
- **`aria-hidden="true"`** on decorative elements: DateSeparator SVGs, ReadReceipt SVGs, ConnectionStatus dots, ReactionBar emoji spans
- **`aria-label` on all icon-only buttons** -- ThemeToggle, ScrollToBottom, CodeBlock copy, ReactionBar buttons with emoji name + count, Avatar with profile name
- **`aria-pressed` state** on ReactionBar toggle buttons
- **Enhanced `focus-visible` CSS rules** -- 2px outline + box-shadow on buttons, inputs, textareas, and ARIA interactive roles

#### Overnight: TUI Improvements

- **12 sender colors** -- expanded from 8 to 12 (ember, gold, teal, rose, emerald, sky, violet, pink, bright amber, light blue, purple, green)
- **Sender type icons** -- robot emoji for Claude, person emoji for human
- **Channel message previews** -- last message preview under each channel name (sender: text, truncated to 22 chars) with `set_channel_preview()` API
- **Muted channel indicator** -- bell-off emoji with `--muted` CSS class and `set_channel_muted()` API
- **Unread badges** -- inline count display in channel header row
- **New `StatusBar` widget** (`tui/status_bar.py`) -- connection state (green/red dot), active channel with `#` prefix, participant count, typing indicators ("pencil username is typing..." in amber italic), current user identity
- **@mention highlighting** in amber/gold throughout message text
- **Warmer Carbon Ember styling** -- ember-tinted borders (`#2a2017`), updated sidebar backgrounds (`#1a1a1c`), themed Footer key hints, 1px scrollbar

#### Overnight: Web UI Polish

- **Improved empty states** -- ChatView shows MessageSquare icon with pulsing double-ring animation; SearchPanel shows contextual empty states for before-search and no-results
- **Improved connection states** -- animated bouncing dots during connecting, retry countdown with RefreshCw icon during disconnect, spinning reconnect indicator
- **Tooltips added** to SearchPanel close/filters, NotificationToast dismiss, FileAttachment download, DateSeparator (full date), LinkPreview, ReadReceipt
- **ScrollToBottom entrance animation** -- spring slide-up, hover bounce, badge animation
- **Toast progress bar** -- amber gradient countdown bar for auto-dismiss timing
- **CodeBlock theme-independence** -- visual regression fix ensuring code blocks render correctly across themes

#### Sprint 2: bits-ui Component Migration (Batch 1)

- **ContextMenu -> bits-ui ContextMenu** -- `ContextMenu.Root`/`Content`/`Item`/`Separator` with controlled open state, Floating UI viewport-aware positioning (replaces manual clamping), arrow key navigation between items, Enter/Space activation, Escape/click-outside dismiss via bits-ui layers, `data-highlighted` keyboard focus state
- **ChannelModal -> bits-ui Dialog** -- `Dialog.Root`/`Portal`/`Overlay`/`Content`/`Title`/`Close` with focus trap, `role="dialog"`, `aria-labelledby` auto-wiring, portal rendering into document body, Escape and backdrop dismiss handled natively
- **EmojiPicker -> bits-ui Popover** -- `Popover.Root`/`Content` with click-outside dismiss, `onOpenAutoFocus` for search input auto-focus, controlled `open` prop for parent state management
- **ProfileCard -> bits-ui Popover** -- `Popover.Root`/`Content` replacing manual backdrop div, click-outside and Escape dismiss via bits-ui layers, removed a11y suppression comments
- **MentionDropdown -> bits-ui Combobox** -- `Combobox.Root`/`Input`/`ContentStatic`/`Item` providing `role="listbox"`/`role="option"`, `aria-selected`, `aria-activedescendant`, `data-highlighted`, hidden input for keyboard event ownership (replaces manual keydown handler and index tracking)

#### Sprint 2: Lucide Icon Migration (Batch 2)

- **~37 inline SVGs replaced with lucide-svelte imports** across 15 components -- tree-shakeable, consistent sizing via `size` prop
- **App.svelte**: `Users`, `Search`, `Pin`, `Settings`
- **ThemeToggle.svelte**: `Sun`, `Moon`
- **Sidebar.svelte**: `Hash`, `VolumeX`, `Plus`, `Settings`
- **MemberList.svelte**: `Search`
- **MessageInput.svelte**: `Type`, `Code`, `Paperclip`, `Smile`, `SendHorizontal`
- **MessageActions.svelte**: `Reply`, `Smile`, `Ellipsis`
- **ScrollToBottom.svelte**: `ChevronDown`
- **ContextMenu.svelte**: `Reply`, `Forward`, `Pin`, `Copy`, `Smile`, `MailOpen`, `Trash2`
- **ProfileCard.svelte**: `Star`
- **PinnedPanel.svelte**: `Pin`, `X`
- **SearchPanel.svelte**: `X`
- **ThreadPanel.svelte**: `MessageSquare`, `Send`, `X`
- **CodeBlock.svelte**: `Copy`, `Check`
- **FileAttachment.svelte**: `File`, `Download`

#### Sprint 2: Dead Buttons Wired (Batch 3)

- **SettingsPanel** (new component) -- slide-out panel with profile editing, notification toggles, appearance section, connection status; wired to header settings button and Sidebar gear button
- **Member list toggle** -- header member count pill toggles `MemberList` visibility via `showMemberList` state
- **Member search** -- search input in MemberList filters online/offline members by name with `$derived` reactive filtering
- **Attach file button** -- hidden file input triggered by attach button; shows "File sharing coming soon" notice
- **Format help button** -- toggles Markdown formatting reference popover (`**bold** *italic* \`code\``)
- **Code snippet insertion** -- inserts fenced code block template at cursor position in message input
- **Context menu Forward action** -- copies message body to clipboard with toast notification
- **Context menu Mark Unread action** -- calls `store.markUnread(message)` setting `unreadFrom` cursor
- **Context menu Delete action** -- opens ConfirmDialog (new bits-ui Dialog component) for confirmation, then calls `store.deleteMessage(messageId)`
- **ConfirmDialog** (new component) -- reusable confirmation dialog using bits-ui Dialog, with danger styling option
- **Channel mute toggle** -- mute buttons on sidebar channels call `store.muteChannel(channelId)`, visual `.muted` class with reduced opacity, VolumeX icon indicator
- **File download handler** -- FileAttachment download button triggers programmatic `<a>` download with `url` prop
- **More button -> context menu** -- MessageActions More button opens context menu at button position via `onMore` -> `onContextMenu`
- **Store methods added**: `markUnread()`, `deleteMessage()`, `muteChannel()`, `forwardMessage()` in `mqtt-store.svelte.js`

#### New Dependencies

- **bits-ui** -- headless Svelte 5 UI primitives (ContextMenu, Dialog, Popover, Combobox) for accessibility, keyboard nav, ARIA roles, focus trapping, floating positioning
- **lucide-svelte** -- tree-shakeable SVG icon library (1500+ icons as Svelte components)

#### Comprehensive Functional Browser Testing (10 Parallel Agents)

- **10 parallel testing agents** deployed for functional browser testing across the entire web UI -- **121+ Playwright tests** written, **12 bugs found and fixed**
- **20 Playwright E2E spec files** (`web/e2e/`) covering: messages (10 tests), emoji picker (10), channel switching (7), console smoke test (18 interactions), app loading (5), sidebar (8), chat (6), panels (11), modals (7), member list (6+11), context menu (5), console errors (3), channel modal flow (11), keyboard shortcuts (10), theme/responsive (7), user stories (7)
- **120+ test screenshots** captured across all testing areas (`mockups/test-*.png`, `mockups/screenshot-*.png`)
- **668+ total tests** across the project: 504 Python + 43 TUI + 121+ Playwright browser E2E
- **Zero JS runtime errors** confirmed across all 18 interaction types during comprehensive smoke testing
- **`playwright.config.js`** -- Headless Chromium, screenshots on failure, video on failure, 1 retry, 30s timeout, built-in web server config, CDP workaround for mqtt.js event loop blocking
- **npm test scripts** -- `test` (headless), `test:ui` (Playwright UI mode), `test:headed` (visible browser)
- **`data-testid` attributes** -- 60+ attributes added across all 18 interactive Svelte components for reliable Playwright test selectors (replaces fragile CSS class selectors). All E2E test files use `[data-testid="..."]` selectors.

#### Reaction System

- **`addReaction()` method** in `mqtt-store.svelte.js` -- creates/toggles reactions on messages with proper count tracking and active state
- **`onReact` prop threading** through `MessageBubble` -> `MessageGroup` -> `ChatView` -> `App.svelte` for full reaction callback chain
- **React button wired** in `MessageActions.svelte` -- previously had no `onclick` handler
- **`handleEmojiSelect`** in `App.svelte` now calls `store.addReaction()` instead of being a TODO

#### Defensive Programming (Python Backend)

- **6 Python modules hardened** -- `participant.py` and `message.py` validators accept `None` safely; `log_exporter.py` handles missing/malformed fields gracefully; `hook_installer.py` validates inputs and wraps file I/O in try/except; `broker.py` validates `generate_client_id()` inputs; `mcp_server.py` replaces bare `assert` with proper `RuntimeError` (asserts are stripped with `python -O`)

### Fixed

#### Overnight Bug Fixes

- **TUI Ctrl+K binding conflict** -- Textual's built-in `Input` widget binds `ctrl+k` to `delete_right_all`, intercepting the app-level Ctrl+K conversation switching shortcut. Fixed by adding `priority=True` to the binding in `app.py`.
- **Unused CSS selector** -- `.header-members svg` in App.svelte was unused because Svelte scopes CSS; changed to `.header-members :global(svg)` to pierce scoping.

#### Bugs Found by Parallel Testing Agents

- **`addReaction` method missing** -- Store had no method to add/toggle reactions on messages; emoji picker selection was a TODO that never persisted reactions
- **React button had no onclick handler** -- `MessageActions.svelte` "React" button did nothing when clicked
- **localStorage key not persisted** -- Each browser session generated a new random key via `generateKey()`, creating phantom participants that accumulated as retained MQTT presence messages. Fixed by persisting user key in localStorage.
- **Ctrl+K shortcut missing** -- No keyboard shortcut existed to open the search panel. Added global `handleGlobalKeydown` with `svelte:window onkeydown` binding for Ctrl+K / Cmd+K toggle.
- **Escape key priority ordering** -- Multiple components independently listened for Escape, causing all open panels to close simultaneously. Centralized Escape handling in `App.svelte` with priority order: modal > context menu > emoji picker > profile card > pinned panel > search panel > thread panel.
- **Focus return after closing panels** -- After pressing Escape to close a panel, focus was lost to `document.body`. Now returns focus to the message input after any Escape-triggered close.
- **ThemeToggle not wired** -- `ThemeToggle.svelte` component existed but was never imported or rendered in `App.svelte`. Wired into the chat header actions bar.
- **No light theme CSS** -- Only dark theme variables existed. Added `:root[data-theme="light"]` rule block with full light color palette and converted hardcoded backgrounds in Sidebar, MemberList, and chat header to CSS variables.
- **Mobile viewport overflow** -- At 320px and 480px viewports, content overflowed the screen width. Fixed sidebar to `display: none` at 480px, hid header elements, reduced padding, added `overflow: hidden` on layout containers.
- **Context menu viewport edge clamping** -- Context menu positioned at raw cursor coordinates without boundary clamping, rendering off-screen near viewport edges. Added `$derived` clamped coordinates constraining the menu within 8px of all edges.
- **Search panel z-index / close button unclickable** -- Search panel (`z-index: 50`) sat behind the chat header (`z-index: 101`), making its close button unreachable. Repositioned panel below the header.
- **Search input not auto-focused** -- Opening the search panel did not focus the input field. Added `onMount` handler with `bind:this` to auto-focus.
- **Header glow pseudo-element intercepting clicks** -- `.chat-header::after` glow effect could intercept pointer events. Added `pointer-events: none`.
- **Duplicate channels in sidebar** -- Starred channels appeared in both "Starred" and "Conversations" sections because conversations list rendered all channels instead of filtering out starred ones. Added `$derived` `unstarredChannels` filter.
- **Messages don't appear without MQTT broker** -- `sendMessage()` only published to MQTT with no local echo. Added immediate local store update via `#handleChatMessage()` with deduplication, and removed the broker-required guard so the UI works offline.
- **Toast notifications never auto-dismiss** -- `addToast`/`dismissToast` used in-place array mutations (`push`/`splice`) on `$state` arrays inside `setTimeout` closures, which didn't reliably trigger Svelte 5 reactivity. Switched to immutable updates (`[...arr]`/`filter()`).

#### Visual Polish and Mockup Fidelity

- **Unicode rendering** -- Fixed 4 Svelte template escape sequences rendering as literal `\uXXXX` text: `\u2318K` -> `⌘K`, `\u2605` -> `★`, `\u25BE` -> `▾` (2 instances). Replaced 25 surrogate pair unicode escapes in EmojiPicker with actual emoji characters.
- **Message bubble shadows** -- Adjusted to match R10 mockup (simplified shadow, tweaked human inset glow)
- **Consecutive bubble corners** -- Added rounded corner treatment for grouped messages
- **Chat header** -- Fixed letter-spacing, added border-bottom from spec, matched background gradient
- **Input area** -- Changed to gradient background with proper border-top per mockup
- **Scanline overlay removed** -- `.center::after` repeating-linear-gradient not in design spec
- **Mask fade reduced** -- Messages container mask-image fade from 20px to 8px to avoid obscuring content
- **Connection status banner** -- Reduced prominence when connected (lower opacity, smaller padding/font)
- **Empty state** -- Added "No messages yet" placeholder for channels with no messages
- **Mobile responsive** -- Member list hidden on narrow viewports; sidebar overlays content below 480px

#### Infrastructure Discovery: mqtt.js Event Loop Blocking

- **mqtt.js blocks browser event loop** during WebSocket reconnection cycles (~3s interval), causing Playwright's `page.click()`, `page.fill()`, and `page.evaluate()` to hang indefinitely
- **Workaround documented**: (1) WebSocket mock via `addInitScript` prevents MQTT from connecting, (2) CDP `Runtime.evaluate` bypasses Playwright's actionability wait system
- **Browser crashes under memory pressure** -- Chromium renderer processes killed after ~3s in WSL2 with low RAM when MQTT reconnection + Svelte rendering + CSS animations combine; all existing tests complete within the window

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

#### Web Client Bug Sweep

- **MQTT topic routing** -- `#handleMessage` used fragile `parts[2] === 'conv' || parts[1] === 'conv'` condition which missed `system/participants/+` topics entirely (participant registry never populated). Replaced with proper prefix-strip and direct `topicParts[0]` matching.
- **MQTT typing channel extraction** -- `#handleTyping` used `this.activeChannel` instead of extracting the channel from the MQTT topic, causing typing indicators to always appear in the viewer's active channel instead of the actual typing channel.
- **MQTT LWT topic** -- Last Will and Testament published to a channel-specific presence topic (`conv/{channel}/presence/{key}`), which only notified that single channel. Changed to `system/participants/{key}` so offline status is visible globally.
- **Sidebar onShowProfile event mismatch** -- Sidebar passed raw participant object to `onShowProfile` while App.svelte's handler expected `e.detail` wrapper. Normalized all event callback props to pass data directly (no `{ detail: ... }` wrapper) across Sidebar, MemberList, MessageBubble, ContextMenu, and EmojiPicker.
- **A11y: clickable divs/spans without keyboard handlers** -- Added `onkeydown` handlers (Enter/Space) to all interactive `div`/`span` elements: channel items (Sidebar), member items (MemberList), sender name and thread indicator (MessageBubble), user avatar (Sidebar).
- **A11y: non-semantic clickable elements** -- Converted header-members from `div` to `button` (App.svelte), section collapse arrows from `span` to `button` (Sidebar), search filter pills from `span` to `button` (SearchPanel).
- **A11y: labels without associated controls** -- Added `for`/`id` associations to Channel Name and Description labels in ChannelModal.
- **A11y: icon-only button without label** -- Added `aria-label="Send reply"` to ThreadPanel send button.
- **A11y: noninteractive tabindex on Avatar** -- Split Avatar into two branches (clickable with role/tabindex/onkeydown vs. static without) to eliminate the noninteractive tabindex warning.

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

#### Python Test Suite (360 tests, ~0.5s)
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

#### Playwright Browser E2E Tests (16 spec files, 120+ screenshots)
- **`web/e2e/messages.spec.js`** (10 tests) -- type, send, grouping, wrapping, @mentions, empty guard, alignment, timestamps, auto-scroll
- **`web/e2e/emoji-picker.spec.js`** (10 tests) -- open/close, emoji selection, reactions, category tabs, search, frequent emojis
- **`web/e2e/smoke-test-all-interactions.spec.js`** (18 interactions) -- comprehensive console error monitoring across all UI interactions
- **`web/e2e/test-members.spec.js`** (11 tests) -- avatars, presence dots, profile card positioning/closing, role badges, mobile hiding
- **`web/e2e/sidebar.spec.js`** (8 tests) -- channel list, active highlight, collapse/expand, new conversation, search, user profile
- **`web/e2e/modals.spec.js`** (7 tests) -- channel modal lifecycle, form fields, cancel, backdrop/Escape close, toggle
- **`web/e2e/chat.spec.js`** (6 tests) -- input, Enter/button send, message container, bubble display, hover actions
- **`web/e2e/panels.spec.js`** (6 tests) -- search/pinned panel open/close, toggle behavior, channel switching with panel
- **`web/e2e/member-list.spec.js`** (6 tests) -- sidebar visible, header count, sections, profile card open/contents/close
- **`web/e2e/app-loads.spec.js`** (5 tests) -- page load, 3-column layout, header, input, no console errors
- **`web/e2e/context-menu.spec.js`** (5 tests) -- right-click menu, items, close behaviors
- **`web/e2e/console-errors.spec.js`** (3 tests) -- navigate all interactions without JS errors, rapid operations
- **`web/e2e/channel-modal-flow.spec.js`** (11 tests) -- open modal, form fields, type name/description, private toggle, cancel, backdrop close, Escape close, create channel, active state, empty name validation
- **`web/e2e/keyboard.spec.js`** (10 tests) -- Ctrl+K opens search, Escape priority ordering, focus return to input, Enter/Shift+Enter, Tab navigation, focus rings, Ctrl+K while typing
- **`web/e2e/theme-responsive.spec.js`** (7 tests) -- dark/light theme toggle, 5 viewport sizes (1920-320px), resize transitions, no mobile overflow
- **`web/e2e/user-stories.spec.js`** (7 tests) -- E2E user stories: new user first experience, team discussion with threads, channel management, reactions/interactions, search/navigation, customization/settings, mobile user

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
- **668+ total tests**: 504 Python (12 test modules, ~0.5s) + 43 TUI (Textual run_test) + 121+ Playwright browser E2E (20 spec files) with **120+ test screenshots**
- **10 parallel testing agents** deployed for comprehensive functional browser testing, finding and fixing **12 bugs**
- **Zero JS runtime errors** confirmed across all interaction types
- **27 Svelte components** (26 in `components/` + `App.svelte`) with **60+ `data-testid` attributes**
- **18 Python source files** (14 modules + TUI subpackage)
- **63 agent work logs** documenting all development and testing activity
- **4 deployment targets**: pip install, Docker, docker-compose, VPS

### Known Issues

- WSL2 with Windows-mounted filesystems may not support `chmod 600` on config files (falls back to warning)
- Architecture plan example key `phil0e8a` contains non-hex characters -- all real keys use `[0-9a-f]{8}` only
- **mqtt.js event loop blocking** -- The mqtt.js library blocks the browser event loop during WebSocket reconnection, which affects Playwright testing (workaround: WebSocket mock + CDP `Runtime.evaluate`). Does not affect normal user interaction.
- **Retained presence accumulation** -- Previously, each browser session generated a new unique key. Now fixed via localStorage persistence (key survives reloads), but old phantom retained messages from prior sessions are not cleaned up. TTL-based cleanup still recommended for long-running deployments.

[0.1.0]: https://github.com/Aztec03Hub/claude-comms/releases/tag/v0.1.0
