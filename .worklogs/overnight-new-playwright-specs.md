# New Playwright E2E Specs

**Date:** 2026-03-30
**Task:** Identify untested components and write new E2E specs for the 3 most important gaps

## Analysis

Reviewed `.testing-context-audit.md` (85 interactive elements, ~180 existing tests across 28 spec files) to identify Sprint 2 features lacking dedicated E2E coverage.

### Top 3 Untested Areas Identified

1. **SettingsPanel** -- Added in Sprint 2 (batch 3a), wired to header button and sidebar user settings button, but NO dedicated spec. Contains profile editing, notification toggles, appearance toggle, and connection info.

2. **SearchPanel Filters** -- Filter pills (All/Messages/Files/Code/Links) were wired up during Sprint 2 but listed as "NO test". Search result rendering and highlight matching also untested.

3. **ThreadPanel Interactions** -- Reply input, Enter-to-send, Shift+Enter, send button, and empty-input rejection all listed as "NO" in the audit. Only indirect close test existed.

## New Spec Files Created

### 1. `web/e2e/settings-panel.spec.js` (10 tests)
- Header settings button opens panel
- Close button dismisses panel
- Escape key closes panel
- Toggle button opens/closes panel
- Profile section shows display name input
- Editing display name updates value + persists to localStorage
- Max length enforcement (50 chars)
- Notification toggles present (role="switch")
- In-app toasts toggle changes aria-checked state
- Dark mode toggle updates document theme attribute

### 2. `web/e2e/search-filters.spec.js` (10 tests)
- All 5 filter pills rendered
- All filter active by default
- Clicking filter pill activates it, deactivates others
- Switching between filters updates active state
- Empty search shows initial prompt state
- Nonexistent query shows no-results state
- Searching after sending messages returns results
- Search highlights matching text with mark tags
- Messages filter excludes code block messages
- Clearing search input returns to initial state

### 3. `web/e2e/thread-panel.spec.js` (10 tests)
- Reply context menu action opens thread panel
- Thread panel shows parent message body
- Reply input and send button present
- Typing in reply input updates value
- Enter key sends reply and clears input
- Shift+Enter does NOT send
- Send button click sends reply and clears input
- Close button dismisses thread panel
- Escape closes thread panel
- Empty reply input does not send on Enter

## Technical Notes

- All specs use the WebSocket mock from `.testing-context.md` to prevent MQTT blocking
- All specs use CDP `Runtime.evaluate` for fast DOM evaluation (avoids MQTT event loop issue)
- Google Fonts are blocked to prevent screenshot/font-loading hangs
- Thread panel tests use Playwright's native right-click for real `contextmenu` events (Issue G)
- 60s timeout per test with 30s navigation timeout for WSL2 slow loads
