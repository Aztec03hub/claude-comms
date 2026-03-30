# Recipient Filtering Fix

**Date:** 2026-03-30
**Status:** Complete

## Problem

Targeted messages (with `recipients` set) were visible to ALL participants via `comms_read`. They should only be visible to the sender and listed recipients.

## Fix

- Added `_is_visible(msg, viewer_key)` helper function to `mcp_tools.py`
- Applied filter in `tool_comms_read` before any other message processing
- Broadcast messages (null/empty recipients) remain visible to all
- Targeted messages are visible only to sender and listed recipients

## Files Changed

- `src/claude_comms/mcp_tools.py` — added visibility filter in `tool_comms_read`

## Testing

- All 818 tests pass (58 in test_mcp_tools.py specifically)
