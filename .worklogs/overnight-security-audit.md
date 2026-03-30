# Security Audit — Claude Comms

**Date:** 2026-03-30
**Scope:** XSS, injection, auth, CORS, secrets, path traversal
**Status:** Audit only (no changes made)

---

## 1. XSS — Two `{@html}` usages found

### Finding 1.1 — SearchPanel.svelte (MEDIUM risk)

**File:** `web/src/components/SearchPanel.svelte:119`
```svelte
{@html highlightMatch(result.body.slice(0, 150), searchQuery)}
```

The `highlightMatch` function (line 71-75) wraps query matches in `<mark>` tags but **does not escape the message body HTML first**. Since `result.body` comes from other users' messages (via MQTT), a malicious message body containing `<script>` or `<img onerror=...>` tags would be rendered as raw HTML.

**Attack vector:** Any participant sends a message like `<img src=x onerror="alert(document.cookie)">`. When another user searches and this message appears in results, the script executes.

**Fix:** Escape `text` before applying the regex replacement in `highlightMatch()`.

### Finding 1.2 — CodeBlock.svelte (LOW risk)

**File:** `web/src/components/CodeBlock.svelte:78`
```svelte
{@html html}
```

This one is **properly mitigated**. The `highlightedLines` derived value runs each line through `escapeHtml()` (which escapes `&`, `<`, `>`) before `highlightLine()` wraps keywords in `<span>` tags. The escaping happens first, so injected HTML in code blocks is neutralized.

**Status:** Safe. No action needed.

---

## 2. Injection — MQTT topics and file paths

### Finding 2.1 — REST API channel parameter not validated (LOW risk)

**File:** `src/claude_comms/cli.py:320, 376`
```python
channel = request.path_params["channel"]
```

The `/api/messages/{channel}` and `/api/participants/{channel}` REST endpoints pass the `channel` path parameter directly to `get_channel_messages()` and `get_channel_participants()` without calling `validate_conv_id()`. These functions query the in-memory `MessageStore` and `ParticipantRegistry` (dict lookups), so arbitrary channel names just return empty results — no file I/O or command injection occurs here.

**However:** This is inconsistent with the MCP tools, which all validate `conv_id`. If the REST API later adds write operations or log access, the missing validation could become a real issue.

**Status:** Low risk currently, but should be fixed for defense-in-depth.

### Finding 2.2 — MCP tools properly validate (SAFE)

All MCP tool functions in `mcp_tools.py` call `validate_conv_id()` before using conversation IDs. The `validate_conv_id` regex (`^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$`) effectively prevents path traversal (no `/`, `..`, or special chars allowed).

### Finding 2.3 — Log exporter validates conv_id (SAFE)

**File:** `src/claude_comms/log_exporter.py:368-369`

`LogExporter.write_message()` validates `conv_id` before constructing file paths like `{log_dir}/{conv_id}.log`. The strict regex prevents path traversal via crafted conversation IDs.

### Finding 2.4 — subprocess usage (SAFE)

**File:** `src/claude_comms/cli.py:195, 920`

Two subprocess calls exist: one to re-launch the daemon (`subprocess.Popen` with hardcoded `sys.executable` args), and one for `tail -f` on a log file. Neither takes user-controlled input. Safe.

---

## 3. Auth — REST API endpoints have no authentication

### Finding 3.1 — All REST endpoints are unauthenticated (MEDIUM risk)

**File:** `src/claude_comms/cli.py:318-396`

Three REST API endpoints are exposed on port 9920 with zero authentication:
- `GET /api/messages/{channel}` — returns all message history
- `GET /api/identity` — returns the daemon's identity key and name
- `GET /api/participants/{channel}` — returns participant list

Any process on localhost can read all messages and discover identity keys. The MCP tools require a participant `key` parameter, but REST endpoints bypass this entirely.

**Mitigating factor:** All services bind to `127.0.0.1` by default (not `0.0.0.0`), so only local processes can reach them. The config enforces this with comments in `mcp_server.py:12`: "The server MUST bind to 127.0.0.1 only (localhost is the security boundary)."

**Risk assessment:** For a local-only dev tool, this is acceptable. If the tool is ever exposed over a network (Tailscale, reverse proxy), this becomes critical.

### Finding 3.2 — Identity key exposed via REST (LOW risk)

**File:** `src/claude_comms/cli.py:347-361`

`GET /api/identity` returns the daemon's identity `key`. This key is the only "auth" mechanism for MCP tools — knowing it lets you impersonate the daemon owner via `comms_send`. On localhost this is low risk since any local process could also read `~/.claude-comms/config.yaml`.

---

## 4. CORS — Wildcard origin on all endpoints

### Finding 4.1 — `Access-Control-Allow-Origin: *` everywhere (LOW risk)

**File:** `src/claude_comms/cli.py:330, 341, 357, 368, 381, 392`

Every REST endpoint returns `Access-Control-Allow-Origin: *`. This means any website open in the user's browser could make cross-origin requests to `localhost:9920` and read message history, identity keys, and participant lists.

**Attack scenario:** User visits a malicious website. JavaScript on that page calls `fetch('http://localhost:9920/api/messages/general')` and exfiltrates conversation data. The wildcard CORS header permits this.

**Fix:** Restrict to `http://localhost:9921` (or whatever the web UI origin is) instead of `*`.

---

## 5. Secrets — No hardcoded secrets found

### Finding 5.1 — Password handling is clean (SAFE)

- Identity keys are generated via `secrets.token_hex(4)` at init time
- Broker password uses env var `CLAUDE_COMMS_PASSWORD` with YAML fallback
- Config file permissions are set to `chmod 600`
- No hardcoded passwords, API keys, or tokens in source code
- `.env` files are in `.gitignore` and `.dockerignore`

**Status:** Clean. Good practices observed.

---

## 6. Path Traversal — conv_id validation is solid

### Finding 6.1 — Regex prevents traversal (SAFE)

**File:** `src/claude_comms/message.py:14`
```python
CONV_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$")
```

This allowlist regex only permits lowercase alphanumeric characters and hyphens (1-64 chars). No dots, slashes, backslashes, or null bytes can pass. Path traversal via `conv_id` is effectively blocked wherever `validate_conv_id()` is called.

**Gap:** The REST API endpoints (Finding 2.1) do not call this validator, but they also don't construct file paths from the channel parameter.

---

## Summary

| # | Category | Finding | Severity | Action Needed |
|---|----------|---------|----------|---------------|
| 1.1 | XSS | `SearchPanel.svelte` renders unescaped message body via `{@html}` | **MEDIUM** | Escape HTML before highlight replacement |
| 2.1 | Injection | REST API skips `validate_conv_id()` on channel param | LOW | Add validation for consistency |
| 3.1 | Auth | REST endpoints have no authentication | **MEDIUM** | Acceptable for localhost-only; document the trust boundary |
| 3.2 | Auth | Identity key exposed via REST | LOW | Acceptable for localhost-only |
| 4.1 | CORS | Wildcard `Access-Control-Allow-Origin: *` | LOW | Restrict to web UI origin |
| 1.2 | XSS | `CodeBlock.svelte` uses `{@html}` but escapes first | SAFE | None |
| 2.2 | Injection | MCP tools validate all inputs | SAFE | None |
| 2.3 | Path traversal | Log exporter validates conv_id | SAFE | None |
| 5.1 | Secrets | No hardcoded secrets | SAFE | None |
| 6.1 | Path traversal | Strong conv_id regex | SAFE | None |

### Priority fixes (if desired):
1. **SearchPanel XSS** — Add `escapeHtml()` call in `highlightMatch()` before regex replacement
2. **CORS restriction** — Change `*` to the specific web UI origin
3. **REST validation** — Add `validate_conv_id()` call in REST endpoints for defense-in-depth
