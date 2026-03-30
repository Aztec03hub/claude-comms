# Overnight Lint Fix

**Date:** 2026-03-30
**Task:** Fix 109 ruff lint errors so CI passes clean

## Summary

Resolved all 109 ruff lint errors across `src/` and `tests/`.

- **82 auto-fixed** via `ruff check --fix` (unused imports, import sorting, multi-imports)
- **27 fixed manually:**
  - **F841 (unused variables, 13):** Prefixed with `_` (context manager targets) or removed assignment where return value was not needed
  - **E741 (ambiguous variable name `l`, 11):** Renamed to `line` in list comprehensions and generator expressions
  - **E402 (import not at top, 2):** Moved `import os` to top of `test_broker.py`; moved `ModalScreen` import to top of `tui/app.py`
  - **F821 (undefined name, 1):** Removed forward-reference type annotation `-> "LogExporter"` from `conftest.py` fixture

## Files Modified

### Source
- `src/claude_comms/cli.py` -- unused `client` in async-with
- `src/claude_comms/mcp_server.py` -- unused `host`/`port` vars
- `src/claude_comms/tui/app.py` -- moved ModalScreen import to top
- `src/claude_comms/tui/status_bar.py` -- removed unused `current_len`

### Tests
- `tests/conftest.py` -- removed undefined `LogExporter` type hint
- `tests/test_api_endpoints.py` -- removed unused `loop`
- `tests/test_broker.py` -- moved `import os` to top
- `tests/test_cli.py` -- removed unused `loaded` (x2)
- `tests/test_e2e.py` -- removed unused `store`, renamed `l` to `line`
- `tests/test_gaps_config.py` -- removed unused `config`
- `tests/test_integration.py` -- removed unused `store`/`p1`/`p2`, renamed `l` to `line` (x8)
- `tests/test_log_exporter.py` -- renamed `l` to `line` (x2)
- `tests/test_tui.py` -- removed unused `original_send`

## Formatting

Ran `ruff format src/ tests/` -- 31 files reformatted.

## Verification

- `ruff check src/ tests/` -- All checks passed
- `pytest tests/ -q --tb=no` -- 746 passed in 15s
