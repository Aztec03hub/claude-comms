# Overnight: TUI & Python CLI Improvements

**Date:** 2026-03-30
**Agent:** TUI/Python backend agent

## Summary

Focused on TUI typing indicators, LWT, and Python CLI improvements. Found that
most changes were already implemented and committed by a prior agent (commit
`d4744b4`). Applied additional fixes and tests on top.

## Round 1: TUI Typing Indicators

**Status:** Already implemented in `d4744b4`, bugfix added.

- `on_input_changed` publishes typing indicators to
  `claude-comms/conv/{channel}/typing/{key}` with QoS 0
- Debounced to at most once per 2 seconds (`_TYPING_DEBOUNCE_SECS`)
- Typing indicator cleared (set to `false`) on message send
- **Bugfix added:** Skip re-publishing typing when input is cleared after send
  (the `Input.Changed` event fires when `_input.value = ""`, which would
  re-trigger the typing indicator with `typing: true`)

## Round 2: TUI LWT (Last Will and Testament)

**Status:** Already implemented in `d4744b4`.

- `aiomqtt.Will` configured on the MQTT client connection
- Topic: `claude-comms/conv/{active_channel}/presence/{key}`
- Payload: offline presence with `retain=True`, QoS 1
- Broker auto-publishes the LWT message on unclean disconnect

## Round 3: Python CLI Improvements

**Status:** Already implemented in `d4744b4`.

- `send` command prints confirmation: "Message sent to #{channel}"
- `status` command queries `/api/participants/{channel}` for participant count
- `--version` / `-V` flag added via `@app.callback()` with `is_eager=True`

## New Tests Added

- `TestRound10TypingIndicators` (3 tests):
  - Debounce state initialization
  - Typing timestamp resets on send
  - `on_input_changed` only fires for message-input widget
- `TestRound11LWT` (1 test):
  - Identity attributes available for LWT construction

## Files Modified

- `src/claude_comms/tui/app.py` -- bugfix: skip typing on empty input
- `tests/test_tui.py` -- 4 new tests for typing indicators and LWT
- `tests/test_cli.py` -- fix coroutine warning in status daemon running test
  (already committed in prior agent's work)

## Test Results

93 tests pass (86 existing + 4 new TUI tests + 3 new CLI tests from prior commit).
