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
