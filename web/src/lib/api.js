/**
 * lib/api.js — API base derivation + bearer-token lifecycle + fetch helpers.
 *
 * This is a plain `.js` module (NOT `.svelte.js`): no runes declared here.
 * Components and rune-declaring modules may import from this freely.
 *
 * Responsibilities:
 *  - Derive the API base URL honestly (meta override > dev/prod port heuristic).
 *  - Manage a module-level bearer token cache with a shared in-flight promise.
 *  - Expose `apiGet` / `apiPost` with the R4-1 / R5-1 / R5-2 token flow:
 *      * `apiPost` always awaits `ensureToken()` and honors a per-request retry
 *        budget; on terminal 401 throws a consistent "Session expired" error.
 *      * `apiGet` attaches Authorization only for token-required paths when a
 *        token is already cached (GETs are token-free in v1 — future-proofed).
 *      * `prefetchToken()` is the mount-time wrapper that swallows rejection so
 *        a still-warming daemon does NOT produce an unhandled-rejection log;
 *        the next `apiPost()` transparently refetches.
 */

/**
 * Derive the API base origin.
 *
 * Priority:
 *   1. `<meta name="claude-comms-api-base">` — authoritative override for
 *      reverse-proxy / Tailscale Funnel deployments. The daemon's static
 *      server injects this when `web.api_base` is set.
 *   2. Dev mode on Vite (5173/5174) → same-origin ('' — Vite proxies /api/*).
 *   3. Production bundled on 9921 → cross-port to 9920 (same host).
 *   4. Anything else → same-origin (assume a reverse proxy forwards /api/*).
 *
 * @returns {string} API base URL (no trailing slash), or empty string for same-origin.
 */
function deriveApiBase() {
  if (typeof window === 'undefined') return '';

  const meta = document.querySelector('meta[name="claude-comms-api-base"]');
  if (meta && meta.content) return meta.content.replace(/\/+$/, '');

  const { hostname, port, protocol } = window.location;
  if (port === '5173' || port === '5174') return '';
  if (port === '9921') return `${protocol}//${hostname}:9920`;
  return '';
}

/** Resolved API base. Empty string means "same-origin". */
export const API_BASE = deriveApiBase();

// ── Module-level token state ──────────────────────────────────────────────
// Private to this module. Never persisted to localStorage (extensions could
// read it) — the daemon mints a fresh token on each start, so worst-case the
// user reloads and we refetch.
let cachedToken = null;
/** Shared in-flight token fetch so parallel callers don't thrash the daemon. */
let tokenPromise = null;

/**
 * Endpoints that MUST remain token-free.
 *
 *  - `/api/web-token` — cannot require the thing it provides (bootstrap).
 *  - `/api/capabilities` — needed to decide whether the token is even relevant.
 *
 * Parameterised public GETs (messages, participants, artifacts, conversations,
 * identity) are handled by the prefix match in `isTokenFree`.
 */
const TOKEN_FREE_ENDPOINTS = new Set([
  '/api/web-token',
  '/api/capabilities',
]);

/**
 * Check whether a path is token-free.
 *
 * Strips the query string before matching. Exact-match against the set above,
 * OR prefix-match for the parameterised public GETs. These are token-free in
 * v1; only POSTs to `/api/artifacts/...` require a token.
 *
 * @param {string} path - Request path (e.g. `/api/messages/general?count=50`).
 * @returns {boolean}
 */
function isTokenFree(path) {
  const bare = path.split('?')[0];
  return TOKEN_FREE_ENDPOINTS.has(bare)
    || bare.startsWith('/api/messages/')
    || bare.startsWith('/api/participants/')
    || bare.startsWith('/api/artifacts/')
    || bare === '/api/conversations'
    || bare.startsWith('/api/conversations/')
    || bare === '/api/identity'
    || bare.startsWith('/api/identity/');
}

/**
 * Resolve the cached bearer token, fetching one if needed.
 *
 * Uses a shared in-flight promise (`tokenPromise`) so N parallel callers
 * issue exactly ONE network request. The promise is cleared in `.finally()`
 * so a rejected fetch doesn't poison subsequent retries.
 *
 * @returns {Promise<string>} The bearer token.
 * @throws  If `/api/web-token` returns non-2xx or the response is malformed.
 */
export async function ensureToken() {
  if (cachedToken) return cachedToken;
  if (!tokenPromise) {
    tokenPromise = fetch(`${API_BASE}/api/web-token`)
      .then(r => {
        if (!r.ok) throw new Error(`token fetch ${r.status}`);
        return r.json();
      })
      .then(({ token }) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

/**
 * App-mount prefetch wrapper (R5-1 / R6-5 fix).
 *
 * Call this from `App.svelte` on mount. It kicks off `ensureToken()` and
 * swallows the rejection with a `console.warn` so an unavailable daemon at
 * startup does NOT produce an unhandled-promise-rejection. The next
 * `apiPost()` call will `ensureToken()` again on demand.
 *
 * Do NOT call `ensureToken()` directly at mount — use this wrapper instead.
 */
export function prefetchToken() {
  ensureToken().catch(err => {
    console.warn('[claude-comms] Token prefetch failed; will retry on first POST:', err);
  });
}

/**
 * GET request against the API.
 *
 * Token-free endpoints (per `isTokenFree`) never get an Authorization header.
 * Token-required endpoints (none in v1, but future-proof) get one ONLY if a
 * token is already cached — this function does NOT trigger `ensureToken()`,
 * so GETs never block on bootstrap.
 *
 * @param {string} path    - Path beginning with `/api/...`.
 * @param {object} [opts]  - Optional request options.
 * @param {AbortSignal} [opts.signal] - Abort signal propagated to `fetch`.
 * @returns {Promise<any>} Parsed JSON body.
 * @throws  On non-2xx: an Error with `.status` set.
 * @throws  On abort: DOMException('AbortError') from fetch.
 */
export async function apiGet(path, { signal } = {}) {
  const headers = isTokenFree(path) || !cachedToken
    ? {}
    : { Authorization: `Bearer ${cachedToken}` };
  const res = await fetch(`${API_BASE}${path}`, { headers, signal });
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  }
  return res.json();
}

/**
 * POST request against the API.
 *
 * ALWAYS awaits `ensureToken()` first, so the first POST after page load
 * blocks until a token is cached. Uses a PER-REQUEST retry budget of 1: on
 * 401 we flush the cache, refetch once, and retry exactly once. Both 401
 * terminal paths (retries exhausted OR refetch failed) throw the same
 * `"Session expired — reload the page"` error with `status: 401, fatal: true`
 * — UI copy stays consistent across failure modes (R5-2 fix).
 *
 * @param {string} path - Path beginning with `/api/...`.
 * @param {any}    body - Request body; JSON-stringified with Content-Type set.
 * @returns {Promise<any>} Parsed JSON body.
 * @throws  On terminal 401: Error with `.status=401, .fatal=true`.
 * @throws  On other non-2xx: Error with `.status` set.
 */
export async function apiPost(path, body) {
  let token = await ensureToken();
  let retriesLeft = 1;
  while (true) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status !== 401 || retriesLeft === 0) {
      if (!res.ok) {
        if (res.status === 401) {
          throw Object.assign(
            new Error('Session expired — reload the page'),
            { status: 401, fatal: true }
          );
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      return res.json();
    }
    // 401 with retries remaining → token likely rotated (daemon restart).
    // Flush cache, refetch once, retry the request.
    retriesLeft--;
    cachedToken = null;
    try {
      token = await ensureToken();
    } catch {
      throw Object.assign(
        new Error('Session expired — reload the page'),
        { status: 401, fatal: true }
      );
    }
  }
}

/**
 * Update the local participant's display name via the daemon's MCP
 * `comms_update_name` tool (UX G-9 showstopper — wires the SettingsPanel
 * rename into the protocol layer instead of silently writing only to
 * localStorage).
 *
 * Transport: the daemon's FastMCP server runs with `stateless_http=True`
 * + `json_response=True`, so a one-shot JSON-RPC `tools/call` POST against
 * the `/mcp` endpoint succeeds without an initialize handshake. The
 * required `Accept` header includes both `application/json` and
 * `text/event-stream` because FastMCP's Streamable HTTP transport
 * negotiates against either; in JSON-response mode the body comes back
 * as plain JSON.
 *
 * No bearer token is attached — `comms_update_name` is invoked exactly
 * as an MCP client would invoke it, and the MCP layer authenticates by
 * matching `key` against the registry. (The bearer token in `apiPost`
 * gates writes against `/api/artifacts/*`, a separate surface.)
 *
 * Returns a stable result envelope rather than throwing, so the caller's
 * UI state machine (Saving → Saved / Error) can branch on a single field:
 *   - `{ success: true,  name, key }` on a successful rename.
 *   - `{ success: false, error: <human-readable string> }` on any failure,
 *     including network errors, HTTP non-2xx, JSON-RPC error objects, or
 *     the `comms_update_name` tool returning `{ status: 'error', ... }`.
 *
 * Timeout is 5s via `AbortController`. A v0.4.0 follow-up should add a
 * dedicated `POST /api/identity/name` REST endpoint so the browser does
 * not have to speak MCP JSON-RPC directly — see worklog for v0.3.3
 * Step 1.9 §9.
 *
 * @param {string} key      - The participant key (from `store.userProfile.key`).
 * @param {string} newName  - The desired display name.
 * @returns {Promise<{success: boolean, name?: string, key?: string, error?: string}>}
 */
export async function updateName(key, newName) {
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'Missing participant key.' };
  }
  if (!newName || typeof newName !== 'string' || !newName.trim()) {
    return { success: false, error: 'Name cannot be empty.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'comms_update_name',
          arguments: { key, new_name: newName },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { success: false, error: `Server returned HTTP ${res.status}.` };
    }

    const body = await res.json();
    if (body && body.error) {
      const msg = body.error.message || 'Server rejected the rename.';
      return { success: false, error: msg };
    }

    // FastMCP wraps tool returns in `result.structuredContent` (or
    // `result.content[0].text` for older clients). Try both.
    const result = body?.result || {};
    let payload = result.structuredContent;
    if (!payload && Array.isArray(result.content)) {
      const textBlock = result.content.find((c) => c && c.type === 'text');
      if (textBlock && typeof textBlock.text === 'string') {
        try {
          payload = JSON.parse(textBlock.text);
        } catch {
          payload = null;
        }
      }
    }

    if (!payload) {
      return { success: false, error: 'Server returned an empty response.' };
    }
    if (payload.status === 'error') {
      return { success: false, error: payload.error || 'Rename failed.' };
    }
    if (payload.status === 'updated' && payload.name) {
      return { success: true, name: payload.name, key: payload.key };
    }
    return { success: false, error: 'Unexpected server response.' };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { success: false, error: 'Request timed out.' };
    }
    const msg = err && err.message ? err.message : 'Network error.';
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generic FastMCP JSON-RPC `tools/call` helper used by v0.4.0+ channel
 * lifecycle methods in the store. Mirrors the transport pattern proven in
 * ``updateName`` (UX G-9 showstopper) but exposes a result envelope that
 * is uniform across MCP tools:
 *
 *   - ``{ success: true,  payload }``  - tool returned a structured payload
 *     in either ``result.structuredContent`` or
 *     ``result.content[0].text`` (parsed as JSON).
 *   - ``{ success: false, error }``    - any failure: network, HTTP non-2xx,
 *     JSON-RPC error object, timeout, missing payload, or the tool's own
 *     ``payload.status === 'error'``.
 *
 * No bearer token is attached. Authentication for MCP tools is via the
 * participant ``key`` argument (matched against the registry), same as
 * the rest of the MCP surface.
 *
 * Returns instead of throwing so callers' state machines (optimistic
 * update + rollback) can branch on a single field without nested
 * try/catch blocks.
 *
 * @param {string} toolName - MCP tool to invoke (e.g. ``comms_join``).
 * @param {object} args      - Tool arguments (camelCase or snake_case
 *   per the tool's signature).
 * @param {object} [opts]    - Optional knobs.
 * @param {number} [opts.timeoutMs=5000] - Abort timer in ms.
 * @param {AbortSignal} [opts.signal] - External abort signal; when it
 *   fires the underlying ``fetch`` aborts and the call resolves to a
 *   ``{ success: false, error: 'Aborted' }`` envelope.
 * @returns {Promise<{success: boolean, payload?: object, error?: string}>}
 */
export async function mcpCall(toolName, args, { timeoutMs = 5000, signal } = {}) {
  if (!toolName || typeof toolName !== 'string') {
    return { success: false, error: 'Missing tool name.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Bridge an externally supplied AbortSignal into the local controller so
  // the caller can cancel mid-flight (used by the 15s undo machinery).
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args || {},
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { success: false, error: `Server returned HTTP ${res.status}.` };
    }

    const body = await res.json();
    if (body && body.error) {
      const msg = body.error.message || 'Server rejected the call.';
      return { success: false, error: msg };
    }

    // FastMCP wraps tool returns in `result.structuredContent` (preferred)
    // or `result.content[0].text` (older clients). Try both.
    const result = body?.result || {};
    let payload = result.structuredContent;
    if (!payload && Array.isArray(result.content)) {
      const textBlock = result.content.find((c) => c && c.type === 'text');
      if (textBlock && typeof textBlock.text === 'string') {
        try {
          payload = JSON.parse(textBlock.text);
        } catch {
          payload = null;
        }
      }
    }

    if (!payload) {
      return { success: false, error: 'Server returned an empty response.' };
    }
    if (payload.status === 'error' || payload.error) {
      return { success: false, error: payload.error || payload.message || 'Tool returned an error.' };
    }
    return { success: true, payload };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { success: false, error: 'Aborted' };
    }
    const msg = err && err.message ? err.message : 'Network error.';
    return { success: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
