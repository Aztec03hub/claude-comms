# Web Host Bind Address Fix

**Date:** 2026-03-30
**Commit:** 3fbbc22

## Problem

The web UI server in `cli.py` hardcoded `host="127.0.0.1"` in the uvicorn config, making port 9921 unreachable from outside a Docker container. The Dockerfile agent flagged this during Docker verification.

## Changes

### `src/claude_comms/config.py`
- Added `"host": "127.0.0.1"` to the `web` section of `_DEFAULT_CONFIG`

### `src/claude_comms/cli.py`
- `start()`: reads `web_host` from `config['web']['host']` (default `"127.0.0.1"`)
- `start()`: passes `web_host` to `uvicorn.Config()` instead of hardcoded string
- `start()`: uses `web_host` in the console log URL
- `web()` command: reads `web_host` from config for the browser-open URL

## Docker Usage

In `docker-compose.yml` or the user's config, set:

```yaml
web:
  host: "0.0.0.0"
```

Or via environment variable override (if added later).

## Verification

- All 746 tests pass
- Default behavior unchanged (still binds to 127.0.0.1)
- Pushed to main
