# Type Check Report - 2026-03-30

**Tool:** pyright 1.1.408, Python 3.12
**Scope:** `src/claude_comms/`
**Result:** 7 errors, 1 warning

## Summary

No critical/blocking errors. All 7 errors are **None-safety issues** (passing `Optional[X]` where `X` is required) or minor type narrowing gaps. These are low-risk in practice since the code likely guards against None at runtime, but the type signatures don't reflect that.

## Errors by File

### `cli.py` (3 errors)

| Line | Severity | Issue |
|------|----------|-------|
| 450 | Low | `MessageStore | None` passed where `MessageStore` required in `_mqtt_subscriber()` |
| 451 | Low | `MessageDeduplicator | None` passed where `MessageDeduplicator` required in `_mqtt_subscriber()` |
| 531 | Medium | `web_uvi_server` is possibly unbound -- variable may not be assigned before use in some code paths |

### `mcp_server.py` (3 errors)

| Line | Severity | Issue |
|------|----------|-------|
| 303 | Low | `PublishFn | None` passed where `PublishFn` required in `tool_comms_send()` |
| 423 | Low | `MessageStore | None` passed where `MessageStore` required in `_mqtt_subscriber()` |
| 423 | Low | `MessageDeduplicator | None` passed where `MessageDeduplicator` required in `_mqtt_subscriber()` |

### `mcp_tools.py` (1 error)

| Line | Severity | Issue |
|------|----------|-------|
| 99 | Low | `str` passed where `ParticipantType` (Literal union) expected in `Participant.create()` |

## Warning

### `tui/__init__.py` (1 warning)

| Line | Severity | Issue |
|------|----------|-------|
| 9 | Low | `ClaudeCommsApp` listed in `__all__` but not present in module scope (likely lazy import issue) |

## Assessment

- **Critical errors:** 0
- **Most common pattern:** Optional values passed without None-checks (6 of 7 errors). Fix would be adding `assert` guards or `if x is not None` checks before the calls.
- **One worth watching:** `web_uvi_server` possibly unbound (cli.py:531) -- could cause a `NameError` at runtime if the relevant code path is hit without the variable being assigned first.
- **Quick win:** The `mcp_tools.py:99` Literal type mismatch is trivially fixable by casting or using the correct literal value.
