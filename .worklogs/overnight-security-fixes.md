# Overnight Security Fixes

**Date:** 2026-03-30
**Commit:** 8156b37
**Branch:** main

## Issues Fixed

### 1. XSS in SearchPanel.svelte

**File:** `web/src/components/SearchPanel.svelte`

**Problem:** `highlightMatch()` used `{@html}` to render search results with `<mark>` tags but did not escape the message body first. A crafted message containing `<script>` or event handlers would execute in the browser.

**Fix:** Imported `sanitizeHtml` from `utils.js` and applied it to both the message text and the query string before constructing the regex and injecting `<mark>` tags. The text is now entity-escaped before any HTML insertion.

### 2. CORS wildcard on API endpoints

**File:** `src/claude_comms/cli.py`

**Problem:** All 6 API route handlers (3 GET + 3 OPTIONS preflight) returned `Access-Control-Allow-Origin: *`, allowing any origin to call the REST API.

**Fix:** Added `cors_origin = f"http://localhost:{web_port}"` (where `web_port` comes from config, default 9921) and replaced all 6 instances of `"*"` with the computed origin.

## Verification

- Frontend build passes (`npm run build` -- 4348 modules, no errors)
- Python syntax validated (`ast.parse`)
- Committed and pushed to main
