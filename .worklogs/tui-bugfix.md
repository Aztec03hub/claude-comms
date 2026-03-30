# TUI Bug Fix Work Log

**Date:** 2026-03-29
**Agent:** TUI Bug Fix and Testing Agent

## Bugs Found and Fixed

### 1. Empty name crash (config.py + app.py)

**Root cause:** `get_default_config()` set `identity.name` to `""`, and `init` command only set a name if explicitly passed via `--name`. When TUI launched, `Sender(name='')` failed Pydantic validation (`min_length=1`).

**Fix (config.py):** Added `_default_username()` helper that uses `getpass.getuser()` to get the OS username. `get_default_config()` now sets `identity.name` to the OS username by default.

**Fix (app.py):** Changed name fallback from `identity.get("name", "unnamed")` to `identity.get("name", "") or f"user-{self._key}"`. The old pattern only fell back if the key was missing from the dict; with an explicit empty string `""`, it would use the empty string. The `or` pattern handles both missing and empty.

### 2. Empty name in presence handler (app.py)

**Bug:** `_handle_presence()` accepted empty `key` from presence payloads and would add a participant with key `""`.

**Fix:** Added early return if key is empty. Also applied same `or` fallback for empty names.

### 3. ValueError in conversation cycling (app.py)

**Bug:** `action_switch_conversation()` called `self._conversations.index(self._active_conv)` which raises `ValueError` if the active conversation was dynamically added but not in the list.

**Fix:** Wrapped in try/except, defaulting to index -1 so cycling starts from the first conversation.

### 4. CLI init always shows name now (cli.py)

**Change:** Removed `if name:` guard on printing the name after init. Since `get_default_config()` always provides a name, it should always be displayed.

## Code Review Findings (no fix needed)

- **channel_list.py**: Handles empty channel lists correctly (defaults to `["general"]` in constructor).
- **chat_view.py**: Handles missing conversations gracefully (returns empty list from `_messages.get()`).
- **participant_list.py**: Handles empty participant lists correctly (starts with empty `_items` dict).
- **message_input.py**: Handles empty input (strips and checks `if body:`), completion with no names (returns early).
- **MQTT worker**: Handles connection failures gracefully (catches Exception, shows system message).
- **MQTT topic subscriptions**: Correct wildcard patterns (`+` for single level).
- **Import name**: `ClaudeCommsApp` is correct throughout.

## Test Results

- 360/360 tests passing
- TUI app instantiates correctly with real config (name: "Phil")
- Empty name fallback verified: produces `"user-{key}"` format
- `get_default_config()` now returns OS username as default name
