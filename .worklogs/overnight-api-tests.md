# Overnight API Tests Work Log

**Date:** 2026-03-30
**Task:** Write tests for untested overnight features

## What Was Done

Created `/home/plafayette/claude-comms/tests/test_api_endpoints.py` with 25 tests covering 6 feature areas:

### 1. Message History REST API (`get_channel_messages`)
- Returns empty list when store is uninitialized
- Returns messages from store correctly
- Respects count limit parameter
- Returns empty for unknown channels

### 2. Identity REST API (config identity extraction)
- Extracts key/name/type from config
- Defaults when identity section is missing
- Default type is "human"
- Claude type is preserved

### 3. Participants REST API (`get_channel_participants`)
- Returns empty list when registry is uninitialized
- Returns participants with client='mcp' field
- Returns multiple participants
- Returns empty for channels with no members

### 4. Broker Crash Resilience (retry loop)
- Retry counter increments on each failure
- Succeeds after transient failure on second attempt
- Respects shutdown event to stop retrying

### 5. MCP Presence Publishing on Join
- Presence payload contains expected fields (key, name, type, status, client, ts)
- Presence published to both conv-scoped and system-scoped topics
- Publish function is called with correct topics and payloads

### 6. Client Type Display in Presence
- Participant response includes client='mcp'
- Client field is always a non-empty string
- Presence payload JSON includes client key
- System topic includes -mcp suffix for client disambiguation

### Integration Tests
- Add-then-retrieve pipeline through store + API
- Deduplicator prevents duplicate messages in API results
- Multiple channels are properly isolated

## Test Results

All 25 tests passed in 0.32s.

## Approach

Tests call the backing functions (`get_channel_messages`, `get_channel_participants`) directly with controlled module state, avoiding the need for a running daemon. Broker retry logic is tested by reproducing the retry loop pattern from `cli.py`. Presence publishing is tested by verifying payload format and topic structure.
