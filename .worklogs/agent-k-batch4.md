# Agent-K Work Log — Batch 4: Packaging + Docker + CI

**Date:** 2026-03-29
**Agent:** Agent-K
**Work Package:** Packaging, Docker, CI

## Files Created

### 1. `Dockerfile`
- Multi-stage build: Stage 1 (`node:22-slim`) builds Svelte web UI, Stage 2 (`python:3.12-slim`) runs the Python app
- Copies pre-built web assets from Stage 1 into `/app/web-dist`
- Installs package via `pip install ".[all]"` from pyproject.toml
- Exposes all 4 ports: 1883 (MQTT TCP), 9001 (MQTT WS), 9920 (MCP), 9921 (Web UI)
- Entrypoint: `claude-comms start --web`
- Health check: Python socket connection test to MQTT broker port 1883
- Optimized for minimal image size: `--no-cache-dir`, `PYTHONDONTWRITEBYTECODE=1`, slim base images

### 2. `docker-compose.yml`
- Single service `claude-comms` with all 4 ports mapped
- Named volume `comms-data` mounted at `/root/.claude-comms` for persistent config/logs
- Environment variable `CLAUDE_COMMS_PASSWORD` with default fallback
- Restart policy: `unless-stopped`

### 3. `.github/workflows/ci.yml`
- Triggers: push to main, pull requests to main
- Concurrency control: cancels in-progress runs for same ref
- **lint job**: ruff check + ruff format check on Python source and tests
- **test job**: matrix strategy across Python 3.10, 3.11, 3.12 with pip caching, uploads JUnit XML test results as artifacts
- **build-web job**: Node 22 with npm caching, builds Svelte app, uploads dist as artifact
- All jobs use latest action versions (checkout@v4, setup-python@v5, setup-node@v4, upload-artifact@v4)

## Design Decisions

- Used `ruff` for linting (modern, fast, replaces flake8+isort+black) -- consistent with modern Python projects
- npm ci with fallback to npm install (handles case where lock file may not exist yet)
- JUnit XML output for test results enables GitHub Actions test summary integration
- Health check uses raw Python socket rather than curl/wget to avoid installing extra packages in slim image
- 30-day artifact retention balances storage with debugging needs
- `fail-fast: false` on test matrix so all Python versions report results even if one fails

## Integration Notes

- The Dockerfile copies web assets to `/app/web-dist` -- the Python server code will need to know this path when serving static files in Docker mode (could use env var or convention)
- No `.dockerignore` was created -- recommend adding one with `__pycache__`, `.git`, `node_modules`, `mockups/`, `.worklogs/` to speed up builds
- The CI workflow assumes `ruff` is the linter of choice; if the project uses a different linter, update accordingly
