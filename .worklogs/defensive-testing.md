# Defensive Programming & Test Infrastructure Work Log

**Date:** 2026-03-29
**Agent:** Claude Opus 4.6 (1M context)

## Summary

Added `data-testid` attributes to all interactive Svelte elements for reliable Playwright testing, added defensive programming improvements to the Python backend, and updated all existing Playwright E2E tests to use `data-testid` selectors instead of fragile CSS class selectors.

## Priority 1: data-testid Attributes (Svelte Components)

### Files Modified (18 Svelte files)

| Component | data-testid attributes added |
|---|---|
| **Sidebar.svelte** | `sidebar`, `sidebar-search`, `sidebar-starred-section`, `sidebar-starred-toggle`, `sidebar-conversations-section`, `sidebar-conversations-toggle`, `channel-item-{id}` (dynamic, both starred and conversations lists), `sidebar-create-channel`, `sidebar-user-profile` |
| **ChatView.svelte** | `chat-view` |
| **ScrollToBottom.svelte** | `scroll-to-bottom` |
| **MessageBubble.svelte** | `message-{message.id}` (dynamic), `message-sender-{message.sender.key}` (dynamic) |
| **MessageActions.svelte** | `message-actions`, `action-reply`, `action-react`, `action-more` |
| **MessageInput.svelte** | `message-input`, `send-button`, `input-attach`, `input-emoji`, `typing-indicator` |
| **MemberList.svelte** | `member-list`, `member-{member.key}` (dynamic, both online and offline), `members-online-section`, `members-offline-section` |
| **App.svelte** | `chat-header`, `header-channel-name`, `header-members-count`, `header-search-btn`, `header-pin-btn`, `header-settings-btn` |
| **ChannelModal.svelte** | `channel-modal`, `channel-modal-close`, `channel-modal-name-input`, `channel-modal-description`, `channel-modal-private-toggle`, `channel-modal-cancel`, `channel-modal-create` |
| **EmojiPicker.svelte** | `emoji-picker`, `emoji-search`, `emoji-category-{cat.id}` (dynamic), `emoji-item` |
| **ContextMenu.svelte** | `context-menu`, `ctx-reply`, `ctx-forward`, `ctx-pin`, `ctx-copy`, `ctx-react`, `ctx-unread`, `ctx-delete` |
| **ProfileCard.svelte** | `profile-card`, `profile-card-name`, `profile-card-close` |
| **SearchPanel.svelte** | `search-panel`, `search-panel-close`, `search-panel-input`, `search-filter-{name}` (dynamic) |
| **PinnedPanel.svelte** | `pinned-panel`, `pinned-panel-close` |
| **ThreadPanel.svelte** | `thread-panel`, `thread-panel-close`, `thread-reply-input`, `thread-send` |
| **NotificationToast.svelte** | `toast`, `toast-close` |
| **ConnectionStatus.svelte** | `connection-status` (on all 3 state variants) |
| **ThemeToggle.svelte** | `theme-toggle` |
| **Avatar.svelte** | `avatar` (on both clickable and static variants) |
| **DateSeparator.svelte** | `date-separator` |

**Total: 60+ data-testid attributes added across 18 components.**

## Priority 2: Defensive Programming (Python Backend)

### Files Modified (6 Python modules)

| Module | Changes |
|---|---|
| **participant.py** | `validate_key()` and `validate_name()` now accept `None` safely, returning `False` instead of crashing with TypeError |
| **message.py** | `validate_conv_id()` now accepts `None` safely, returning `False` |
| **log_exporter.py** | `format_log_entry()` handles missing/malformed `ts`, `sender`, `body` fields gracefully instead of raising KeyError; `format_presence_event()` handles None name/key and malformed timestamps |
| **hook_installer.py** | `install_hook()` validates participant_key as non-empty string, wraps file I/O and settings updates in try/except with descriptive error messages; `uninstall_hook()` gracefully handles failures in script removal and settings update independently |
| **broker.py** | `generate_client_id()` validates component and participant_key are non-empty, with docstring for return type and exceptions |
| **mcp_server.py** | `_get_registry()` and `_get_store()` replaced bare `assert` with proper `RuntimeError` and descriptive error messages (asserts can be stripped with `python -O`) |

## Priority 3: Playwright Test Updates

### Files Modified (8 test files)

All 8 Playwright E2E test files updated from CSS class selectors to `data-testid` selectors:

- `e2e/app-loads.spec.js` -- `.sidebar-left` to `[data-testid="sidebar"]`, `.header-name` to `[data-testid="header-channel-name"]`, etc.
- `e2e/sidebar.spec.js` -- `.channel-item` to `[data-testid^="channel-item-"]`, `.create-channel` to `[data-testid="sidebar-create-channel"]`, etc.
- `e2e/chat.spec.js` -- `.input-wrap input` to `[data-testid="message-input"]`, `.btn-send` to `[data-testid="send-button"]`, etc.
- `e2e/panels.spec.js` -- `.header-btn[title="Search"]` to `[data-testid="header-search-btn"]`, `.search-panel` to `[data-testid="search-panel"]`, etc.
- `e2e/modals.spec.js` -- `.modal-overlay` to `[data-testid="channel-modal"]`, `.toggle-switch` to `[data-testid="channel-modal-private-toggle"]`, etc.
- `e2e/member-list.spec.js` -- `.sidebar-right` to `[data-testid="member-list"]`, `.member` to `[data-testid^="member-"]`, etc.
- `e2e/context-menu.spec.js` -- `.context-menu` to `[data-testid="context-menu"]`, `.ctx-item` filter to `[data-testid="ctx-copy"]`, etc.
- `e2e/console-errors.spec.js` -- All selectors updated to data-testid equivalents.

## Verification

- **Vite build:** PASSED (156 modules transformed, 1.24s)
- **Python tests:** 360/360 PASSED (0.53s)
- **Playwright tests:** Not run (requires dev server and browser binaries)
