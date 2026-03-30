# Agent-G Batch 2 Work Log — Notification Hook

**Date:** 2026-03-29
**Status:** COMPLETE

## Files Created

1. **`src/claude_comms/hook_installer.py`** — Core module with `install_hook()` and `uninstall_hook()` public API
2. **`src/claude_comms/notification_hook.sh`** — Unix/WSL hook script template (reference/documentation)
3. **`src/claude_comms/notification_hook.cmd`** — Windows hook script template (reference/documentation)
4. **`tests/test_notification_hook.py`** — 45 tests covering all functionality

## Implementation Details

### hook_installer.py
- **Platform detection:** `_is_windows()` checks `sys.platform` and `platform.system()`
- **Script generation:** `_generate_unix_script()` and `_generate_windows_script()` produce self-contained scripts with the participant key baked in
- **install_hook(participant_key, config_path):**
  - Loads key from config if not provided
  - Generates platform-appropriate script
  - Writes to `~/.claude/hooks/claude-comms-notify-{key}.sh` (or `.cmd`)
  - Sets executable permission on Unix
  - Creates `~/.claude-comms/notifications/` directory
  - Adds PostToolUse hook entry to `~/.claude/settings.json` (preserving existing content, replacing any prior claude-comms hook)
- **uninstall_hook(participant_key, config_path):**
  - Removes the hook script file
  - Removes the claude-comms entry from settings.json (preserves other hooks)
- **Idempotent:** Reinstalling replaces the old hook entry rather than duplicating

### Hook Script Logic (Unix)
1. Drains stdin (`cat > /dev/null`) — required by Claude Code hooks
2. Checks `~/.claude-comms/notifications/{key}.jsonl` exists and has content
3. Reads + truncates the file atomically
4. Formats up to 5 most recent messages into a summary
5. Outputs JSON with `hookSpecificOutput.additionalContext` for Claude to see

### Hook Script Logic (Windows)
- Same flow but uses `more > nul` for stdin drain and PowerShell for JSON processing

### Settings.json Format
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "/home/user/.claude/hooks/claude-comms-notify-{key}.sh",
        "timeout": 5
      }]
    }]
  }
}
```

## Test Results

```
45 passed, 2 warnings in 0.33s
```

Test classes:
- **TestScriptGeneration** (13 tests) — Script content validation for both platforms
- **TestScriptNaming** (3 tests) — File naming and path conventions
- **TestSettingsManipulation** (14 tests) — JSON settings read/write/add/remove/replace
- **TestInstallUninstall** (11 tests) — Full install/uninstall cycle with mock home dir
- **TestHookScriptExecution** (4 tests) — Subprocess execution of generated bash script, verifying JSON output, file truncation, and multi-message handling

## Dependencies
- Reads `config.py` for `load_config()` to resolve participant key
- The `cli.py` `init` command should call `install_hook()` after saving config

## Integration Notes
- Agent-A (CLI) should add `from claude_comms.hook_installer import install_hook` to `init()` command
- Agent-E (MCP server) writes to `~/.claude-comms/notifications/{key}.jsonl` — the hook reads from there
- The template `.sh` and `.cmd` files in `src/` are reference copies; the installer generates scripts dynamically via `_generate_unix_script()` / `_generate_windows_script()`
