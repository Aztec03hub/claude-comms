# Docker Verification Work Log

**Date:** 2026-03-30
**Task:** Verify Dockerfile and docker-compose.yml against current codebase

## Checks Performed

| Check | Status | Notes |
|-------|--------|-------|
| Node 22 for Tailwind v4 | OK | Already uses `node:22-slim` |
| bits-ui + lucide-svelte | OK | Installed via `npm ci` from `web/package.json` |
| mcp[cli] -> mcp fix | OK | `pyproject.toml` uses `mcp>=1.20.0` (no `[cli]` extra) |
| Exposed ports | OK | 1883, 9001, 9920, 9921 all correct |
| Entrypoint `claude-comms start --web` | OK | CLI has `start` command with `--web` flag |
| .dockerignore | CREATED | Was missing; now excludes mockups, test-results, node_modules, .worklogs, .git, etc. |

## Issues Found and Fixed

### 1. Web dist path mismatch (FIXED)
- **Problem:** Dockerfile copied built web assets to `/app/web-dist`, but `cli.py` line 458 resolves the path as `_pkg_dir / "../../web/dist"` (i.e., `/app/web/dist`).
- **Fix:** Changed `COPY --from=web-builder` destination from `/app/web-dist` to `/app/web/dist`.

### 2. Missing .dockerignore (FIXED)
- **Problem:** No `.dockerignore` existed, meaning Docker build context would include mockups (~100+ PNGs), test-results, node_modules, .git, etc.
- **Fix:** Created `.dockerignore` excluding all non-essential directories and files.

## Known Limitation (Not Fixed -- requires source code change)

### Web UI host hardcoded to 127.0.0.1
- `cli.py` line 469 hardcodes `host="127.0.0.1"` for the web UI uvicorn server.
- The broker and MCP server hosts are configurable via `config.yaml`, but the web host is not.
- This means port 9921 (web UI) will **not be reachable from outside the container**.
- Added a comment in `docker-compose.yml` documenting this limitation.
- **Recommendation:** Make web host configurable via `config["web"]["host"]` in a future sprint.

## Files Modified
- `Dockerfile` -- Fixed web dist copy path
- `docker-compose.yml` -- Added port comments, documented web host limitation
- `.dockerignore` -- Created from scratch
