# Overnight MQTT Integration Testing

**Agent:** MQTT Integration Tester
**Started:** 2026-03-29
**Baseline:** 391 tests passing (201 in target files)
**Final:** 504 tests passing (+113 new tests)

## Round 1: Broker Lifecycle (31 new tests)
**Commit:** 8760d93

- EmbeddedBroker.from_config() with empty, full, and partial configs
- MessageDeduplicator edge cases: max_size=1, overflow, LRU refresh, concurrent thread safety
- MessageStore: multi-conversation independence, FIFO cap enforcement, thread safety
- replay_jsonl_logs: empty files, blank lines, mixed valid/invalid, nonexistent dir, max_per_conv
- generate_client_id: format, uniqueness (500 calls), empty/None input validation

## Round 2: MCP Tools Logic (43 new tests)
**Commit:** d75ac7e

- All 9 comms_* tool functions: join, leave, send, read, check, members, conversations, update_name, history
- Mock publish for send tests; broker failure handling
- ParticipantRegistry: join/rejoin/leave, case-insensitive name resolution, mixed key/name recipient resolution, dedup, cursor lifecycle
- Token-aware pagination: large message truncation, small message no-truncation, history truncation

## Round 3: Log Exporter (24 new tests)
**Commit:** 9fe4ad6

- Dual format: both files written simultaneously, text has header+entry, JSONL has valid JSON
- Log rotation: size trigger, max files respected, disabled when max_size=0, text rotation
- Deduplication: duplicate rejection, shared deduplicator across exporters, no-id rejection
- Conv ID validation: path traversal, uppercase, reserved names, empty conv, presence with invalid conv
- Grep patterns: by sender name, by key, by content, by date pattern, presence events

## Round 4: CLI Commands (19 new tests)
**Commit:** 0e09efa — new file tests/test_cli.py

- init: config creation, name from option, OS username default, key generation, force overwrite, logs dir creation, invalid type, claude type
- status: no config, daemon not running, daemon running, config summary, stale PID
- Config env var: env overrides yaml, yaml used when no env, warning when auth enabled + no password, no warning when auth disabled, deep merge fills defaults

## Round 5: Gap Coverage (27 new tests)
**Commit:** 68fbf0f

- Error handling: invalid key format, unregistered key, invalid conv, reserved conv, empty body, broker timeout
- format_log_entry: empty dict, missing sender, missing ts, invalid ts, sender not dict
- format_presence_event: None name, None key, invalid ts
- format_log_header: no timestamp (uses current)
- Multi-participant: targeted to self, mixed key/name dedup, cursor tracking, unread counts after read
- Write-then-replay integration: full cycle, dedup integration, multi-conversation

## Pre-existing Issues Found
- `tests/test_tui.py` has a failing test (`test_enter_submits_and_clears`) that predates this work. It's an untracked file from another agent's work.
