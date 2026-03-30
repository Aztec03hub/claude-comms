# Overnight Test Expansion Work Log

**Date:** 2026-03-30
**Starting test count:** 678
**Ending test count:** 714
**New tests added this session:** 36

## Files Created

- `tests/test_gaps_expanded.py` — 36 tests (new this session)

### Previously existing gap test files (105 tests from prior session)
- `tests/test_gaps_hook_installer.py` — 20 tests
- `tests/test_gaps_log_exporter.py` — 22 tests
- `tests/test_gaps_mcp_tools.py` — 20 tests
- `tests/test_gaps_config.py` — 20 tests
- `tests/test_gaps_message.py` — 23 tests

## Coverage Areas

### hook_installer.py
- hook_enabled config check when notifications section missing, hook_enabled key missing
- Windows template generation details (ConvertTo-Json, Set-Content, file existence check)
- Install validation: whitespace key, empty string key
- Uninstall with empty key in config, corrupt settings.json, full cleanup verification
- _is_claude_comms_hook_entry: empty hooks list, missing hooks key, no command key, mixed hooks

### log_exporter.py
- Rotation exactly at max size boundary (triggers) vs just under (does not trigger)
- Multiple rotation chains creating .1, .2, .3 files
- Rotation respects max_files by deleting oldest
- Rotation disabled when max_size=0 or max_files=0
- Rotation on nonexistent file (no-op)
- Malformed messages: empty dict, None, missing ts, invalid ts, non-dict sender, missing sender
- Header management: not written for jsonl-only, written once for multiple messages, pre-existing file assumed to have header

### mcp_tools.py
- Token-aware pagination: single message exceeding limit (still returned), most recent kept on truncation
- History token truncation
- Count clamping: min (0 -> 1), max (999 -> 200), negative
- Send with invalid conversation, very long message (100K chars)
- Leave with invalid conversation, invalid key format
- Concurrent registry joins (20 threads)
- resolve_recipients: unknown names dropped, empty list, all unknown
- Check after cursor update shows 0 unread, check with invalid key

### config.py
- Migration: old config without notifications, web, mcp.auto_join sections
- Corrupt YAML: empty file, null content, non-dict content (list)
- _deep_merge: empty overlay, empty base, new keys, type changes, deep nesting, no mutation
- Save overwrite, extra keys preserved
- Default config structure: rotation keys, broker auth, identity type, deep copy safety

### message.py
- Conv ID: max length 64 (valid), 65 (invalid), 2-char with hyphen, consecutive hyphens, numeric only, unicode, space, underscore, dot, None
- Unicode body roundtrip (emoji, CJK), unicode sender name, multiline body preserved
- Sender validation: key too short/long, empty name, invalid type
- Sender key uppercase accepted (documents behavior difference vs Participant)
- from_mqtt_payload: invalid JSON, missing required field, bytes UTF-8
- is_for: sender in own recipients, multiple recipients, empty recipients list
- Recipients validation: multiple valid, uppercase rejected, wrong length rejected

## Findings

- `Sender` model only validates key length (8 chars) but NOT hex pattern. The `Participant` model validates the full hex pattern. This is a potential inconsistency but may be intentional for wire-format flexibility.
- `load_config` with non-dict YAML content (e.g., a list) will raise `TypeError`/`AttributeError` since `_deep_merge` expects dicts. No graceful fallback exists for this edge case.
- Log rotation uses `>=` comparison, so a file exactly at max_size_bytes will trigger rotation.

## New Coverage in test_gaps_expanded.py

### hook_installer
- Settings roundtrip integrity (add/remove/add cycles, key replacement)
- Unix script detail checks (tail -n 5 limit, wc -l count, overflow message)

### log_exporter
- from_config: string log_dir, empty rotation defaults, shared deduplicator
- Unicode in text and JSONL logs (emoji, CJK characters)
- write_presence in text-only mode
- format_log_entry: very long body, empty body

### mcp_tools
- comms_conversations unread tracking (multi-conv, after partial read)
- comms_members invalid conv ID, members after leave
- Registry conversations_for (multiple joins, unknown key)
- comms_history: no results for query, case-insensitive search

### config
- Password resolution: env overrides yaml, empty env does not override
- _default_username: returns string, fallback to "unnamed" on error
- Full save/load roundtrip verifying all field categories

### message
- Topic format with different conv IDs
- reply_to preservation in roundtrip and default None
- Conv ID boundary lengths (63, 64 chars, hyphens at max length)
- Field access (sender fields, UUID validity, timezone in ts)

## Suite Status

All 714 tests passing, 0 failures, 34 warnings (all pre-existing auth warnings).
