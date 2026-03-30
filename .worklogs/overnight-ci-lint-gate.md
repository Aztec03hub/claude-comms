# CI Lint Gate Update

**Date:** 2026-03-30
**Task:** Remove `continue-on-error: true` from CI lint job

## What was done

- Verified `ruff check src/ tests/` passes locally with zero errors
- Removed `continue-on-error: true` (and its comment) from the lint job in `.github/workflows/ci.yml`
- Lint job now properly gates CI -- lint failures will block the pipeline

## File changed

- `.github/workflows/ci.yml` -- removed lines 17-18 (`continue-on-error: true` + comment)
