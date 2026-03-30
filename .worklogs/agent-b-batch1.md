# Agent-B Batch 1 Work Log — Message + Mention + Participant

**Date:** 2026-03-13
**Status:** Complete — 93/93 tests passing

## Files Created

### Source modules (under `src/claude_comms/`)

1. **`/home/plafayette/claude-comms/src/claude_comms/message.py`**
   - Pydantic v2 models: `Sender` and `Message`
   - Full JSON serialization/deserialization via `to_mqtt_payload()` / `from_mqtt_payload()`
   - Conversation ID validation with `CONV_ID_PATTERN` regex and reserved name blocking (`system`, `meta`)
   - Recipient key validation (must be 8 lowercase hex chars)
   - Convenience constructor `Message.create()` with auto-generated UUID and ISO 8601 timestamp
   - Routing helpers: `is_broadcast`, `is_for(key)`, `topic` property
   - Utility functions: `validate_conv_id()`, `new_message_id()`, `now_iso()`

2. **`/home/plafayette/claude-comms/src/claude_comms/mention.py`**
   - `MENTION_PATTERN` and `NAME_PATTERN` regex exactly as specified in the architecture plan
   - `extract_mentions(body)` — pulls display names from `[@name, ...]` prefix
   - `strip_mentions(body)` — removes the prefix, returns bare text
   - `build_mention_prefix(names)` — constructs the `[@name1, @name2] ` prefix string
   - `resolve_mentions(body, name_to_key)` — extracts mentions and resolves to participant keys with deduplication; silently skips unknown names

3. **`/home/plafayette/claude-comms/src/claude_comms/participant.py`**
   - Pydantic v2 model: `Participant` with key, name, type fields
   - Key generation via `secrets.token_hex(4)` producing 8 lowercase hex chars
   - Validation for keys (`^[0-9a-f]{8}$`) and names (`^[\w-]{1,64}$`)
   - `Participant.create()` convenience constructor with auto-generated key
   - `with_name()` for immutable name changes (key preserved)
   - MQTT serialization and `registry_topic` property

### Test files (under `tests/`)

4. **`/home/plafayette/claude-comms/tests/test_message.py`** — 33 tests
   - Creation (convenience constructor, defaults, recipients + reply_to)
   - JSON round-trip serialization (string and bytes)
   - Validation (conv_id patterns, reserved names, leading/trailing hyphens, recipient keys, empty body)
   - Routing helpers (broadcast, targeted, topic)
   - Utility functions (UUID generation, ISO timestamp, conv_id validation parametrized)

5. **`/home/plafayette/claude-comms/tests/test_mention.py`** — 21 tests
   - extract_mentions: single, multiple, three, none, not-at-start, inline @, hyphen/underscore names, spacing, empty, multiline
   - strip_mentions: with/without prefix, preserves rest of body
   - build_mention_prefix: empty, single, multiple, round-trip with extract
   - resolve_mentions: known names, unknown skipped, no mentions, duplicate dedup, empty lookup

6. **`/home/plafayette/claude-comms/tests/test_participant.py`** — 26 tests (parametrized expand to 39)
   - Key generation: length, hex-only, uniqueness (100 keys), lowercase
   - Validation: valid/invalid keys and names parametrized
   - Model: create claude/human, invalid key/name/type rejection
   - Name management: with_name returns new instance, preserves type
   - Serialization: JSON round-trip, bytes, key set verification
   - Registry topic format

## Issues Encountered

- **`phil0e8a` from the plan is not valid hex.** The architecture plan uses `phil0e8a` as an example participant key, but `p`, `h`, `i`, `l` are not hexadecimal characters. Since `secrets.token_hex(4)` can only produce `[0-9a-f]`, the validator correctly rejects this. Fixed the test fixture to use `00ff0e8a` instead. This is a documentation inconsistency in the plan — the key validation is correct.

## Deviations from Plan

- None beyond the test fixture hex key fix noted above. All models, patterns, and validation match the architecture spec exactly.

## Potential Bugs / Concerns

- **Plan's example key `phil0e8a` is not valid hex.** If other agents (MCP tools, CLI) use the plan's example keys verbatim in tests or hardcoded values, they will fail validation. All keys must be `[0-9a-f]{8}`.
- **`NAME_PATTERN` in participant.py uses `\w` which includes digits and underscores.** This matches the mention regex `@([\w-]+)`, so names like `123` or `_test` are valid. This is intentional per the plan's regex.
- **Recipient keys in Message are validated strictly as hex.** If any other component produces keys with different casing or length, messages will fail to construct.
