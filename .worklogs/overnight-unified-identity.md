# Unified Identity: Web UI + TUI Share Same Key

**Date:** 2026-03-30
**Status:** Complete

## Problem
The Web UI and TUI used different identity keys for the same user:
- TUI read its key from `~/.claude-comms/config.yaml` (e.g., `a1aece1b`)
- Web UI generated a random key in `localStorage` (different key each browser/session)
- Both showed as "Phil" but appeared as separate participants in the member list

## Changes

### 1. Added `/api/identity` REST endpoint (`src/claude_comms/cli.py`)
- `GET /api/identity` returns `{ key, name, type }` from the daemon's loaded config
- Includes CORS headers and OPTIONS preflight handler
- Routes inserted into the Starlette app alongside existing `/api/messages` routes

### 2. Updated `connect()` in `web/src/lib/mqtt-store.svelte.js`
- Made `connect()` async
- Before MQTT setup, fetches identity from `/api/identity`
- On success: uses daemon config key/name/type, caches in localStorage
- On failure (daemon not running): falls back to localStorage, then generates a new key
- localStorage is now a fallback cache, not the primary source of truth

### 3. Client field differentiation (linter-applied)
- Presence messages now include a `client: 'web'` field
- Participant registry keys use `{identity_key}-{client}` format
- Allows the same user to appear once per client type without collision

## Commits
- `3db3b99` — identity endpoint + identity fetch in connect()
- `54894de` — client field in presence messages

## Verification
- `npm run build` passes cleanly
- Pushed to `origin/main`
