# Artifact Improvements — Implementation Plan

**Status:** v11 — FINAL (Rounds 1-6 + Svelte 5 conventions + MCP tooling mandate + `svelte-file-editor` subagent delegation preferred, 45/45 adversarial findings accepted)
**Scope:** 10 improvements to the artifact subsystem, mostly web UI-facing.
**Target:** Post-implementation, the artifact panel is demo-grade polished and collaborators (human or AI) can comfortably author, edit, and review versioned documents.

---

## Executive summary

Ten improvements, implemented as one cohesive batch:

1. Real-time refresh of the artifact panel when create/update/delete events flow through chat
2. VSCode-style diff view between any two versions, with line numbers, color, inline char-level highlighting
3. Per-version author display (in the version dropdown)
4. Edit-in-place from the web UI (new REST endpoint, panel textarea, save path)
5. Extract `MCP_API_URL` into a shared `lib/api.js` module
6. Polished "no artifacts yet" empty state with actionable hint
7. Copy-to-clipboard + download-as-`.md` buttons in the detail view
8. More permissive artifact naming (uppercase, digits, `.`, `_`, `-`, 1–128 chars)
9. Markdown rendering of `plan` and `doc` types via a proper library + sanitization + syntax highlighting
10. Star/pin artifacts; starred ones float to the top of the list

---

## Library selections (April 2026)

Researched explicitly for this plan. Versions are **pinned exactly** in `package.json` (no caret prefixes) so a transitive patch update can't silently change the sanitizer behavior.

### Markdown (#9)

| Package | Version (pinned) | Purpose | ~gzip |
|---|---|---|---|
| `marked` | `18.0.2` | Parser (GFM by default) | ~12 KB |
| `dompurify` | `3.4.1` | HTML sanitizer (mandatory before `{@html ...}`) | ~21 KB |
| `shiki` | `3.0.0` (via `createHighlighterCore`) | Syntax highlighting inside code fences | ~80–110 KB realistic (see fallback) |
| `marked-highlight` | `2.2.1` | Bridge between marked and shiki | ~1 KB |

**Bundle size honesty:** Shiki's advertised "core-only" number understates real-world weight once one theme + typical langs are loaded. We plan for **80–110 KB gzipped** for Shiki alone and implement a graceful fallback: if a CI `bundle-size-check` step reports the markdown chunk exceeds 130 KB gzipped, the build fails and we drop langs from the eager set (starting with `markdown`, `python`) and lazy-load them on demand via dynamic import from the `markedHighlight` callback. Exact ceilings documented in the Verification section.

**Rationale:**
- `marked` over `markdown-it`: simpler API, smaller, equivalent maintenance. Extension model via `marked.use(...)` is idiomatic.
- `DOMPurify` over library-built-in: marked has no built-in sanitization; markdown-it's is partial. Don't trust partial.
- Shiki v3 over highlight.js/Prism: the 2025 JS engine path is ~4% of Oniguruma WASM. Prism is effectively unmaintained as of 2025. Use `cssVariables` theme mode (class-based) so our DOMPurify config doesn't need to allow `style` attributes (see §9).
- Render flow: `renderMarkdown()` returns sanitized HTML; the component injects via `{@html ...}`.

### Diff view (#2)

**Selection:** `diff@8.0.1` (jsdiff, pinned) + a custom Svelte 5 component for the VSCode-styled render. No wrapper library.

**Rationale:** control over theme tokens, accessibility, and future interactivity. `diff2html` would require CSS overrides anyway; the diff library adds only ~10–15 KB gzipped.

**Large-document protection:** diffing is gated by `total_chars` threshold (see §2 risks). When exceeded, the UI shows "diff too large" and offers per-version view instead of attempting to diff megabytes in the main thread.

### Artifact name validation (#8)

No library. **Split approach:** a simple regex for character-class validation, then targeted Python checks for reserved-name and structural rules (see §8). This is both easier to reason about and avoids regex catastrophic-backtracking shapes.

---

## Svelte 5 conventions (authoritative for all implementation agents)

This project uses **Svelte 5.42+** (April 2026 canonical). Implementation agents MUST follow these patterns. 2023/2024-era tutorials that contradict these are wrong — prefer the canonical docs at `svelte.dev/docs/svelte`.

### Mandatory tooling — Svelte MCP server + `svelte-file-editor` subagent

The `sveltejs/ai-tools` Svelte MCP server is installed. **The preferred approach for every `.svelte` / `.svelte.js` / `.svelte.ts` edit is to delegate to the `svelte-file-editor` subagent** — it has its own context window, already knows the docs-fetch + autofixer + write-to-disk loop, and won't consume the primary context with documentation lookups.

When delegating is impractical (tiny inline changes), the main-context agent MUST still follow the protocol:

1. **`list-sections`** — SKIP this call. The MCP server's system-reminder embeds the full pre-enumerated list of paths with `use_cases`; don't burn tokens re-listing.
2. **Try knowledge + `svelte-autofixer` first** — reach for `get-documentation` only when needed.
3. **`get-documentation`** — be stingy. Pick sections surgically by `use_cases` (`svelte/$effect`, `svelte/@attach`, `svelte/$props`, etc.) — each fetch is token-intensive.
4. **`svelte-autofixer`** — run on every emitted Svelte file; loop until ZERO issues AND ZERO suggestions. Skipping is a blocking condition.
5. **`playground-link`** — only when code is NOT going to disk AND the user confirms. Not applicable to this project (all code hits disk).

The `svelte:svelte-code-writer` and `svelte:svelte-core-bestpractices` skills are also available and should be loaded for any Svelte file work.

**The tools are ground truth.** If `svelte-autofixer` disagrees with this section, trust the tool. The conventions below are a summary for plan readers; the tool is the enforcer.

### File extensions

- **`.svelte`** — components
- **`.svelte.js`** — any helper module that DECLARES runes (e.g., `mqtt-store.svelte.js` uses `$state`)
- **`.js`** — helper modules that IMPORT from rune modules but declare none themselves (e.g., `lib/api.js`, `lib/markdown.js`, `lib/autoresize.js`)

### State (`$state`)

- `let x = $state(...)` — default for mutable reactive state, deep proxy
- `let x = $state.raw(...)` — for values that are only REASSIGNED, never mutated (large blobs, API responses). Mutation silently no-ops.
- `$state.snapshot(x)` — produces a plain non-reactive clone for interop (external libs, analytics, `structuredClone`)
- **Destructuring snapshots reactivity** — do not destructure `$state` values you need to stay reactive
- **Props are NOT state proxies by default.** Mutating a prop that isn't `$bindable()` throws `ownership_invalid_mutation` in dev.
- **`$state` can only be declared in `.svelte` or `.svelte.js` files.** Plain `.js` files can import state-containing modules but can't declare `$state` themselves.

### Derived (`$derived`)

- `let x = $derived(expr)` — single expression
- `let x = $derived.by(() => { ...; return value; })` — when you need statements/loops
- **No side effects inside `$derived`** — compile-time forbidden
- Only appears as a variable / class-field initializer

### Effects (`$effect`)

- `$effect(() => { ... })` — post-DOM-update side effects, the default
- `$effect.pre(() => { ... })` — rare; before DOM update (scroll restoration, pre-paint work)
- `$effect.root(() => { ... })` — manual scope, for effects outside component init
- **Cleanup:** return a function from the effect
- **`$effect.tracking()`** — query whether current execution is in a reactive context (for building abstractions)

### Async inside `$effect` — the stale-resolution pattern (REQUIRED)

**Never pass an async function directly to `$effect`.** Svelte does not coordinate resolution order in stable mode (experimental.async is not enabled for this project). Two acceptable patterns:

**Pattern A — monotonic token (correctness via snapshot):**

```js
let renderToken = 0;
$effect(() => {
  const t = ++renderToken;
  const src = selectedArtifact?.content;
  if (!src) { rendered = ''; return; }
  (async () => {
    const html = await renderMarkdown(src);
    if (t === renderToken) rendered = html;  // only apply if still current
  })();
});
```

**Pattern B — AbortController (correctness via cancellation):**

```js
$effect(() => {
  const ctrl = new AbortController();
  (async () => {
    try {
      const data = await apiGet(`/api/...`, { signal: ctrl.signal });
      if (!ctrl.signal.aborted) result = data;
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err);
    }
  })();
  return () => ctrl.abort();
});
```

Use **Pattern A** when the fetch is cheap and re-invocation is fine (markdown rendering, syntax highlighting). Use **Pattern B** when the fetch is expensive or has side effects that need explicit cancellation (chunked `fetchFullVersion`, long-running version loads).

**`$effect(async () => { ... })` is an anti-pattern in this codebase. Don't write it.** The compiler doesn't prevent it but stale resolution will bite.

### DOM attachments — `{@attach}` not `use:`

Svelte 5.29+ introduces `{@attach fn}` as the preferred replacement for `use:fn`. Use `{@attach}` for all new DOM wiring in this plan (autoresize, focus-trap, intersection observers, click-outside detection). Attachments are reactive, composable (inline/spread/on components), and the official direction.

```svelte
<!-- Preferred (Svelte 5.29+) -->
<textarea {@attach autoresize} class="artifact-editor"></textarea>

<!-- Legacy — still works but avoid for new code -->
<textarea use:autoresize class="artifact-editor"></textarea>
```

Attachment signature: `function autoresize(node) { ...; return cleanup }` — same shape as an action's setup, returning a single cleanup fn. For existing action-library interop, use `fromAction()` from `svelte/attachments`.

### Props + events

- `let { foo = 'default', ...rest } = $props()` — modern declaration
- `let { value = $bindable() } = $props()` — two-way binding, child side; parent does `bind:value={...}`
- **Callback props REPLACE `createEventDispatcher`** (deprecated in 5.x). Parent: `<Child onchange={(v) => ...} />`; child: `let { onchange } = $props(); onchange?.(newValue);`
- **Lowercase event props:** `onclick`, `onkeydown`, `oninput` — NOT `on:click`. Event modifiers (`|preventDefault`) are gone; implement in the handler body.

### Slots → Snippets

- `<slot />` still works but is deprecated. Use `{@render children()}` with the implicit `children` prop.
- Named slots: define via `{#snippet name(args)}...{/snippet}` in parent, render via `{@render name(args)}` in child.
- New code should use snippets exclusively.

### Class-based state stores (the store pattern for this project)

`MqttChatStore` already uses a class with `$state`-field properties. This is the canonical 2026 pattern for shared state:

```js
// mqtt-store.svelte.js
export class MqttChatStore {
  participants = $state({});
  artifactsDirty = $state(0);
  // derived getters
  get onlineCount() { return Object.values(this.participants).length; }
  // methods
  markSelfUpdate(name, version) { /* ... */ }
}
```

Instances are passed between components via props (or Svelte's context API for deeply-nested trees). Avoid module-level singleton `$state` — SvelteKit SSR has leak semantics we'd rather not step on.

**Private fields gotcha:** `$state.snapshot()` uses `.toJSON()` internally and cannot see `#private` fields. If we ever need to snapshot store state, use TS `private` keyword instead of `#`-prefixed fields.

### Testing Svelte 5 components

- Use Vitest + `@testing-library/svelte` + the `svelteTesting` plugin (already a de-facto default).
- Use `flushSync()` from `svelte` to force synchronous effect flush before assertions.
- `await tick()` still works for the default async flush path.
- For async-heavy components where JSDOM is flaky, consider `vitest-browser-svelte` for those specific suites.

### What old tutorials get wrong (don't copy from them)

| Legacy | Use instead |
|---|---|
| `let x = 0` (reactive) | `let x = $state(0)` |
| `$: doubled = x * 2` | `let doubled = $derived(x * 2)` |
| `$: { sideEffect(x) }` | `$effect(() => sideEffect(x))` |
| `export let foo` | `let { foo } = $props()` |
| `on:click={fn}` | `onclick={fn}` |
| `createEventDispatcher` | callback props |
| `<slot />` | `{@render children()}` |
| `use:action` | `{@attach attachment}` |
| `writable()` stores | class with `$state` fields |
| `beforeUpdate` / `afterUpdate` | `$effect.pre` / `$effect` |
| `on:click|preventDefault` | implement in handler body |

### `{@html}` + sanitization

Svelte 5 does NOT provide native XSS guards. Always sanitize untrusted content before `{@html}`:

```svelte
{@html DOMPurify.sanitize(markdownToHtml(userInput), PURIFY_CONFIG)}
```

Never pass unsanitized user content through `{@html}`. The sanitizer config is defined in `lib/markdown.js` (§9 — strict: no `style`, no event handlers, URL scheme allowlist, external-image interception).

---

## New config schema (R3-1 fix — consolidated)

Three new config keys and one env var, defined explicitly so implementation can't ambiguate them:

```yaml
# config.yaml additions
web:
  api_base: null                # str | null. If set, UI uses this as API origin (reverse-proxy/Tailscale Funnel case).
  allow_remote_edits: false     # bool. Feature flag for POST /api/artifacts (R3-6). Default off.
  ws_url: null                  # str | null. Explicit WebSocket URL; if null, derived from api_base or defaults to ws://127.0.0.1:9001.
```

Env var: `REVERSE_PROXY=1` — alternate to setting `web.api_base`. If either `web.api_base` is truthy OR `REVERSE_PROXY=1`, the daemon is in "reverse-proxy mode." In this mode:
- POST `/api/artifacts/{conv}/{name}` route is **not registered** at startup (R3-6 kill-switch AND R3-1 defense)
- Daemon logs on startup: `"Reverse-proxy mode: artifact edit-in-place disabled. Set web.allow_remote_edits=true and remove web.api_base to enable (local-host deployments only)."`
- Web UI sees 404 on POST attempts (and hides the Edit button per R3-2)

`web.allow_remote_edits: false` (the default) ALSO disables POST registration, even in direct mode. Users explicitly opt in to the feature after reviewing the threat model. Post-v1 we can flip the default.

**Tests:** `test_post_route_disabled_when_proxy_or_flag_off.py` covering (a) `web.api_base=null`, `allow_remote_edits=false` → no POST, (b) `api_base=null`, `allow_remote_edits=true` → POST present, (c) `api_base="https://x"`, `allow_remote_edits=true` → no POST (reverse-proxy wins), (d) `REVERSE_PROXY=1` env → no POST.

---

## Capabilities endpoint (R3-2 fix)

The UI must know deployment capabilities without guessing from failed POST responses. New endpoint:

```
GET /api/capabilities  →  { "writable": true|false, "features": { "markdown_render": true, "diff_view": true, ... } }
```

`writable` is the conjunction of the rules above: `allow_remote_edits AND NOT reverse_proxy_mode`. Same-origin, no auth, cacheable for 60s.

**Web UI integration:** `lib/api.js` exports `getCapabilities()` which fetches once on app start and caches in memory. The store exposes `capabilities` reactively. The Edit button's visibility gate becomes:

```js
editButtonVisible = $derived(
  store.capabilities?.writable
  && isLatestVersion
  && userKeyIsMember
);
```

When `writable === false`, the panel shows a small lock icon with tooltip "Editing disabled in this deployment — edit via MCP or CLI instead."

**Test:** frontend unit test that Edit button is hidden when `capabilities.writable === false`.

---

## Bearer token lifecycle (R3-4 fix)

- **Generated fresh on every daemon start.** Not persisted across restarts. This keeps the threat model small: a stale token can't outlive a restart, and developers can "rotate" by bouncing the daemon.
- **File path:** `~/.claude-comms/web-token` with `chmod 600`. Rewritten on each start.
- **UI fetch:** `GET /api/web-token` (loopback-only endpoint) returns `{ "token": "..." }`. Called on app load and on any 401. Cached in a module-level variable in `lib/api.js` — NOT localStorage (a malicious browser extension could read localStorage).
- **Bootstrap + 401 recovery flow (R4-1 fix):**

The v5 plan had two race-condition gaps: (a) no mechanism forcing the token to be cached before the first POST; (b) no explicit list of which endpoints are token-free, risking bootstrap deadlock; (c) per-request retry budget was implicit.

```js
// lib/api.js
let cachedToken = null;
let tokenPromise = null;  // shared in-flight fetch, so parallel callers don't thrash

// Endpoints that MUST remain token-free (bootstrap + public GETs).
// These are explicitly documented and tested.
const TOKEN_FREE_ENDPOINTS = new Set([
  '/api/web-token',     // cannot require the thing it provides
  '/api/capabilities',  // needed to decide whether the token is even relevant
  // Existing public GETs also remain token-free:
  // /api/messages/{channel}, /api/identity, /api/participants/{channel},
  // /api/conversations, /api/artifacts/{conv}, /api/artifacts/{conv}/{name}
]);

async function ensureToken() {
  if (cachedToken) return cachedToken;
  if (!tokenPromise) {
    tokenPromise = fetch(`${API_BASE}/api/web-token`)
      .then(r => { if (!r.ok) throw new Error(`token fetch ${r.status}`); return r.json(); })
      .then(({ token }) => { cachedToken = token; return token; })
      .finally(() => { tokenPromise = null; });
  }
  return tokenPromise;
}

function isTokenFree(path) {
  // Strip query string for comparison, then check prefix match for parameterised routes.
  const bare = path.split('?')[0];
  return TOKEN_FREE_ENDPOINTS.has(bare)
    || bare.startsWith('/api/messages/')
    || bare.startsWith('/api/participants/')
    || bare.startsWith('/api/artifacts/');  // GETs are token-free; only POST requires
}

export async function apiPost(path, body) {
  let token = await ensureToken();  // blocks first POST until token lands
  let retriesLeft = 1;               // PER-REQUEST budget (not global)
  while (true) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.status !== 401 || retriesLeft === 0) {
      if (!res.ok) {
        // R5-2 fix: 401 after retries exhausted emits the SAME "Session expired"
        // message as the refetch-failure path, so UI copy is consistent across failures.
        if (res.status === 401) {
          throw Object.assign(new Error('Session expired — reload the page'),
                              { status: 401, fatal: true });
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      return res.json();
    }
    // 401 → token rotated (daemon restart). Flush cache, refetch once, retry.
    retriesLeft--;
    cachedToken = null;
    try { token = await ensureToken(); }
    catch { throw Object.assign(new Error('Session expired — reload the page'), { status: 401, fatal: true }); }
  }
}

// R5-1 fix: App-mount prefetch handles its own rejection so an unavailable
// daemon at startup (still warming up) does NOT produce an unhandled-promise-rejection.
// The next apiPost() call will simply ensureToken() again on demand.
export function prefetchToken() {
  ensureToken().catch(err => {
    console.warn('[claude-comms] Token prefetch failed; will retry on first POST:', err);
  });
}

export async function apiGet(path) {
  // Token-free GETs: no Authorization header (avoids unnecessary cache invalidation).
  // Token-required GETs (none in v1, but future-proof): attach if cached.
  const headers = isTokenFree(path) || !cachedToken
    ? {}
    : { Authorization: `Bearer ${cachedToken}` };
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}
```

**App-startup prefetch (R6-5 fix — spec/code consistency):** on app mount (in `App.svelte`), call `prefetchToken()` — **NOT** `ensureToken()` directly. `prefetchToken` is the rejection-handled wrapper that suppresses unhandled-rejection logs if the daemon is still warming up. The next `apiPost()` call transparently refetches if the prefetch failed.

**Tests added:**
- `immediate POST before token fetch settles → one clean POST, no observable 401` (bootstrap)
- `per-request retry budget: two unrelated 401s in the same session both get ONE retry each` (budget is not shared)
- `GET /api/web-token + /api/capabilities never carry Authorization` (bootstrap deadlock prevention)
- **R5-1:** `prefetch hits 503 at mount → no unhandled rejection, next apiPost transparently refetches` (daemon-warmup tolerance)
- **R5-2:** `401 retry exhausted → error.message === "Session expired — reload the page"` AND `refetch fails → same error.message` (error copy consistency on both paths)

- **Documented threat model (in USAGE.md + risks here):** "Any process running as the same UNIX user can read `~/.claude-comms/web-token` and impersonate the web UI. This is acceptable for single-user developer workstations. Do not deploy `claude-comms` on shared multi-user hosts with `allow_remote_edits=true`."

**Tests:** `test_bearer_token_regenerated_on_restart.py`, `test_post_without_bearer_401.py`, frontend `api.spec.js` covering the 401-retry flow.

---

## CSP dynamic connect-src (R3-3 fix)

CSP is constructed at daemon startup from the resolved config, not hard-coded:

```python
def build_csp(config: dict) -> str:
    api_origin = config.get("web", {}).get("api_base") or f"http://127.0.0.1:{config['mcp']['port']}"
    ws_origin = (
        config.get("web", {}).get("ws_url")
        or (api_origin.replace("http", "ws") + "/mqtt" if config.get("web", {}).get("api_base")
            else f"ws://127.0.0.1:{config['broker']['ws_port']}")
    )
    connect_src = f"'self' {api_origin} {ws_origin}"
    return (
        f"default-src 'self'; "
        f"script-src 'self'; "
        f"style-src 'self' 'unsafe-inline'; "
        f"img-src 'self' data:; "
        f"connect-src {connect_src}; "
        f"frame-ancestors 'none'; "
        f"base-uri 'self'; "
        f"form-action 'self'"
    )
```

Injected as response header by the static file server when serving `index.html`. WebSocket URL scheme (`ws:` vs `wss:`) is derived from the API base's scheme — explicitly documented: "changing MQTT host in config requires daemon restart to pick up new CSP."

**Test:** Playwright smoke test in reverse-proxy mode asserts the MQTT WebSocket connects (no CSP violation in browser console).

---

## External-image blocking — wiring (R3-5 fix)

v3 plan described a DOMPurify hook but didn't specify (a) where the click handler lives, (b) hook registration scope. Fixed:

**Hook registration — module top-level, runs exactly once per page load:**

```js
// lib/markdown.js — OUTSIDE any function, fires on import
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    const isExternal = /^https?:/i.test(src) && !src.startsWith(window.location.origin);
    if (isExternal) {
      node.setAttribute('data-external-src', src);
      node.setAttribute('src', '');
      node.setAttribute('alt', 'External image blocked — click to load');
      node.classList.add('external-image-blocked');
    }
  }
});
```

**Click handler — delegated, attached by panel:**

```svelte
<!-- ArtifactPanel.svelte -->
<script>
  let mdContainer;
  $effect(() => {
    if (!mdContainer) return;
    const handler = (e) => {
      const img = e.target.closest?.('img.external-image-blocked[data-external-src]');
      if (!img) return;
      e.preventDefault();
      img.setAttribute('src', img.getAttribute('data-external-src'));
      img.classList.remove('external-image-blocked');
      img.removeAttribute('alt');
    };
    mdContainer.addEventListener('click', handler);
    return () => mdContainer.removeEventListener('click', handler);
  });
</script>

<div class="artifact-md-body" bind:this={mdContainer}>{@html rendered}</div>
```

**Global-policy documentation:** "External-image blocking applies to all `renderMarkdown()` calls in the app." Tests verify the hook is active across two sequential renders (no regression).

---

## Per-improvement design

### 1. Real-time panel refresh

**Trigger:** chat message with `artifact_ref` field (already set by backend system messages on create/update/delete).

**Implementation:**
- In `mqtt-store.svelte.js`, when a new message lands with `msg.artifact_ref` set AND `msg.conv === activeChannel`, bump a reactive counter `store.artifactsDirty++`.
- In `ArtifactPanel.svelte`, a `$effect` watches `store.artifactsDirty` and re-fetches the list (debounced by 150 ms to coalesce bursts).

**Concurrency-safe behavior when the user is actively editing (R2-4 fix):**

The naive design auto-refreshes whenever the counter ticks, which would silently clobber a user's in-progress textarea content if a remote update landed mid-edit. Instead:

- **Not editing** → refresh list + refresh detail if it matches `artifact_ref`.
- **Editing (`editMode === true`) AND incoming `msg.artifact_ref === editingName`** → do NOT auto-refresh the textarea. Show a non-destructive inline banner. User explicitly picks. Never auto-clobber.

**Remote-update banner visual spec:**

- **Placement:** floating at top of the panel detail area, above the textarea (pushes textarea down by banner height + 8px gap). Full width of the panel body.
- **Height:** 48px (fixed, content uses flex row centered vertically).
- **Background:** `var(--bg-elevated)` with `border-left: 3px solid var(--ember-500)` (primary accent, reads as "heads up" not "alarm").
- **Animation:** slides in from top, 200ms ease-out. Wrapped in `@media (prefers-reduced-motion: reduce) { animation: none; }` — the banner appears instantly for users with motion sensitivity.
- **Auto-dismiss:** 30 seconds if the user takes no action.
- **Manual dismiss:** always-visible `X` close button on the far right of the banner, lucide `X` icon, 16px, 24x24 hit target, `aria-label="Dismiss remote-update notice"`. Keyboard-accessible (included in tab order, Enter/Space activates). Esc keystroke while banner has focus also dismisses. Dismissing does NOT alter the textarea or edit mode — it just hides the banner. If another remote update for the SAME artifact arrives after dismissal, a fresh banner reappears (stale bans should not suppress new alerts).
- **Content layout:** icon (AlertCircle from lucide) + text "{senderName} updated this artifact to v{N}" + three action buttons + close button.
- **Action buttons (relabeled for clarity per UX review):**
  - **"View changes"** — primary action. Exits edit mode (with a confirm dialog if textarea has unsaved changes), loads v{N} into view mode. User can re-enter edit from the new baseline.
  - **"Keep editing (theirs will be overwritten)"** — secondary. Stays in edit mode with the CURRENT text. Next save will conflict-retry with the new base_version, but user stays in control. The ambiguous v4 "Merge" label is replaced.
  - **"Discard my edit"** — destructive-styled. Exits edit mode, throws away textarea content, refreshes to v{N}.
- **Focus management + state preservation (R4-8 + R5-4):** banner receives programmatic focus on appear (for screen readers + keyboard users). Before moving focus, save the textarea's `selectionStart`, `selectionEnd`, `scrollTop`, and the panel body's `scrollTop` to `preBannerState`.

  **R5-4 fix — state is restored on EVERY path that returns focus to the textarea**, not just "Keep editing":
  - **Keep editing** button → restore `preBannerState`, focus textarea
  - **X close button** → restore `preBannerState`, focus textarea
  - **Esc on focused banner** → restore `preBannerState`, focus textarea
  - **30s auto-dismiss** (user never interacted) → restore `preBannerState`, focus textarea
  - **User directly clicks back into textarea** → banner unmounts; restore from `preBannerState` one more time in case any intermediate event altered scroll
  - **View changes** → do NOT restore (user explicitly left edit mode)
  - **Discard my edit** → do NOT restore (user explicitly chose to lose state)

  `preBannerState` is captured exactly once when the banner takes focus; cleared only after the banner is fully unmounted.

  Tab order: banner text → View changes → Keep editing → Discard my edit → X close button → back to textarea.
  Axe scan matrix includes `prefers-reduced-motion: reduce` variants of every covered panel state, not just default motion.

  **Test:** scroll textarea to line 100, trigger banner, press Esc, assert `textarea.scrollTop === 100` and `selectionStart === <saved value>`. Repeat for X-button click and 30s auto-dismiss paths.
- **Accessibility:** `role="status"`, `aria-live="assertive"` — users need to know immediately that their work is about to be affected.
- **De-duping our own POST against the incoming MQTT echo:** the v2 plan's single `skipRefreshUntil = response.version` counter breaks under multi-artifact, out-of-order resolution. Replace with a keyed TTL-based Set:

```js
// Map<`${artifactName}:${version}`, expiryTimestamp>
const recentlySelfUpdated = new Map();

function markSelfUpdate(name, version) {
  const expiry = Date.now() + 5000;
  recentlySelfUpdated.set(`${name}:${version}`, expiry);
  pruneExpired();
}

function isOurRecentUpdate(name, version) {
  pruneExpired();
  return recentlySelfUpdated.has(`${name}:${version}`);
}

function pruneExpired() {
  const now = Date.now();
  for (const [k, e] of recentlySelfUpdated) if (e < now) recentlySelfUpdated.delete(k);
}
```

**Module ownership (R5-6 fix):** the `recentlySelfUpdated` Map AND its two helper methods are **exports of `mqtt-store.svelte.js`**, not the panel. This prevents Batch 3 agents from racing each other on file edits, and gives the store — which owns the MQTT message handler — the authority to consult the Map before bumping `artifactsDirty`.

```js
// mqtt-store.svelte.js — new exports on the store class
// (not standalone module functions; methods on MqttChatStore so they can
// access other store state if future logic needs it)
class MqttChatStore {
  #recentlySelfUpdated = new Map();  // Map<"${name}:${version}", expiryMs>

  markSelfUpdate(name, version) {
    this.#recentlySelfUpdated.set(`${name}:${version}`, Date.now() + 5000);
    this.#pruneSelfUpdated();
  }

  isOurRecentUpdate(name, version) {
    this.#pruneSelfUpdated();
    return this.#recentlySelfUpdated.has(`${name}:${version}`);
  }

  #pruneSelfUpdated() {
    const now = Date.now();
    for (const [k, e] of this.#recentlySelfUpdated) {
      if (e < now) this.#recentlySelfUpdated.delete(k);
    }
  }
}
```

**Call-site contract:**
- **Panel save-success handler** (Batch 3, task K, consumer-only) → `store.markSelfUpdate(name, response.version)` immediately after receiving the POST response, BEFORE the MQTT system message arrives.
- **Store's MQTT handler** (Batch 3, task I, owner) → checks `this.isOurRecentUpdate(name, version)` for incoming `artifact_ref` messages; if true, skips the "remote update" banner trigger (still bumps `artifactsDirty` for normal list refresh).

**Batch-3 ownership edges (R5-6 dependency declaration):**

Tasks I, J, K all touch `mqtt-store.svelte.js` and `ArtifactPanel.svelte`. To avoid git-merge conflicts and ensure the cross-module contract holds:

- **Task I** (real-time refresh + star/pin in list view) **OWNS** `mqtt-store.svelte.js` edits: adds `artifactsDirty` state, adds the 3 self-update helpers, adds MQTT handler branch for `artifact_ref`. Also owns ArtifactPanel list-view edits.
- **Task J** (detail view chrome + markdown) OWNS the detail-view section of ArtifactPanel.svelte. No store edits.
- **Task K** (edit-in-place) OWNS the edit flow of ArtifactPanel.svelte. Calls into the store's methods defined by Task I. **Depends on Task I completing first.**

Declare: **K blocked-by I**. J and I may run in parallel; K runs after I. This is the minimal serialization that preserves correctness.

**Test:** two artifacts updated simultaneously (one local, one remote) — banner fires for remote only, not for local.

### 2. Diff view (VSCode-style)

**Placement:** detail view, above the content area. A segmented control toggle `[ Content | Diff ]` (Carbon Ember-styled pill, 2 buttons, active state has ember underline + `color: var(--text-primary)`; inactive `color: var(--text-muted)`).

**UX spec:**

- **Default comparison when toggling into Diff mode:** auto-picks `v(N-1)` — the version immediately before the currently-viewed one. User can change via the second dropdown.
- **Second version selector appearance:** when Diff is active, a secondary dropdown appears to the LEFT of the existing version dropdown, labeled "Compare:". Same styling as the primary dropdown. Layout: `[Compare: v2 ▾]  →  [v3 ▾]   [ Content | Diff ]  [Copy] [Download]` in the detail header.
- **v1-only case:** the "Diff" half of the toggle is disabled (reduced opacity, `cursor: not-allowed`, `aria-disabled="true"`) with tooltip "Only one version — nothing to diff yet."
- **Axis convention:** **left = older, right = newer** (matches git/GitHub/VSCode). Header above the diff table reads `v{from} → v{to}` with a `→` arrow glyph.
- **Scroll sync:** both columns scroll together (shared scroll container, single `overflow: auto` wrapper; the table itself spans the full height). At narrow widths (<600px) → unified view, no sync concern.
- **Empty diff (identical content, rare edge case):** shows centered text "No differences between v{from} and v{to}" instead of an empty table.

**Correct content assembly (chunked reads):**

`comms_artifact_get` returns a **50 KB chunk** with `has_more` and `next_offset`. The v1 plan had a latent bug of diffing only the first chunk. Corrected flow:

```js
async function fetchFullVersion(channel, name, version) {
  let content = '';
  let offset = 0;
  while (true) {
    const data = await apiGet(`/api/artifacts/${channel}/${name}?version=${version}&offset=${offset}`);
    content += data.content;
    if (!data.has_more) return { content, meta: data };
    offset = data.next_offset;
  }
}
```

Additionally, a per-artifact-version **LRU cache** (limit 8 entries) in the panel prevents re-fetching when the user flips between two versions. Cache invalidated when `artifactsDirty` ticks for that name.

**Too-large guard:** if the resulting `total_chars` for either version exceeds **200 000** characters, the panel refuses to diff and shows a clear "Diff too large — view versions individually" message. This protects the main thread from multi-second diff computations.

**Component structure (`ArtifactDiff.svelte`):** two-column table, line numbers on each side, `+` / `-` gutter, inline char-level highlight within changed lines via `diffWords`.

**CSS theme tokens (with cssVariables theme from Shiki so the app theme controls colors):**
- Removed lines background: `rgba(248,81,73,0.12)`, darker char highlight `rgba(248,81,73,0.35)`
- Added lines background: `rgba(63,185,80,0.12)`, darker char highlight `rgba(63,185,80,0.35)`
- Line numbers column: right-aligned, `color: var(--text-faint)`, `border-right: 1px solid var(--border)`
- Monospace font: `ui-monospace, Menlo, Consolas, monospace`

**Narrow-viewport fallback:** at panel widths < 600 px, switch to unified view (single column with interleaved +/- lines).

### 3. Per-version author display

Version dropdown rows show version + author + timestamp (+ summary when present). No API change — data is already in the `versions` array.

**Row layout (single line, three columns):**

```
[ v3 ]  claude-ember  ·  2h ago · "initial version"
 └──┘   └──────────┘     └──────────────────────┘
 32px   flex:1, 14px      14px faint, truncate
 label  colored by key    ellipsis on overflow
```

- **Version label:** fixed-width 32px, right-aligned, `color: var(--text-muted)`, font-size 12px, monospace for alignment.
- **Author name:** flex-1, `color: {getParticipantColor(author.key).textColor}`, font-size 14px, truncate with ellipsis at ~140px so long names don't push out the meta.
- **Meta (time + summary):** `color: var(--text-faint)`, 14px, truncate with ellipsis, takes remaining width. Format: `{relativeTime} · "{summary}"`. If no summary, just `{relativeTime}`.
- **Time format:** relative if < 7 days (`5m ago`, `2h ago`, `3d ago`), absolute otherwise (`Apr 22`). Use the existing `formatTime` helper if it supports this, else add a small helper.
- **Active version:** checkmark at left, highlight background `var(--bg-surface)`.
- **Dropdown trigger button** (what shows when closed): `v3 · claude-ember · 2h ago` in one line, truncated similarly.

### 4. Edit-in-place from the web UI

**New REST endpoint:** `POST /api/artifacts/{conv}/{name}` with body `{ key, content, base_version? }`. Server calls `tool_comms_artifact_update` (server still accepts an optional `summary` param for MCP callers, but the web UI does not capture one — Phil's UX decision: version-number increment alone is enough).

**Authentication / access control (R1-1 + R2-1 + R2-2 + R2-3 fix):**

Three layered defenses — each alone is insufficient, together they form the real security model:

**Defense 1 — Bearer token (primary auth).** On daemon startup, `cli.py` generates a 32-byte URL-safe random token and writes it to `~/.claude-comms/web-token` with `chmod 600`. The daemon serves the token at `GET /api/web-token`, which is itself **loopback-only** (rejects if `request.client.host not in {"127.0.0.1", "::1"}`). The web UI fetches this on first load (same-origin from the daemon's static server → always loopback) and caches it in memory (not localStorage — a malicious extension could read localStorage). Every subsequent POST requires `Authorization: Bearer <token>`. Missing/invalid → 401.

**Defense 2 — Participant registry cross-check.** The POST body's `key` field must be registered in the `ParticipantRegistry` AND joined to the target conversation. This is authorization on top of authentication — a valid token doesn't grant write access to a conversation the caller didn't join.

**Defense 3 — Reverse-proxy awareness.** In reverse-proxy deployments (`web.api_base` set in config, or `REVERSE_PROXY=1` env var), `request.client.host` is always `127.0.0.1` regardless of the real client, making loopback checks worthless. In that mode, the daemon **refuses to register the POST route entirely** at startup and logs a warning: "Artifact edit-in-place disabled: reverse-proxy mode detected. Use CLI/MCP for edits." The UI detects 404 on POST and shows the clear "Remote edits not supported in this deployment" message. `X-Forwarded-For` / `X-Real-IP` headers are **never** consulted — they are trivially spoofable.

**CORS (R2-3 fix — exact-match, no substring):** The existing GET handlers use a buggy `substring in origin` check (`o in request.headers.get("origin", "")`) that can be bypassed (e.g., `http://evil.com/http://127.0.0.1:9921`). Rewrite all CORS origin handling (GET and the new POST) to:

```python
def _resolve_cors_origin(request: Request, allow_list: list[str]) -> str | None:
    origin = request.headers.get("origin", "")
    return origin if origin in allow_list else None
```

If this returns `None`, **omit** `Access-Control-Allow-Origin` from the response (the browser will block the read). Never fall back to `cors_origins[0]` as the current code does — that's the bug.

**CSRF protection:** Because POST uses `Content-Type: application/json`, browsers will preflight and the fixed CORS check above will reject cross-origin attempts. Additionally the Bearer token is not accessible from non-same-origin JS. Test: forged Origin header, cross-origin POST from a non-listed origin must fail at CORS.

**Related tests (extend R1-10 test list):**
- `test_artifact_post_endpoint.py`: spoofed `X-Forwarded-For`, reverse-proxy mode disables route, invalid token → 401, valid token + wrong conv member → 403, exact-match CORS rejects forged origin, substring-match attack origin rejected.

**Panel flow:**

- **Edit button:** shows in detail view header **only when** viewing latest version AND the current user's key has joined the conversation AND `capabilities.writable === true`. Lucide `Pencil` icon, icon-only (24x24) with tooltip "Edit artifact". Placed in the header between the version dropdown and the Copy/Download buttons.

- **Entering edit mode — textarea replaces the content area in place:**
  - Same container as the view mode body. Swaps from `<div class="artifact-md-body">` (or `<pre>`) to `<textarea class="artifact-editor">`.
  - Textarea: `width: 100%`, `min-height: 320px`.
  - Font: `ui-monospace, Menlo, Consolas, monospace`, 13px, line-height 1.5 — matches how the content typically reads when it's code or markdown.
  - Padding 12px, `background: var(--bg-deepest)`, `border: 1px solid var(--border)`, border turns ember on focus.
  - Above the textarea, a small banner-strip reads: `Editing v{N} · next save = v{N+1}` in `color: var(--text-muted)`, `font-size: 12px`.

- **Auto-grow height (R4-2 fix — concrete fallback for browsers without `field-sizing: content`):**

  The v5 plan referenced `field-sizing: content` (Chrome 123+, Safari 18.2+; Firefox still behind a flag as of April 2026) with a vague "ResizeObserver fallback." Firefox users would otherwise see a 4-row default. Fix: ship a Svelte action that handles auto-resize deterministically across all browsers:

  ```js
  // lib/autoresize.js
  // R5-5 fix: observing document.body fires on every layout change and risks
  // ResizeObserver loops. Instead: observe the banner specifically (when present)
  // and listen to window resize — the only two things that actually change
  // the viewport math we care about. rAF-throttled to hard-cap one recalc per frame.
  export function autoresize(node) {
    let rafHandle = null;
    let lastBannerNode = null;
    let bannerObserver = null;

    const recalc = () => {
      const banner = document.querySelector('.remote-update-banner');
      const bannerH = banner ? banner.offsetHeight + 8 : 0;
      const maxH = Math.min(window.innerHeight - 320 - bannerH, 720);
      node.style.height = 'auto';
      node.style.height = `${Math.min(node.scrollHeight, maxH)}px`;
    };

    const schedule = () => {
      if (rafHandle !== null) return;  // already scheduled this frame
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        recalc();
      });
    };

    // Watch for banner element coming/going so we can (re-)observe its size.
    const rebindBannerObserver = () => {
      const current = document.querySelector('.remote-update-banner');
      if (current === lastBannerNode) return;
      if (bannerObserver) bannerObserver.disconnect();
      lastBannerNode = current;
      if (current) {
        bannerObserver = new ResizeObserver(schedule);
        bannerObserver.observe(current);
      } else {
        bannerObserver = null;
      }
      schedule();
    };

    // R6-3 fix: MutationObserver scoped to direct children ONLY (no subtree).
    // Banner is a direct child of the panel body per the §1 spec, so this
    // catches mount/unmount without reacting to every markdown re-render,
    // toast animation, or dropdown-state change in the subtree.
    const mo = new MutationObserver(rebindBannerObserver);
    const mutationRoot = node.parentElement || document.body;
    mo.observe(mutationRoot, { childList: true, subtree: false });
    // NOTE: if the banner ever moves to a nested container, update this scope
    // accordingly. A runtime assert guards against that drift:
    if (import.meta.env?.DEV) {
      setTimeout(() => {
        const found = document.querySelector('.remote-update-banner');
        if (found && found.parentElement !== mutationRoot) {
          console.warn('[autoresize] banner is not a direct child of the panel body — MutationObserver scope mismatch');
        }
      }, 500);
    }

    const onInput = () => schedule();
    const onResize = () => schedule();
    node.addEventListener('input', onInput);
    window.addEventListener('resize', onResize);
    rebindBannerObserver();
    schedule();  // initial

    return {
      destroy() {
        if (rafHandle !== null) cancelAnimationFrame(rafHandle);
        node.removeEventListener('input', onInput);
        window.removeEventListener('resize', onResize);
        if (bannerObserver) bannerObserver.disconnect();
        mo.disconnect();
      },
    };
  }
  ```

  **Test (R5-5):** mount textarea, toggle banner 10× rapidly, assert no `ResizeObserver loop` console warnings AND final textarea height matches the no-banner computation.

  Used as `<textarea {@attach autoresize} class="artifact-editor">` (Svelte 5.29+ `@attach` idiom, preferred over `use:` per the Svelte 5 conventions section). The helper lives at `web/src/lib/autoresize.js` (plain `.js` — no runes; the rune-free module is imported by components that ARE `.svelte`). `field-sizing: content` may be applied as a CSS enhancement — when supported, the browser's native behavior matches and the attachment becomes a no-op (no harm). The attachment owns correctness; `field-sizing` is only a progressive improvement.

- **Save / Cancel buttons:** BELOW the textarea, right-aligned, 12px gap. Save is the primary (ember background, dark text). Cancel is secondary (transparent, bordered).
  - Save label: `Save (v{N+1})` — exact next version number shown so there's no surprise.
  - Cancel label: `Cancel`.

- **Keyboard shortcuts:**
  - **`Cmd+Enter`** (or `Ctrl+Enter` on Windows/Linux) → triggers Save.
  - **`Esc`** → triggers Cancel (with confirmation dialog if the textarea content differs from the original).
  - Listener attached to the textarea only (doesn't interfere with global shortcuts).

- **Esc precedence (R4-3 fix):** the banner, version dropdown, and textarea all respond to Esc. Explicit precedence, each layer calls `event.stopPropagation()` so only one handler fires:
  1. If a confirm dialog is open → dialog handles it (closes dialog).
  2. Else if the remote-update banner has focus → banner's X-button-equivalent handler dismisses the banner.
  3. Else if the version dropdown listbox is open → dropdown closes.
  4. Else if edit mode is active AND textarea has focus → Cancel fires (with dirty-check confirm).
  5. Else → global app Esc (closes the artifact panel entirely).
  - Test: when banner takes focus and user presses Esc, banner dismisses AND textarea remains in edit mode with content intact (propagation stopped).

- **On Save success:** update local state from response body (new version, author, timestamp), exit edit mode, brief toast "Saved as v{N+1}" (bottom-right, 2s auto-dismiss). `markSelfUpdate(name, newVersion)` called to dedupe the incoming MQTT system message.

- **On 409 conflict:** the remote-update banner (see §1) appears at the top of the detail area describing the conflict, with the same three actions. User picks; never silent overwrite.

- **On 403 / 404 (writes disabled):** instead of showing a broken Edit button, the `capabilities.writable === false` check hides it entirely. If somehow the POST still fails with 403, show toast "Remote edits are disabled in this deployment." Edit mode exits; no state change.

- **On 401:** bearer-token retry flow (see Bearer token lifecycle section). Transparent to the user unless retry also fails — then "Session expired — reload the page."

- **Dirty-state protection:** if the user tries to switch artifacts, toggle diff, or close the panel while editing with changes, show a confirm dialog: "Discard unsaved changes?" — matches standard editor UX.

### 5. `lib/api.js` (+ honest host derivation)

New file `/home/plafayette/claude-comms/web/src/lib/api.js` (plain `.js`, NOT `.svelte.js` — no runes in this module):

```js
function deriveApiBase() {
  if (typeof window === 'undefined') return '';
  // If a <meta name="claude-comms-api-base" content="..."> is present, use that.
  // This is the authoritative override, served by the daemon's static file
  // server so reverse-proxy / Tailscale Funnel deployments can set it explicitly.
  const meta = document.querySelector('meta[name="claude-comms-api-base"]');
  if (meta && meta.content) return meta.content.replace(/\/+$/, '');

  const { hostname, port, protocol } = window.location;
  // Dev mode (Vite on 5173/5174): same-origin with Vite proxying /api/*.
  if (port === '5173' || port === '5174') return '';
  // Production bundled on 9921 hitting MCP on 9920.
  if (port === '9921') return `${protocol}//${hostname}:9920`;
  // Anything else → assume same-origin (reverse proxy forwards /api/* to daemon).
  return '';
}

export const API_BASE = deriveApiBase();

export async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

export async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}
```

The exported symbol is renamed `API_BASE` (from `MCP_API_URL`) because it's used for non-MCP endpoints too (REST). Existing call sites update.

Daemon's static file server gets a tiny change: serve the `index.html` with `<meta name="claude-comms-api-base" content="{web.api_base}">` injected when the config has `web.api_base` set (optional, for reverse-proxy deployments).

### 6. Polished empty state

Centered stack within the panel body area. Minimum vertical space of 300px; content vertically centered.

- **Icon:** `FileText` from lucide-svelte, 48px, `color: var(--text-faint)`, `opacity: 0.6`. Not clickable.
- **Heading:** "No artifacts yet" — 16px, 600 weight, `color: var(--text-primary)`, 16px margin-top from icon.
- **Body copy:** "Artifacts are shared, versioned documents for plans, specs, and code. Any agent or collaborator with an MCP tool can create one. Once created, you can edit and compare versions here." — 13px, `color: var(--text-muted)`, `line-height: 1.6`, `max-width: 280px`, text-align center, 8px margin-top from heading.
- **Link:** "Read the artifact guide →" — 13px, `color: var(--ember-400)`, underline on hover. 16px margin-top from body. `href="https://github.com/Aztec03hub/claude-comms/blob/main/USAGE.md#artifacts"`, opens in new tab (`target="_blank"`, `rel="noopener"`).
- **Responsive:** at narrow panel widths, max-width shrinks proportionally; no scrolling required.

### 7. Copy + download buttons

Icon-only buttons in the detail view header, right-aligned, to the right of the version dropdown (and to the right of the Edit button when present). Ordered: `[Compare ▾]  [v3 ▾]  [Content|Diff]  [Edit]  [Copy]  [Download]  [Close X]`.

- **Copy button:** lucide `Clipboard` icon, 20px, 32x32 hit target. Tooltip: "Copy content". `aria-label="Copy artifact content to clipboard"`.
  - Click → `navigator.clipboard.writeText(currentVersionContent)`.
  - Transient state: icon briefly swaps to `Check` for 1.2s, button background gets `var(--ember-500)` tint; also fires the bottom-right toast `Copied!` (2s auto-dismiss) for redundancy + screen reader announcement via the global `aria-live` toast region.
- **Download button:** lucide `Download` icon, 20px, 32x32 hit target. Tooltip: "Download as file". `aria-label="Download artifact"`.
  - Click → Blob with `currentVersionContent`, triggers download via a programmatically-created `<a download="{name}-v{version}.{ext}">`. `ext` mapping: `plan` / `doc` → `.md`; `code` → `.txt` (or language-inferred when we add metadata support later).
  - No toast — the browser's download shelf is feedback enough.

Both buttons: pure client-side, no API change.

### 8. Permissive artifact naming — Windows-filesystem-compatible

Phil's decision: names should support anything the Windows filesystem supports. This is significantly broader than the v4 plan's `[A-Za-z0-9._-]` — we now allow spaces, most punctuation, emoji-free Unicode is fine too. The only hard constraints are the characters Windows itself forbids.

**Step 1 — character-class regex (broad allow, explicit deny):**

```python
# Reject: NUL + control chars, plus Windows-forbidden chars: < > : " / \ | ? *
# Also reject: backtick (shell quoting hazard), newline, tab (whitespace confusion)
ARTIFACT_NAME_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*`\n\r\t]')
```

Any character not in the forbidden set is allowed. That includes: A-Z, a-z, 0-9, space, `.`, `_`, `-`, `!`, `@`, `#`, `$`, `%`, `&`, `(`, `)`, `+`, `,`, `;`, `=`, `[`, `]`, `^`, `{`, `}`, `~`, apostrophe, and non-ASCII printable Unicode. 

**Step 2 — structural checks (`validate_artifact_name()`):**

```python
WINDOWS_RESERVED = frozenset({
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
})

import unicodedata

def validate_artifact_name(name: str) -> tuple[bool, str]:
    """Returns (is_valid, error_message). Empty error means valid.
    
    R4-7 hardening: NFC-normalize to eliminate macOS HFS+ NFD collisions;
    reject `.json` suffix (on-disk name collision risk);
    reject fullwidth confusables (e.g. U+FF0F fullwidth slash).
    """
    if not name:
        return False, "name cannot be empty"
    # R4-7: Normalize to NFC. Store and compare the normalized form so
    # e.g. `café` (NFC) and `café` (NFD) can't coexist as "different" artifacts.
    name = unicodedata.normalize("NFC", name)
    if len(name) > 128:
        return False, "name exceeds 128 characters"
    if ARTIFACT_NAME_FORBIDDEN.search(name):
        return False, 'name contains a forbidden character (< > : " / \\ | ? * or control char)'
    # R4-7: Reject confusable fullwidth chars (U+FF00–U+FFEF) — they render
    # indistinguishably from ASCII in many fonts and are a phishing vector.
    if any(0xFF00 <= ord(c) <= 0xFFEF for c in name):
        return False, "name contains confusable fullwidth characters"
    # Windows silently strips trailing dot / space → file collision risk.
    if name.endswith(".") or name.endswith(" "):
        return False, "name cannot end with a dot or space"
    # Leading space is confusing and some filesystems reject it.
    if name.startswith(" ") or name.startswith("."):
        return False, "name cannot start with a space or dot"
    if ".." in name:
        return False, "name cannot contain '..'"
    # R4-7: Reject `.json` suffix to prevent `foo.json` input producing
    # on-disk `foo.json.json` and future collision with a user creating `foo.json.json`.
    if name.lower().endswith(".json"):
        return False, "name cannot end with '.json' (reserved by storage format)"
    # Windows reserves the stem (part before first dot). E.g. CON.txt collides with CON.
    stem = name.split(".", 1)[0].upper()
    if stem in WINDOWS_RESERVED:
        return False, f"name {name!r} conflicts with Windows reserved device name"
    return True, ""
```

**URL encoding at transport (client-side):** because names can contain spaces, `&`, `?`, `%`, etc., the web UI must `encodeURIComponent(name)` when constructing URLs like `/api/artifacts/{conv}/{name}`. The server's Starlette path parameter handling decodes automatically. Shell users invoking MCP tools pass the raw name as a JSON string, not a URL path — no encoding needed there.

**On-disk naming convention (R4-7 + R5-3):**

Each artifact is stored at `{data_dir}/{conversation}/{nfc_normalized_name}.json`. The `.json` suffix is part of the storage format and is NEVER included in the artifact's user-facing name. Validation rejects `.json`-suffixed input to prevent `foo.json.json` on-disk files and ambiguous collisions.

**R5-3 fix — NFC normalization must be applied at EVERY entry point**, not just `validate_artifact_name` and `_artifact_path`. A single helper, `_normalize_name`, is added to `artifact.py` and called at every user-name → filesystem-name boundary:

```python
import unicodedata

def _normalize_name(name: str) -> str:
    """Canonical name form used for on-disk paths and in-memory identity."""
    return unicodedata.normalize("NFC", name)

def _artifact_path(conversation: str, name: str, data_dir: Path) -> Path:
    return data_dir / conversation / f"{_normalize_name(name)}.json"

def load_artifact(conversation: str, name: str, data_dir: Path) -> Artifact | None:
    path = _artifact_path(conversation, _normalize_name(name), data_dir)  # idempotent
    ...

def delete_artifact(conversation: str, name: str, data_dir: Path) -> bool:
    path = _artifact_path(conversation, _normalize_name(name), data_dir)
    ...

# And on the Artifact Pydantic model: enforce that the stored `name` is always NFC.
class Artifact(BaseModel):
    name: str = Field(...)
    ...
    @field_validator("name")
    @classmethod
    def _enforce_nfc(cls, v: str) -> str:
        return _normalize_name(v)
```

**One-time startup migration for pre-existing NFD files (macOS HFS+ fresh installs):**

```python
# artifact.py
def migrate_artifact_names_to_nfc(data_dir: Path) -> tuple[int, int]:
    """Rename any NFD artifact files to NFC form. Idempotent.
    Collisions are QUARANTINED, not left in place (R6-2 fix) — otherwise
    the collision produces two in-memory Artifact records with the same
    NFC name, breaking identity downstream.
    
    Returns (renamed_count, quarantined_count). Runs at daemon startup.
    """
    if not data_dir.is_dir():
        return 0, 0
    renamed = 0
    quarantined = 0
    quarantine_root = data_dir / ".nfc-migration-quarantine"
    for conv_dir in data_dir.iterdir():
        if not conv_dir.is_dir() or conv_dir.name.startswith("."):
            continue
        for json_file in conv_dir.glob("*.json"):
            stem = json_file.stem
            nfc = unicodedata.normalize("NFC", stem)
            if nfc == stem:
                continue
            target = json_file.with_name(f"{nfc}.json")
            if target.exists():
                # R6-2: quarantine the NFD file — do NOT leave it next to
                # the NFC version. Otherwise list_artifacts() would build
                # two Artifact records that the Pydantic NFC validator
                # then collapses to the same name — split-brain.
                q_dir = quarantine_root / conv_dir.name
                q_dir.mkdir(parents=True, exist_ok=True)
                q_target = q_dir / json_file.name
                json_file.rename(q_target)
                logger.warning(
                    "NFC migration: collision on %s; quarantined NFD file to %s",
                    target, q_target,
                )
                quarantined += 1
                continue
            json_file.rename(target)
            logger.info("NFC migration: renamed %s → %s", json_file.name, target.name)
            renamed += 1
    if quarantined > 0:
        logger.warning(
            "NFC migration quarantined %d file(s). Review %s and reconcile manually.",
            quarantined, quarantine_root,
        )
    return renamed, quarantined
```

**R6-2 behavior:** the migration never leaves a "twin" NFD file next to its NFC collision target; it always moves to `{data_dir}/.nfc-migration-quarantine/{conversation}/{original_name}.json`. Logged prominently at startup. Admin reconciles manually.

Called once from `create_server()` in `mcp_server.py` before the registry is populated. Logs each rename.

**`list_artifacts` is safe as-is** because it reads filename stems from disk — post-migration, all stems are NFC — and stores them directly into `Artifact.name` (which the new `_enforce_nfc` validator normalizes defensively). But we run the migration once on startup to ensure the invariant holds.

**Tests added:**
- `test_nfc_migration.py`: create an NFD-filename fixture on disk, run migration, verify rename to NFC
- `test_load_artifact_accepts_nfd_name`: caller passes NFD name, load_artifact normalizes internally, returns the artifact
- `test_artifact_name_field_auto_normalizes`: construct `Artifact(name="café_NFD", ...)`, assert `.name` is NFC after construction
- `test_migration_idempotent`: run migration twice, second pass does nothing
- **R6-2:** `test_nfc_migration_collision_quarantines`: create both NFD and NFC forms on disk, run migration, verify NFD file moved to `.nfc-migration-quarantine/`, NFC file untouched, `list_artifacts` returns exactly one record

**Case-collision protection (R1-6 fix, unchanged):** NTFS / HFS+ treat `Foo` and `foo` as the same file. On create:

```python
existing_lower = {a["name"].lower() for a in list_artifacts(conversation, data_dir)}
if name.lower() in existing_lower:
    return _error(f"Artifact name {name!r} collides (case-insensitive) with an existing artifact.")
```

**Symlink / realpath defense (R1-6, unchanged):**

```python
real_artifact_dir = os.path.realpath(str(data_dir))
candidate = os.path.realpath(str(data_dir / conversation / f"{name}.json"))
if not candidate.startswith(real_artifact_dir + os.sep):
    return _error("Artifact path resolves outside the data directory.")
p = Path(candidate).parent
while p != Path(real_artifact_dir) and p != p.parent:
    if p.is_symlink():
        return _error("Artifact path contains a symlink.")
    p = p.parent
```

**Error messages:** `validate_artifact_name` returns `(bool, str)` so the specific failure bubbles to the UI unchanged. Error messages are surfaced via the existing `_error()` helper in `mcp_tools.py`.

**Expanded test corpus for `test_artifact_naming.py`:**
- VALID: `Notes`, `my-plan`, `API Spec v2`, `project_alpha.md`, `Q&A session`, `план` (Unicode), `build (2026-04)`, `x` (single char), `a.b.c.d` (multiple dots OK), 128-char string at the cap
- INVALID: empty, 129-char string (over cap), `CON`, `con.txt` (reserved stem), `PRN.log`, `name.` (trailing dot), `name ` (trailing space), ` name` (leading space), `.hidden` (leading dot), `foo..bar` (double dot), `bad/slash`, `bad\backslash`, `bad:colon`, `bad"quote`, `bad<lt>`, `bad>gt`, `bad|pipe`, `bad?q`, `bad*star`, `bad\x00null`, `bad\nnewline`, `Foo` + `foo` collision
- Minimum **30 cases** covering the full space.

**Migration:** existing names (all lowercase-alphanumeric + hyphens from the old regex) all pass the new validator. No data migration needed.

### 9. Markdown rendering (with correct Shiki sanitizer config)

R1-4 fix: Shiki v3 emits inline `style` attributes by default, which DOMPurify's default config strips. Either allow `style` (broad and risky) or — better — use **Shiki's class-based cssVariables theme** so no inline styles are produced and DOMPurify's default config works unchanged.

**Module:** new `/home/plafayette/claude-comms/web/src/lib/markdown.js` (plain `.js` — R1-8 fix):

```js
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import DOMPurify from 'dompurify';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// R4-4 fix: `@shikijs/themes/css-variables` is NOT a package export in Shiki v3.
// The correct API is `createCssVariablesTheme` from `shiki/core`, which builds
// a theme object that emits `var(--shiki-token-*)` references. Blindly importing
// the (nonexistent) theme file would silently break every code block in the app.
import { createCssVariablesTheme } from 'shiki/core';

const cssVarsTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  variableDefaults: {
    // Fallbacks if the host app hasn't set the variables yet.
    foreground: '#c9c5bd',
    background: '#0e0e11',
    'token-constant': '#c084fc',
    'token-string': '#34d399',
    'token-comment': '#4a4540',
    'token-keyword': '#f59e0b',
    'token-parameter': '#c9c5bd',
    'token-function': '#67e8f9',
    'token-string-expression': '#34d399',
    'token-punctuation': '#9a9489',
    'token-link': '#fbbf24',
  },
  fontStyle: true,
});

// R4-5 fix: if the highlighter promise REJECTS, null it out so the next caller
// retries. v5 plan cached the Promise permanently — a transient failure
// (corrupt install, flaky dynamic import) would poison highlighting app-wide.
let highlighterPromise = null;
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [cssVarsTheme],
      langs: [
        import('@shikijs/langs/typescript'),
        import('@shikijs/langs/javascript'),
        import('@shikijs/langs/bash'),
        import('@shikijs/langs/python'),
        import('@shikijs/langs/json'),
      ],
      engine: createJavaScriptRegexEngine(),
    }).catch(err => {
      highlighterPromise = null;     // retry on next call
      console.warn('[claude-comms] Shiki init failed, will retry on next call:', err);
      throw err;
    });
  }
  return highlighterPromise;
}

let mdConfigured = false;
async function configureMarked() {
  if (mdConfigured) return;
  const hl = await getHighlighter();
  marked.use(markedHighlight({
    async: true,
    async highlight(code, lang) {
      try {
        return hl.codeToHtml(code, { lang: lang || 'text', theme: 'css-variables' });
      } catch {
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      }
    },
  }));
  marked.setOptions({ gfm: true, breaks: false, async: true });
  mdConfigured = true;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[ch]);
}

// Sanitizer config: strict. No `style` attr. No event handlers. javascript:
// URLs forbidden. Classes preserved (default). Shiki's css-variables theme
// uses class selectors only, so this works without loosening.
const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

export async function renderMarkdown(source) {
  await configureMarked();
  const raw = await marked.parse(source || '');
  return DOMPurify.sanitize(raw, PURIFY_CONFIG);
}
```

**Accompanying CSS contract** — scoped under `.artifact-md-body` in `ArtifactPanel.svelte`'s style block (using `:global(.artifact-md-body h1)` etc. since the HTML is injected via `{@html}`):

```css
.artifact-md-body :global(h1) {
  font-size: 18px; font-weight: 600; color: var(--text-primary);
  margin: 0 0 12px; line-height: 1.3;
}
.artifact-md-body :global(h2) {
  font-size: 16px; font-weight: 600; color: var(--text-primary);
  margin: 20px 0 8px; line-height: 1.35;
}
.artifact-md-body :global(h3) {
  font-size: 14px; font-weight: 600; color: var(--text-primary);
  margin: 16px 0 6px;
}
.artifact-md-body :global(h4) {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  margin: 14px 0 6px;
}
.artifact-md-body :global(p) {
  font-size: 13px; line-height: 1.6; color: var(--text-secondary);
  margin: 0 0 10px;
}
.artifact-md-body :global(a) {
  color: var(--ember-400); text-decoration: none;
}
.artifact-md-body :global(a:hover) { text-decoration: underline; }
.artifact-md-body :global(ul), .artifact-md-body :global(ol) {
  padding-left: 20px; margin: 0 0 10px;
}
.artifact-md-body :global(li) { margin: 4px 0; font-size: 13px; line-height: 1.55; }
.artifact-md-body :global(table) {
  border-collapse: collapse; margin: 10px 0; font-size: 13px;
}
.artifact-md-body :global(th), .artifact-md-body :global(td) {
  border: 1px solid var(--border); padding: 6px 10px; text-align: left;
}
.artifact-md-body :global(th) {
  background: var(--bg-surface); font-weight: 600;
}
.artifact-md-body :global(blockquote) {
  border-left: 3px solid var(--ember-600);
  padding: 4px 12px; margin: 8px 0;
  color: var(--text-muted); font-style: italic;
}
.artifact-md-body :global(code:not(pre code)) {
  /* inline code — differentiate from block code */
  background: var(--bg-elevated); padding: 1px 6px; border-radius: 4px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px; color: var(--ember-300);
}
.artifact-md-body :global(pre) {
  /* Shiki-generated code blocks — container only; internal coloring is Shiki's */
  margin: 10px 0; border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  overflow-x: auto;
}
.artifact-md-body :global(hr) {
  border: none; border-top: 1px solid var(--border); margin: 16px 0;
}
.artifact-md-body :global(img.external-image-blocked) {
  /* R2-6 click-to-load placeholder */
  background: var(--bg-elevated); border: 1px dashed var(--border);
  padding: 24px; cursor: pointer; color: var(--text-muted);
  font-size: 12px; text-align: center; width: 100%;
  box-sizing: border-box; border-radius: var(--radius-sm);
}
```

**Shiki `cssVariables` theme mapping — scope at `:root` (R4-6 fix):**

The v5 plan scoped the CSS variables to three class names including `.chat-code-block`, but the refactored `CodeBlock.svelte` renders `.code-block-wrap` (keeping the existing class). Rather than thread class names through three call sites, scope the variables at `:root` so every rendered code block picks them up via inheritance:

```css
:root {
  --shiki-foreground: var(--text-primary);
  --shiki-background: var(--bg-deepest);
  --shiki-token-constant: #c084fc;        /* matches current hl-number purple */
  --shiki-token-string: #34d399;          /* matches current hl-string green */
  --shiki-token-comment: var(--text-faint); /* matches current hl-comment */
  --shiki-token-keyword: var(--ember-400);  /* matches current hl-keyword ember */
  --shiki-token-parameter: var(--text-primary);
  --shiki-token-function: #67e8f9;        /* matches current hl-type cyan */
  --shiki-token-string-expression: #34d399;
  --shiki-token-punctuation: var(--text-muted);
  --shiki-token-link: var(--ember-300);
}
:root[data-theme="light"] {
  --shiki-foreground: #3d3530;
  --shiki-background: #f8f6f3;
  --shiki-token-constant: #9333ea;
  --shiki-token-string: #059669;
  --shiki-token-comment: #b5b0a8;
  --shiki-token-keyword: var(--ember-600);
  --shiki-token-function: #0891b2;
}
```

These values are chosen to match — not diverge from — the current `CodeBlock.svelte` Carbon Ember palette, so unifying on Shiki preserves the existing aesthetic. Global scope is safe because the variables are namespaced (`--shiki-*`) and only consumed by Shiki's generated HTML.

**Usage:**

```svelte
<script>
  import { renderMarkdown } from '../lib/markdown.js';
  let rendered = $state('');
  let renderToken = 0;  // monotonic guard against stale resolution

  // NOTE: sync $effect with an IIFE — NEVER $effect(async () => ...).
  // See "Svelte 5 conventions" section for rationale.
  $effect(() => {
    const t = ++renderToken;
    const src = selectedArtifact?.content;
    const type = selectedArtifact?.type;
    const isMd = type === 'plan' || type === 'doc';
    if (!src || !isMd) { rendered = ''; return; }
    (async () => {
      const html = await renderMarkdown(src);
      if (t === renderToken) rendered = html;   // only apply if still current
    })();
  });
</script>

{#if (selectedArtifact?.type === 'plan' || selectedArtifact?.type === 'doc') && rendered}
  <div class="artifact-md-body">{@html rendered}</div>
{:else}
  <pre class="artifact-raw-body">{selectedArtifact?.content ?? ''}</pre>
{/if}
```

### 10. Star/pin artifacts

**Storage:** localStorage per user, key `claude-comms:${identityKey}:starred-artifacts` (R2-8 scoped) → `{ [conversation]: [name, ...] }`. Purely client-side preference. No server changes.

**UX spec:**

- **Star icon placement:** right side of each artifact row in the list view, aligned with the type badge. 16x16 icon button within a 24x24 hit target. `lucide` `Star` (outline, `color: var(--text-faint)`) or `Star` with `fill="currentColor"` (filled, `color: var(--ember-400)` ember-gold) when starred.
- **Visibility:** default `opacity: 0.3` (unobtrusive). On row hover → `opacity: 1.0`. When starred → always `opacity: 1.0` regardless of hover.
- **Click isolation:** the star button has its own click handler with `event.stopPropagation()` — clicking the star toggles star state without opening the artifact detail view.
- **`aria-label`:** dynamic — `"Star artifact {name}"` when unstarred, `"Unstar artifact {name}"` when starred. `aria-pressed="true|false"` toggles correctly.
- **"Starred" section:** appears at the TOP of the list ONLY when at least one artifact in the current conversation is starred. Section header: `STARRED` in the same style as existing `ONLINE` / `OFFLINE` section headers (10px, letter-spacing 1.2px, uppercase, `color: var(--text-faint)`, 10px top padding, 6px bottom padding). Not collapsible (small section, doesn't need it).
- **Below Starred:** a subtle divider (`border-bottom: 1px solid var(--border)`), then the unstarred list under an implicit header or no header.
- **Star toggle animation:** none. Switches state immediately. (Animated fade-in/fade-out on keyed each blocks in Svelte 5 is fiddly and adds little value for a preference that's rarely toggled.)
- **Reconciliation on mount:** per R2-8, the panel reconciles the stored star list against fetched artifacts; any starred-name that no longer exists is pruned from localStorage silently.
- **Cap:** 500 starred entries per conversation (FIFO drop).

---

## Accessibility (R2-5 — new section)

Keyboard, focus, screen reader, and color-contrast support across all new UI. Nothing in the v2 plan addressed this; added now as a blocking gate.

**Diff view:**
- Gutter always shows `+` / `-` / `=` glyphs in addition to color (red/green color-blindness affects ~8% of men; color alone fails).
- Diff row backgrounds (`rgba(248,81,73,0.12)`, `rgba(63,185,80,0.12)`) and text foregrounds must pass WCAG AA **4.5:1 for text, 3:1 for UI boundaries** when composited against `var(--bg)`. Validated via automated contrast check in CI.
- Inline char-level highlight (`rgba(…,0.35)`) gets an additional underline or bold treatment for non-color signaling.

**Version dropdown:**
- `role="listbox"`, `aria-expanded`, `aria-activedescendant` on trigger
- Arrow Up / Arrow Down move selection within the list; Enter commits; Escape closes
- Focus returns to the trigger button when closed

**Edit mode:**
- On open: programmatic focus to the textarea; set `aria-label="Editing {title}"`
- On Cancel: focus returns to the Edit button
- On conflict banner appearance: banner has `tabindex="-1"`, `role="status"`, `aria-live="assertive"` (for edit conflicts specifically — users need to know immediately), focus is programmatically moved to the banner so screen readers announce it and keyboard users can tab into its options

**Toasts (copy success, etc.):**
- Render inside `<div role="status" aria-live="polite" aria-atomic="true">` in the app root
- Auto-dismiss timing (2s) is non-blocking; keyboard Esc dismisses manually

**Copy/Download/Star buttons:**
- Explicit `aria-label` attributes ("Copy artifact content to clipboard", "Download as markdown", "Toggle star")
- Star state reflected via `aria-pressed` toggle

**Blocking CI gate:** add `@axe-core/playwright` (or Vitest + axe-core) scan of the panel's key states (list empty, list populated, detail view, detail + diff, detail + edit, conflict banner open) as a build-failing check.

---

## Security headers — CSP (R2-7 — new section)

Defense-in-depth against a sanitizer regression. A strict CSP blocks XSS even if DOMPurify misses a vector.

Daemon's static file server injects these response headers for the `index.html` request:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:9920 ws://127.0.0.1:9001; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
```

Notes:
- `style-src 'unsafe-inline'` is required because Svelte injects scoped styles at runtime. Post-v1 we can investigate a nonce-based approach.
- `img-src 'self' data:` allows local images and data-URLs for icons but blocks external beacons (see R2-6 external-image protection below). No `http:` in img-src.
- `connect-src` lists the MCP and WebSocket endpoints explicitly; add the reverse-proxy host if `web.api_base` is configured.
- When `web.api_base` is set, the daemon constructs the `connect-src` list dynamically from that value.

**Test:** Playwright test that asserts the CSP meta/header is present and that injecting `<script>window.xss=1</script>` as markdown content produces no `window.xss` global (both because DOMPurify strips it AND because CSP blocks inline script).

---

## External image blocking in markdown (R2-6 fix)

Even sanitized markdown can embed `<img src="http://attacker/beacon?...">` which leaks the viewer's IP and a read-receipt to third parties. DOMPurify by default allows `<img>` with any URL scheme. Fix at two layers:

**Layer 1 — Tighten `ALLOWED_URI_REGEXP`:**

```js
ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i
```

Rejects `file:`, `blob:`, `javascript:`, `data:` (for href). Permissive for http/https/relative — necessary for normal links — but paired with Layer 2 for images.

**Layer 2 — External-image interception via `afterSanitizeAttributes` hook:**

```js
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (/^https?:/i.test(src) && !src.startsWith(window.location.origin)) {
      // External image: rewrite to placeholder, stash real URL on data-*
      node.setAttribute('data-external-src', src);
      node.setAttribute('src', ''); // breaks the load
      node.setAttribute('alt', 'External image blocked — click to load');
      node.classList.add('external-image-blocked');
    }
  }
});
```

Panel CSS styles `.external-image-blocked` as a click-to-load placeholder. Click handler reads `data-external-src` and replaces `src` (user consent). This matches Signal/Matrix/Gmail behavior.

**XSS test corpus additions (beyond R1-10):**
- `<img src="http://attacker/beacon?user=foo">` → should be blocked/placeholder'd, no network request
- `<img src="file:///etc/passwd">` → src stripped
- `<a href="file:///etc/passwd">` → href stripped (regex rejects)
- `<img src="blob:...">` → blocked
- `<img src="data:image/svg+xml,%3Cscript%3E..."` → blocked (no `data:` in img allowlist; CSP fallback blocks too)

---

## Async render race condition (R2-10 fix)

The `$effect(async () => { ... rendered = await renderMarkdown(...) })` pattern has a stale-resolution race: switching artifacts A → B can resolve A's (slower) render AFTER B's, showing B's metadata with A's body.

**Fix — monotonic token:**

```js
// In ArtifactPanel.svelte
let renderToken = 0;
$effect(() => {
  const t = ++renderToken;
  const src = selectedArtifact?.content;
  if (!src) { rendered = ''; return; }
  (async () => {
    const html = await renderMarkdown(src);
    if (t === renderToken) rendered = html;   // guard: only apply if still current
  })();
});
```

**Test:** `web/tests/markdown-render-race.spec.js` — call `renderMarkdown` twice with deliberately throttled resolution (first call's highlighter delayed 200ms, second 20ms) and assert the second call's result wins. Add to Vitest suite.

---

## Scoped localStorage for starred artifacts (R2-8 fix)

**Before (v2 plan):** `claude-comms-starred-artifacts` — one global key.

**After:** `claude-comms:${identityKey}:starred-artifacts` — scoped per identity.

**Additional hygiene:**
- On panel mount, reconcile the stored star list against the fetched artifact list; drop stars for names that no longer exist.
- Per-conversation cap of 500 entries (drop oldest when exceeded).
- When a user changes identity (e.g., `comms_update_name` or config change), the key changes and old stars remain accessible if they re-identify. Stale keys from abandoned identities are left in localStorage (acceptable) but the panel never reads them.

---

## Chunked-read safety (R2-9 fix)

The `fetchFullVersion` loop must be bounded. A misbehaving or malicious daemon returning non-advancing `next_offset` would otherwise hang the UI forever.

```js
const MAX_CHUNKS = 20;             // 20 × 50 KB = 1 MB ceiling
const MAX_TOTAL_CHARS = 250_000;   // hard abort if content grows beyond

async function fetchFullVersion(channel, name, version, signal) {
  let content = '';
  let offset = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const data = await apiGet(
      `/api/artifacts/${channel}/${name}?version=${version}&offset=${offset}`,
      { signal },
    );
    if (data.next_offset != null && data.next_offset <= offset) {
      throw new Error('Chunked read failed: non-advancing next_offset');
    }
    content += data.content;
    if (content.length > MAX_TOTAL_CHARS) {
      throw new Error(`Artifact exceeds ${MAX_TOTAL_CHARS} char limit for diff view`);
    }
    if (!data.has_more) return { content, meta: data };
    offset = data.next_offset;
  }
  throw new Error('Chunked read exceeded MAX_CHUNKS');
}
```

The `AbortController` is tied to component unmount so navigating away during a long fetch cancels the in-flight request.

**Test** in `web/tests/diff-chunked.spec.js`: stub with (a) legitimate multi-chunk response, (b) non-advancing `next_offset`, (c) ever-growing content, (d) abort mid-fetch.

---

## Concurrency: version counter correctness (R1-2 fix)

The existing `tool_comms_artifact_update` computes `current_version = len(artifact.versions)` then `new_version = current_version + 1`. **This breaks after pruning** at `MAX_VERSIONS = 50`: `len` stays 50 forever, new versions all get number 51, and the base_version concurrency check reports "current is v50" even when the user is looking at v73.

**Fix:**
- Change `current_version = max((v.version for v in artifact.versions), default=0)` in both the current-version readout AND the concurrency comparison.
- Optional (not for this PR): add a top-level `next_version` counter on the Artifact model for O(1) lookup; migration-free because it can be derived on first load.

**Test:** `test_artifact_update_after_pruning` — simulate 55 updates, verify version 56 is correctly assigned and base_version checks succeed.

---

## Version pinning & CI size check (R1-9 fix)

All new dependencies are pinned **exactly** in `package.json` (not caret):

```json
"dependencies": {
  "marked": "18.0.2",
  "marked-highlight": "2.2.1",
  "dompurify": "3.4.1",
  "shiki": "3.0.0",
  "diff": "8.0.1"
}
```

**CI bundle size check** added to the build pipeline:

- `index-*.js` ≤ 180 KB gzipped (current baseline + budget for this work)
- `vendor-markdown-*.js` (new chunk via Vite `manualChunks`) ≤ 130 KB gzipped
- `vendor-diff-*.js` ≤ 25 KB gzipped
- CI step fails the build if any ceiling is exceeded. Document in `CONTRIBUTING.md` that raising ceilings requires review.

**Fallback ladder** if `vendor-markdown` exceeds 130 KB gzipped:
1. Drop `python` from eager-loaded langs, lazy-load via dynamic import from `highlight()` callback.
2. Drop `json`, `bash` similarly.
3. As last resort, drop Shiki entirely and switch to `highlight.js` common bundle (~40 KB gzipped). Document the switch in a regression note.

---

## Test coverage — the new tests (R1-10 fix)

**Python:**

- `tests/test_artifact_naming.py` — the new regex + reserved-name + case-collision + realpath defense cases. At least 20 cases including: `CON`, `con.txt`, `PRN.log`, `name.` (trailing dot), `name-` (trailing hyphen), `Foo` + `foo` collision, `..` sequence, `.hidden`, 128-char name, 129-char name, unicode attempts.
- `tests/test_artifact_update_after_pruning.py` — 55 updates, verify version counter and base_version check.
- `tests/test_artifact_post_endpoint.py` — POST loopback-only enforcement (mocked request.client.host for remote), POST with key not in registry, POST with conflict, POST happy path.

**Vitest (new, currently no JS tests):**

- `web/tests/markdown-xss.spec.js` — OWASP XSS corpus against `renderMarkdown()`:
  - `<img src=x onerror=alert(1)>` — stripped
  - `[click](javascript:alert(1))` — URL rejected
  - `<script>alert(1)</script>` — tag stripped
  - `<iframe src=...>` — tag stripped
  - `<style>...</style>` — tag stripped
  - `<a href="data:text/html,...">` — URL rejected (falls outside ALLOWED_URI_REGEXP)
  - `<p onclick="alert(1)">click</p>` — onclick stripped
  - markdown link with `javascript:` URL — URL rejected
  - A benign nested GFM table + code fence — survives intact

- `web/tests/diff-chunked.spec.js` — fetch a 120 KB version (3 chunks), verify full content is assembled before `diffLines`, verify result contains expected line counts.

All new tests are blocking gates in the Verification section.

---

## NEW: Shiki unification (refactor `CodeBlock.svelte`)

**Scope of replacement:**

1. **`CodeBlock.svelte` custom tokenizer** — the `highlightLine()` regex + hardcoded `kwSet` (~52 keywords biased toward JS/Python) gets deleted entirely. The component's chrome (header with language label, copy button, line numbers column, hover effects, dark/light theme CSS) stays unchanged.
2. **Chat message fenced code blocks** — MessageBubble.svelte already routes code fences to `<CodeBlock>`; that routing is unchanged. But CodeBlock's internals now call Shiki, so every code fence in chat gets proper grammar-based highlighting automatically.
3. **Artifact `code`-type body** — previously rendered in a bare `<pre>`. Now rendered via the same CodeBlock component or a shared sub-component that wraps Shiki.
4. **Artifact `plan` / `doc` markdown, fenced code blocks within them** — already covered by `marked-highlight` bridge to Shiki (§9). No additional work; Shiki is invoked uniformly via `lib/markdown.js`'s highlighter.

**What doesn't change:**
- Mention parsing, URL detection, LinkPreview (all in MessageBubble) — unrelated.
- CodeBlock's header chrome (language label pill, copy button, animation) — kept.
- Line number column rendering — kept; Shiki output is unwrapped and split into lines that we render with our own line-number column.

**Refactor approach:**

```svelte
<!-- CodeBlock.svelte (after refactor) -->
<script>
  import { Copy, Check } from 'lucide-svelte';
  import { highlightCode } from '../lib/markdown.js';  // new export

  let { language = '', code = '', lines = [] } = $props();
  let copied = $state(false);

  let codeText = $derived(lines.length ? lines.join('\n') : code);
  let highlightedLines = $state([]);
  let renderToken = 0;

  $effect(() => {
    const t = ++renderToken;
    highlightCode(codeText, language).then(htmlLines => {
      if (t === renderToken) highlightedLines = htmlLines;
    });
  });

  function copyCode() {
    navigator.clipboard.writeText(codeText);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }
</script>

<div class="code-block-wrap">
  <div class="code-block-header">
    <span class="code-lang">{language || 'code'}</span>
    <button class="code-copy-btn" class:copied onclick={copyCode} aria-label={copied ? 'Copied' : 'Copy'}>
      ...
    </button>
  </div>
  <pre class="code-block">
    {#each highlightedLines as html, i}
      <span class="line"><span class="line-num">{i + 1}</span><span class="line-code">{@html html}</span></span>
    {/each}
  </pre>
</div>
```

**New export** `highlightCode(code, lang) -> Promise<string[]>` in `lib/markdown.js`:

```js
export async function highlightCode(code, lang) {
  const hl = await getHighlighter();
  try {
    const html = hl.codeToHtml(code, {
      lang: lang || 'text',
      theme: 'css-variables',
    });
    // Shiki wraps in <pre><code>...</code></pre> with per-line spans.
    // We want just the inner line HTMLs so CodeBlock can render its own line-number column.
    // Extract lines from the <code> body; one per \n.
    const inner = html.replace(/^<pre[^>]*><code[^>]*>/, '').replace(/<\/code><\/pre>$/, '');
    return inner.split('\n');
  } catch {
    // Unknown language or parsing error — fall back to escaped plain text.
    return escapeHtml(code).split('\n');
  }
}
```

**Fallback behavior:** if Shiki doesn't know the language (rare, but possible — user writes ` ```rust-analyzer ` which isn't a grammar ID), the catch block returns escaped plain text. Better than throwing.

**Bundle accounting:** we already include Shiki for artifacts (§9). Wiring up chat's CodeBlock adds ~0 KB — same library, same singleton highlighter instance cached in module scope.

**Benefits delivered:**
- Chat messages get VSCode-quality highlighting for 200+ languages (up from JS/Python with known cross-contamination bugs).
- Artifact code blocks match chat code blocks match markdown code blocks — one look, one codebase.
- Theming: the Carbon Ember palette drives all three via the CSS variable mapping (§9).
- Maintenance: delete ~60 LOC of hand-tuned tokenizer + keyword list; Shiki maintains grammars upstream.

**Tests added:**
- `web/tests/code-block-shiki.spec.js` — assert that Python `def foo():` gets `keyword` class styling (not just treated as identifier), Rust `fn main() {}` same, TypeScript generics `<T>` handled, unknown language `gibberish` falls back to escaped plain text.

---

## Implementation batches

### Batch 1 — foundations (parallel, ~25 min)
- **A:** Extract `API_BASE` to `lib/api.js` (#5) + `apiGet` / `apiPost` / `ensureToken` / `prefetchToken` helpers + update importers (store, ArtifactPanel, ConversationBrowser).
- **B:** Server-side Windows-permissive artifact name validation (#8) in `artifact.py` + `test_artifact_naming.py` with 30+ cases. Includes `_normalize_name()` helper, Pydantic `@field_validator` NFC enforcement on `Artifact.name`, `migrate_artifact_names_to_nfc()` with collision-quarantine (R6-2), wired into `create_server()`.
- **C:** Server plumbing for edit: new config keys (`web.api_base`, `web.allow_remote_edits`, `web.ws_url`), `REVERSE_PROXY` env var; `GET /api/capabilities` endpoint; `GET /api/web-token` loopback-only endpoint; conditional registration of `POST /api/artifacts/{conv}/{name}` endpoint; `tool_comms_artifact_update` version-counter fix (max-based); CSP headers injected by the static file server. Tests: `test_post_route_disabled_when_proxy_or_flag_off.py`, `test_bearer_token_regenerated_on_restart.py`, `test_artifact_update_after_pruning.py`, `test_artifact_post_endpoint.py`.
- **D:** CORS exact-match rewrite in `cli.py` (replaces the substring-match bug; affects all existing artifact/message/participant/conversation endpoints). Test: `test_cors_exact_match.py`.
- **E:** (R6-1) **Subcomponent extraction of `ArtifactPanel.svelte`** — split into `ArtifactPanel.svelte` (orchestrator), `ArtifactList.svelte`, `ArtifactDetailHeader.svelte`, `ArtifactDetailBody.svelte`, `RemoteUpdateBanner.svelte`, `ArtifactEditor.svelte`. **No UX changes** — behavior preserved exactly. Creates the ownership boundaries needed for Batch 3 parallelism.

### Batch 2 — markdown + diff + Shiki unification (parallel, after Batch 1, ~35 min)
- **E:** `lib/markdown.js` (#9): install pinned deps (`marked@18.0.2`, `dompurify@3.4.1`, `shiki@3.0.0`, `marked-highlight@2.2.1`, `diff@8.0.1`); configure Shiki with `createHighlighterCore` + `cssVariables` theme + js-engine + 5 eager langs (ts, js, bash, python, json); DOMPurify strict config + `afterSanitizeAttributes` hook at module top-level for external-image interception. Export `renderMarkdown` AND `highlightCode`. Vitest setup (first JS tests in repo). XSS corpus in `web/tests/markdown-xss.spec.js` + render-race test in `web/tests/markdown-render-race.spec.js`.
- **F:** `ArtifactDiff.svelte` + `fetchFullVersion` helper with MAX_CHUNKS + non-advancing-offset guard + AbortController. Per-artifact-version LRU cache (limit 8). Diff uses `diffLines` + `diffWords`. Split view default; unified fallback <600px. Axis: left=older, right=newer, shared scroll container. `v1-only` disabled state. Tests: `web/tests/diff-chunked.spec.js` (4 scenarios).
- **G:** **Shiki unification:** refactor `CodeBlock.svelte` — delete custom tokenizer + keyword set; call new `highlightCode()` from `lib/markdown.js`; render-token race guard; language fallback on error. Chat code blocks now use proper grammars. Test: `web/tests/code-block-shiki.spec.js`.
- **H:** CSS contract for markdown rendering (#9) + Shiki cssVariables → Carbon Ember palette mapping (dark + light themes). Applied scoped under `.artifact-md-body`, `.chat-code-block`, `.artifact-diff`.

### Batch 3 — panel UX (after Batch 2, ~30 min — subcomponent-split parallelism)

**R6-1 fix: split `ArtifactPanel.svelte` into small subcomponents during Batch 1 so Batch 3 agents edit non-overlapping files.**

Batch 1 task E (new) extracts `ArtifactPanel.svelte` into:
- `ArtifactPanel.svelte` — thin orchestrator, imports and wires subcomponents
- `ArtifactList.svelte` — list view (rows, star/pin, empty state)
- `ArtifactDetailHeader.svelte` — detail header (version dropdown, toggle, Copy/Download/Edit buttons)
- `ArtifactDetailBody.svelte` — detail body (markdown render OR diff OR textarea, swaps based on mode)
- `RemoteUpdateBanner.svelte` — the conflict banner
- `ArtifactEditor.svelte` — the edit-mode textarea + Save/Cancel + autoresize

This refactor preserves existing behavior (no UX changes in Batch 1-E) and creates clean ownership boundaries.

Batch 3 tasks:
- **I:** (parallel w/ J) **OWNS:** `mqtt-store.svelte.js` (adds `artifactsDirty`, `markSelfUpdate()`, `isOurRecentUpdate()`, MQTT `artifact_ref` handler per R5-6) + `ArtifactList.svelte` (#3 author display, #6 empty state, #10 star/pin, #1 real-time refresh wiring, identity-scoped localStorage).
- **J:** (parallel w/ I) **OWNS:** `ArtifactDetailHeader.svelte` (`[Content|Diff]` toggle, secondary version selector, Copy/Download buttons, new dropdown row layout) + `ArtifactDetailBody.svelte` view/diff modes (markdown render via `renderMarkdown`, external-image click-to-load, diff integration).
- **K:** (blocked-by I) **OWNS:** `ArtifactEditor.svelte` + `RemoteUpdateBanner.svelte`. Edit button gated on `capabilities.writable`; textarea replaces content area in place with `{@attach autoresize}`; Save/Cancel below; `Cmd+Enter` / `Esc` with R4-3 precedence; banner with R5-4 four-path focus restoration + `aria-live="assertive"`; bearer-token 401-retry in `apiPost`; calls `store.markSelfUpdate(name, version)` on POST success; dirty-state confirm on artifact switch.

Inter-file edits (the orchestrator `ArtifactPanel.svelte`) are minimal wiring only — assigned to **I** since it's the sole task touching the MQTT store. J and K consume via props.

### Batch 4 — accessibility + CI gates (parallel, after Batch 3, ~20 min)
- **L:** Axe-core scan integration (`@axe-core/playwright` or Vitest + axe) as a **blocking CI gate** on key panel states (list empty, list populated, detail view, detail + diff, detail + edit, conflict banner open). Contrast validation: diff colors against `var(--bg)` must pass WCAG AA 4.5:1 for text, 3:1 for UI.
- **M:** CI bundle-size check — hard ceilings: `vendor-markdown ≤ 130 KB gzipped`, `vendor-diff ≤ 25 KB gzipped`, `index ≤ 180 KB gzipped`. Fallback ladder (drop Python / JSON lang eager-load, then highlight.js as last resort) documented in `CONTRIBUTING.md`.
- **N:** Keyboard + ARIA: listbox roles on dropdowns, arrow-key navigation, Escape to close, toast `aria-live` region, `aria-pressed` on star buttons, `aria-label` for all icon-only buttons.

### Svelte MCP tooling (mandatory for every Svelte edit)

**Preferred path:** delegate `.svelte` / `.svelte.js` / `.svelte.ts` edits to the `svelte-file-editor` subagent (has own context window + built-in docs+autofixer loop).

If delegating isn't feasible, the inline agent MUST:
1. SKIP `list-sections` (the MCP system-reminder already has the full path index in context)
2. Try knowledge + `svelte-autofixer` first; reach for `get-documentation` only when needed, selecting paths surgically by `use_cases`
3. Run `svelte-autofixer` on emitted code until zero issues AND zero suggestions
4. Load the `svelte:svelte-code-writer` and `svelte:svelte-core-bestpractices` skills

Failure to run `svelte-autofixer` to a clean report before completion is a blocking condition — the agent's work is NOT done until the tool reports clean.

### Verification (blocking gates)
- All existing tests pass (`pytest`, currently 100/100)
- All new tests pass (Python + Vitest)
- `vendor-markdown` chunk ≤ 130 KB gzipped
- `vendor-diff` chunk ≤ 25 KB gzipped
- Manual smoke: open panel, switch versions, toggle diff, edit, save, star
- Manual XSS smoke: paste the OWASP payloads into a markdown artifact and verify nothing executes

---

## Risks & mitigations (expanded)

- **Bundle bloat:** pinned versions + hard CI ceilings + documented fallback ladder.
- **Diff performance on large artifacts:** chunked full-content assembly is correct but slow for multi-MB documents. Threshold at 200 000 chars per version; above that, diff view refuses and recommends per-version view.
- **Markdown XSS:** DOMPurify strict config (no `style`, no event handlers, URL allowlist regex) + class-based Shiki theme + XSS test corpus as a blocking CI gate.
- **Concurrency conflicts on edit:** banner-based "never auto-clobber" behavior (see §1, §4).
- **Name regex edge cases:** split validator + case-collision rejection + symlink/realpath defense.
- **Version counter drift after pruning:** `max(v.version)` instead of `len()`, plus explicit test.
- **Remote write attempt:** loopback-only binding + clear UI message.
- **Shiki upstream churn:** exact version pin; re-evaluate on minor version bumps.

---

## Rollback runbook (R6-4)

45 correlated changes landing together means any single regression in the wild is hard to localize. Per-layer kill switches and an ordered release sequence:

### Per-layer kill switches

| Layer | Failure mode | Kill switch |
|---|---|---|
| POST edit endpoint | Unexpected 5xx, security issue | `web.allow_remote_edits: false` in config (already the default). Restart daemon. UI hides Edit button via capabilities endpoint. |
| Bearer token | Token endpoint unreachable | Disable `allow_remote_edits` (writes stop; reads unaffected). |
| NFC migration | Files mis-renamed or quarantine bloats | New config flag `web.migrate_nfc_on_startup: true` (default true). Set to false to skip; rename files manually from `.nfc-migration-quarantine/`. |
| CORS exact-match | Previously-working cross-origin setup breaks | New config flag `web.strict_cors: true` (default true). Set to false to re-enable legacy substring for one release — logged with deprecation warning. Plan to remove the escape hatch after two releases. |
| CSP | WebSocket or connect-src breaks for a proxy setup | New config key `web.csp_extra_connect_src: []` — list of additional origins to merge into `connect-src`. Empty default. |
| Shiki unification | Code-block rendering fails | `getHighlighter()` catch path falls back to escaped plain text automatically (no outage, just no colors). Hard-revert path: `lib/markdown.js`'s `highlightCode` exports the old keyword-based highlighter as a feature-flagged fallback (`web.use_legacy_codeblock_highlighter: false` default). |
| Markdown rendering | DOMPurify config breaks something legitimate | Escape hatch `web.markdown_render_enabled: true` — when false, `renderMarkdown()` returns escaped plain text. User sees raw markdown source. |
| Bundle size gate | Fails CI but the ship-critical work is orthogonal | CI gate can be overridden with an explicit `allow-oversized-bundle` git-commit-trailer for hotfixes. |

### Recommended release ordering

If the team prefers an incremental rollout instead of one big merge, this ordering minimizes cross-layer diagnosis:

1. **Release A:** Config schema additions, capabilities endpoint, bearer token endpoint (all no-ops without the POST route). Low-risk; surfaces the bearer token file for operational review.
2. **Release B:** CORS exact-match rewrite + CSP headers. Potentially-breaking for custom deployments; gated by `strict_cors` flag. Bake-in period.
3. **Release C:** NFC migration + permissive naming. Irreversible filesystem change; run with quarantine enabled.
4. **Release D:** Shiki unification + markdown rendering. Bundle size jump.
5. **Release E:** POST endpoint + edit-in-place UI. Turns on the actual feature.

Ship-as-one-batch is acceptable and faster — this ordering is the fallback if a failure warrants unwinding.

### Known user-visible breaking changes (ack required)

- **CSP** may break custom integrations (external CDN asset loads, inline script use). Site admins using reverse-proxy deployments should review `connect-src` inclusions before upgrading.
- **CORS exact-match** may break previously-working (but incorrectly accepted) cross-origin setups that depended on the substring-match bug. Deployments relying on permissive CORS should set `strict_cors: false` temporarily and move to exact-match in a follow-up.
- **Name validation** newly rejects `.json` suffix. Any existing artifact with a `.json`-suffixed name (impossible with the old regex) would be a freshly-introduced problem; this is a net new guard.

---

## Out of scope for this batch

- Collaborative real-time editing (CRDT/OT)
- Artifact comments / threads
- Fine-grained permissions
- Full-text search across artifacts
- Attachments (binary content)
- Cross-origin authenticated write path (for remote edits)

---

## Changelog

### Round 1 — Adversarial review

**10 findings, 10 accepted:**

1. **R1-1 (ACCEPT):** POST endpoint was trust-anything. Changed to loopback-only binding + participant-registry key verification. Remote writes explicitly out of scope for v1.
2. **R1-2 (ACCEPT):** Version counter used `len(versions)` which breaks after pruning past MAX_VERSIONS. Changed to `max(v.version)`. Added dedicated test.
3. **R1-3 (ACCEPT):** Real-time refresh could clobber in-progress edits. Added "remote update while editing" banner with View / Keep / Merge options. Never auto-refreshes the textarea out from under the user.
4. **R1-4 (ACCEPT):** DOMPurify config was wrong for Shiki output. Switched to Shiki's class-based `cssVariables` theme, removed the `ADD_ATTR: ['class']` kludge, tightened sanitizer to forbid `style`, event handlers, and unsafe URL schemes. Added XSS test corpus as a blocking gate.
5. **R1-5 (ACCEPT):** Windows-reserved regex was incomplete (missed `CON.txt` stem case, trailing dots) and fragile. Replaced with split validator: simple char-class regex + targeted Python structural checks.
6. **R1-6 (ACCEPT):** Path-traversal check didn't cover symlinks or NTFS/HFS+ case-insensitive collisions. Added `realpath` check, symlink-in-ancestor-chain rejection, and case-insensitive duplicate check at create time.
7. **R1-7 (ACCEPT):** Diff flow silently diffed only the first 50 KB chunk of each version. Fixed: `fetchFullVersion()` helper that iterates `has_more`/`next_offset` to assemble full content. Added LRU cache + 200K threshold.
8. **R1-8 (ACCEPT):** `lib/api.js` hostname heuristic was dev-only. Added reverse-proxy/Tailscale Funnel support via optional `<meta name="claude-comms-api-base">` injection. Renamed helper to plain `markdown.js` (not `.svelte.js`) since it has no runes.
9. **R1-9 (ACCEPT):** Bundle size claims were optimistic; caret ranges risked silent sanitizer drift. Pinned exact versions in `package.json`, added CI bundle-size gates, documented fallback ladder if Shiki exceeds budget.
10. **R1-10 (ACCEPT):** No new tests planned for the riskiest surfaces. Added explicit test list: `test_artifact_naming.py`, `test_artifact_update_after_pruning.py`, `test_artifact_post_endpoint.py`, plus first JS test suite (Vitest) with XSS and chunked-diff coverage.

### Round 2 — Adversarial review

**10 findings, 10 accepted.** R1 already covered the basics; R2 surfaced subtler security, concurrency, and a11y gaps.

1. **R2-1 (ACCEPT):** Loopback check via `request.client.host` is meaningless behind a reverse proxy (everything looks local). Added three-layer defense: Bearer token (primary), participant registry cross-check (authorization), reverse-proxy detection that disables the POST route entirely with clear UI message. `X-Forwarded-For` explicitly never trusted. Test case: spoofed forwarded headers must not grant access.
2. **R2-2 (ACCEPT):** Plain loopback + key-in-registry is impersonation-prone (any local process or CSRF'd browser). Added Bearer token stored in `~/.claude-comms/web-token` (chmod 600), served only to loopback clients, required on every POST. CSRF test added.
3. **R2-3 (ACCEPT):** Existing CORS uses `substring in origin` which is bypassable (`evil.com/http://localhost:9921` passes). Rewrote to exact-match lookup; no fallback to `cors_origins[0]`; missing-allowed-origin ⇒ header omitted so browser blocks. Test with forged origin.
4. **R2-4 (ACCEPT):** Single-version `skipRefreshUntil` guard races on multi-artifact or out-of-order resolution. Replaced with keyed TTL Set `recentlySelfUpdated: Map<"${name}:${version}", expiry>` (5s TTL). Test: two simultaneous updates, banner fires only for the remote one.
5. **R2-5 (ACCEPT):** No a11y spec at all. Added full Accessibility section: diff gutter glyphs + WCAG AA color contrast, listbox keyboard navigation in version dropdown, focus management for edit mode + conflict banner, `aria-live` regions for toasts, `aria-pressed` for star button. `@axe-core/playwright` scan added as a blocking CI gate.
6. **R2-6 (ACCEPT):** DOMPurify URL allowlist was permissive (allowed `file:`, arbitrary schemes via fallback branches) and `<img>` could be a tracking beacon. Tightened to explicit scheme allowlist `^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i`. Added `afterSanitizeAttributes` hook that intercepts external `<img>` URLs and replaces with click-to-load placeholder (Signal/Gmail pattern). XSS corpus expanded with beacon, file://, blob:, data:svg attempts.
7. **R2-7 (ACCEPT):** No CSP headers at all — single sanitizer regression becomes full XSS. Added strict CSP served from daemon's static file server (`default-src 'self'`, `script-src 'self'`, explicit `connect-src` for MCP + WebSocket), plus `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`. Playwright assertion test added.
8. **R2-8 (ACCEPT):** Starred artifacts localStorage key `claude-comms-starred-artifacts` was global, bleeding across identities and reverse-proxy vs direct origins. Scoped to `claude-comms:${identityKey}:starred-artifacts`. Reconcile against fetched list on mount; 500-entry cap per conversation.
9. **R2-9 (ACCEPT):** `fetchFullVersion` loop had no bounds — a non-advancing `next_offset` from a misbehaving server hangs the UI forever. Added MAX_CHUNKS (20), MAX_TOTAL_CHARS (250K) running-total abort, strict `next_offset > offset` assertion, and AbortController tied to component unmount. Test stubs cover all three failure modes.
10. **R2-10 (ACCEPT):** `$effect(async () => { rendered = await renderMarkdown(...) })` races on fast artifact switches (slow A resolves after fast B → mismatched body). Added monotonic `renderToken` guard. Documented as required pattern in `lib/markdown.js`. Vitest race test added.

### Round 3 — Final adversarial review

**6 findings, 6 accepted.** Mostly glue between R1+R2 fixes: config schema, feature flag, capabilities endpoint, token lifecycle specifics, click-handler wiring for blocked images, CSP dynamic origins.

1. **R3-1 (ACCEPT):** `web.api_base` and `REVERSE_PROXY` env var were referenced but undefined. Added explicit config schema section: `web.api_base: str | None`, `web.allow_remote_edits: bool = false`, `web.ws_url: str | None`, and `REVERSE_PROXY=1` env var. Documented precedence (either signal enables proxy mode). Added `test_post_route_disabled_when_proxy_or_flag_off.py` covering all four cases.
2. **R3-2 (ACCEPT):** UI had no way to know the deployment was read-only other than 404 after clicking Edit. Added `GET /api/capabilities` endpoint that returns `{writable, features}`. Edit button visibility now gates on `capabilities.writable` — no button to click in reverse-proxy mode, with a small lock icon explaining the state.
3. **R3-3 (ACCEPT):** CSP `connect-src` hard-coded `127.0.0.1` origins would break WebSocket connections in reverse-proxy mode. Rewrote to derive dynamically from `web.api_base` (or defaults). WS scheme (`ws:`/`wss:`) derived from API scheme. Added Playwright smoke test in reverse-proxy mode to verify no CSP violation.
4. **R3-4 (ACCEPT):** Bearer token had no specified lifecycle, rotation, or multi-session behavior. Explicitly specified: fresh token on every daemon start (not persisted); `GET /api/web-token` (loopback-only) fetches it; UI does 401-retry once via refetch; documented "same-UID read access = impersonation" threat model in the Risks section. Added `test_bearer_token_regenerated_on_restart.py` and frontend 401-retry test.
5. **R3-5 (ACCEPT):** External-image blocking hook had no click-handler wiring and was registered inside `configureMarked()` (scope bug). Moved `DOMPurify.addHook` to module top-level in `lib/markdown.js` (runs once on import, applies to ALL renders). Added delegated click-listener snippet in `ArtifactPanel.svelte` with cleanup on unmount. Documented global-policy scope; added "applies across two sequential renders" test.
6. **R3-6 (ACCEPT):** No kill switch for the riskiest feature (POST endpoint). Added `web.allow_remote_edits: bool = false` feature flag. v1 ships default-off; post-field-test flip. POST route is only registered when `allow_remote_edits AND NOT reverse_proxy_mode`. Capabilities endpoint surfaces the state to the UI. Documented rollout: "opt in, field test, default-on later."

---

### Round 4 — Adversarial review (post-UX-spec)

**8 findings, 8 accepted.** R4 found issues that only became visible once the UX specs were concrete, plus one critical silent-failure bug (R4-4).

1. **R4-1 (ACCEPT):** Bearer token bootstrap race — no guarantee token is cached before first POST, no explicit token-free endpoint list, global retry counter. Fixed with `ensureToken()` promise (awaited on every POST), `TOKEN_FREE_ENDPOINTS` set, per-request retry budget, app-mount prefetch. Tests added for bootstrap timing, per-request retry isolation, bootstrap deadlock prevention.
2. **R4-2 (ACCEPT):** `field-sizing: content` has no Firefox support as of April 2026; v5 plan referenced a "ResizeObserver fallback" without specifying it. Fixed with a concrete `autoresize` attachment (using Svelte 5.29+ `{@attach}` idiom) that handles all browsers, recalculates on banner mount/unmount, caps at dynamic viewport math.
3. **R4-3 (ACCEPT):** Esc keybinding conflict between banner (dismiss), dropdown (close), textarea (Cancel), and dialog. Added explicit precedence: dialog → banner → dropdown → textarea → app-global. Each layer calls `stopPropagation()`. Test verifies Esc on focused banner dismisses banner but leaves textarea in edit mode with content intact.
4. **R4-4 (ACCEPT — CRITICAL):** `@shikijs/themes/css-variables` is NOT a valid Shiki v3 package export. The v5 plan would silently break every code block app-wide (catch path returns escaped plain text; bug looks like "nothing colored" rather than a crash). Fixed by using `createCssVariablesTheme` from `shiki/core` with explicit `variableDefaults`. Smoke test now asserts actual token coloring, not just non-throw.
5. **R4-5 (ACCEPT):** `highlighterPromise` cached the rejected promise on init failure, poisoning highlighting app-wide until hard reload. Fixed: `.catch()` nulls the cache on rejection so next call retries. Optional backoff + toast deferred as polish.
6. **R4-6 (ACCEPT):** Shiki CSS variables scoped to `.chat-code-block` — but the refactored `CodeBlock.svelte` renders `.code-block-wrap` (kept to preserve existing class contract). Fixed by scoping the `--shiki-*` variables at `:root` instead; Shiki HTML picks them up via inheritance everywhere.
7. **R4-7 (ACCEPT):** Windows-permissive naming allowed `.json`-suffixed names (produces `foo.json.json` on disk), no Unicode NFC normalization (macOS HFS+ NFD collision), allowed confusable fullwidth chars. Fixed: reject `.json` suffix, NFC-normalize at validation + path assembly, reject fullwidth range U+FF00–U+FFEF. On-disk naming convention documented.
8. **R4-8 (ACCEPT):** Banner animation didn't respect `prefers-reduced-motion`; forced focus to banner lost textarea selection/scroll position. Fixed: `@media (prefers-reduced-motion: reduce)` rule, save/restore textarea `selectionStart`/`selectionEnd`/`scrollTop` + panel scrollTop on banner focus transfer, restored on "Keep editing."

---

### Round 5 — Adversarial review

**6 findings, 6 accepted.** R5 scrutinized R4's fixes and caught two real bugs (NFC completeness, Batch-3 parallel hazard) plus refinements on token flow, focus restoration, and ResizeObserver hygiene.

1. **R5-1 (ACCEPT):** `ensureToken()` app-mount prefetch had no rejection handler → unhandled-rejection logs if the daemon was warming up. Fixed with explicit `prefetchToken()` wrapper that catches + warns. Test stubs `/api/web-token` with 503 at mount; subsequent POST must transparently refetch.
2. **R5-2 (ACCEPT):** 401 after retries exhausted threw with `HTTP 401` error message, not the intended `"Session expired — reload the page"` copy used by the refetch-failure branch. Fixed: both 401-terminal paths now emit the same `fatal: true` `"Session expired"` error. Test asserts exact `error.message` on both branches.
3. **R5-3 (ACCEPT — real bug):** NFC normalization was only applied at `validate_artifact_name` and `_artifact_path` — `load_artifact`, `delete_artifact`, and the `Artifact` Pydantic model's `name` field were uncovered. A caller who used a name returned from `list_artifacts` (raw from disk) could fail to round-trip. Fixed: added `_normalize_name()` helper called at every boundary, a Pydantic `field_validator` enforcing NFC on the model, AND a one-time `migrate_artifact_names_to_nfc()` at daemon startup for pre-existing NFD files. Four tests: migration, load-with-NFD-input, model-auto-normalization, migration-idempotency.
4. **R5-4 (ACCEPT):** Focus/scroll restoration was specified only for the "Keep editing" path. The more common paths (X-button dismiss, Esc-on-banner, 30s auto-dismiss) all silently lost textarea cursor + scroll position. Fixed: `preBannerState` is restored on EVERY path that returns focus to the textarea; explicitly lists 7 paths and whether each restores. Test covers Esc, X, auto-dismiss.
5. **R5-5 (ACCEPT):** `autoresize` action observed `document.body` — coarse, fires on every layout change, risks `ResizeObserver loop` warnings. Fixed: observe only the banner element (via MutationObserver watching for mount/unmount), listen to `window resize` for viewport changes, rAF-throttle all recalcs. Test: toggle banner 10× rapidly, assert no warnings.
6. **R5-6 (ACCEPT — real bug):** Batch 3 tasks I and K both edited `mqtt-store.svelte.js` + `ArtifactPanel.svelte` in parallel. Merge-conflict risk AND the `markSelfUpdate`/`isOurRecentUpdate` contract wasn't pinned down (panel-owned or store-owned?). Fixed: store owns the methods (it has the MQTT handler); task I is the sole owner of store edits; task K is a consumer that calls store methods; K is declared `blocked-by` I. J and I can still run in parallel. Exact signatures in the plan for agent convergence.

---

### Svelte 5 patterns audit (post-R6)

After the 6-round adversarial pass, a dedicated audit against April 2026 Svelte 5 docs caught three pattern issues and motivated a dedicated conventions reference:

1. **Anti-pattern `$effect(async () => ...)` in §9 usage example** — conflicted with the elsewhere-specified monotonic-token fix (R2-10). Rewrote the §9 example to use the sync-effect-with-IIFE pattern consistently. Added "never pass an async function to $effect" as a canonical rule.
2. **`use:autoresize` → `{@attach autoresize}`** — Svelte 5.29+ introduced attachments as the preferred replacement for action directives. Updated the three references to the new idiom. `autoresize.js` lives as a plain `.js` helper (no runes).
3. **No central Svelte 5 conventions reference for implementation agents.** Added a dedicated "Svelte 5 conventions" section (canonical for all agents) covering: file extensions (`.svelte` / `.svelte.js` / `.js`), each rune's correct usage, the async-in-effect patterns (Pattern A = monotonic token, Pattern B = AbortController), `@attach` vs `use:`, props + events (lowercase, callback props), snippets over slots, class-based state stores, testing patterns (`flushSync`, `settled()`), `{@html}` + DOMPurify rule, and a legacy-vs-current lookup table.

### Round 6 — Final adversarial review

**5 findings, 5 accepted.** R6 focused on what R5's fixes might have missed or introduced, plus operational gaps.

1. **R6-1 (ACCEPT — real merge-conflict risk):** R5-6 fixed the store-ownership contract but Batch 3 tasks I, J, K still all edited `ArtifactPanel.svelte` in parallel — guaranteed conflict on shared `<script>` imports and `$state` declarations. Fixed by adding Batch 1 task E: subcomponent extraction of `ArtifactPanel.svelte` into 6 smaller files (`ArtifactList`, `ArtifactDetailHeader`, `ArtifactDetailBody`, `RemoteUpdateBanner`, `ArtifactEditor`). Clean ownership boundaries for Batch 3; no UX changes in Batch 1.
2. **R6-2 (ACCEPT — real split-brain bug):** NFC migration "leave in place" on collision created two on-disk files the Pydantic NFC validator would collapse to the same `.name` in memory — two Artifact records sharing identity nondeterministically. Fixed with quarantine: collision case moves the NFD file to `{data_dir}/.nfc-migration-quarantine/{conversation}/...`, logs prominently, admin reconciles. Test added.
3. **R6-3 (ACCEPT):** R5-5's rebuilt MutationObserver used `subtree: true`, which fires on every markdown re-render, toast animation, dropdown open — re-introducing the churn it was meant to fix. Narrowed to `childList: true, subtree: false` (banner is a direct child of panel body per §1). Added DEV-only runtime assert to catch future drift if the banner location changes.
4. **R6-4 (ACCEPT):** No rollback runbook for 45 correlated changes shipping together. Added per-layer kill switches (`allow_remote_edits`, `migrate_nfc_on_startup`, `strict_cors`, `csp_extra_connect_src`, `use_legacy_codeblock_highlighter`, `markdown_render_enabled`), a recommended incremental release ordering (5 releases), and an explicit "known user-visible breaking changes" list (CSP, CORS, name validation) for operator ack.
5. **R6-5 (ACCEPT):** R5-1 defined `prefetchToken()` but the prose still said "kick off `ensureToken()`" at app mount — implementation agents following prose would re-introduce the unhandled-rejection bug R5-1 was meant to fix. Prose updated to explicitly call `prefetchToken()`.

---

### UX specification pass

All per-improvement sections now carry concrete visual/interaction specs — placement, sizes, colors, keyboard shortcuts, edge cases. Plus:

- **Permissive naming (#8) widened to Windows-filesystem-compatible** per Phil's decision: allows any char except `< > : " / \ | ? * ` + control chars; spaces allowed; Unicode allowed; trailing dot/space rejected; reserved names + stems rejected. Tradeoffs of URL-encoding for spaces/punctuation accepted. Expanded test corpus to 30+ cases.
- **Edit-in-place UX concretized:** textarea replaces content area in place; Save/Cancel below; `Cmd+Enter` / `Esc` shortcuts; no summary field (version-number bump is enough); dirty-state confirm on switch.
- **Remote-update banner visual spec:** 48px floating banner at top of detail area, amber left-border, three relabeled actions (ambiguous "Merge" removed), 30s auto-dismiss, `aria-live="assertive"` + focus management.
- **Diff view UX:** default compares `v(N-1)`, v1-only toggle disabled, left=older/right=newer axis, shared scroll container, empty-diff message.
- **Version dropdown rows:** single-line 3-column layout with relative-time formatting and ellipsis truncation.
- **Copy/Download:** icon-only buttons in detail header, right-aligned, transient check-mark animation on copy.
- **Empty state:** exact copy defined, GitHub-hosted help link.
- **Star/pin:** hover-to-reveal opacity, click-isolated button, top-level `STARRED` section matching existing `ONLINE`/`OFFLINE` section style.
- **Markdown CSS contract:** full selector-by-selector spec for H1–H4, paragraphs, lists, tables, blockquotes, inline code, rendered code blocks, blocked-image placeholder.

**NEW — Shiki unification section** (refactor `CodeBlock.svelte`):

Replace the hand-rolled keyword tokenizer (~52 JS/Python keywords; known cross-contamination bugs) with a call into `lib/markdown.js`'s Shiki highlighter. Chat messages, artifact code bodies, and fenced code blocks in rendered markdown all use the same pipeline. Delete ~60 LOC of custom tokenizer. Bundle cost: $0 (Shiki already in bundle for artifacts). Gains: 200+ languages correct, consistent look app-wide, Carbon Ember palette drives all three surfaces via CSS variable mapping, foundation for syntax-highlighted diff lines later.

**Plan status: v9 — FINAL.** 45 adversarial findings across 6 rounds + full UX spec + rollback runbook + Svelte 5 conventions audit applied. Ready for implementation. Key invariants enforced:

- **Security:** Bearer token + participant registry + reverse-proxy detection + feature flag + CSP + exact-match CORS + external-image blocking + URL scheme allowlist. Any single layer failing still leaves two others intact.
- **Concurrency:** `max(version)` counter, keyed TTL Set for self-update dedup, conflict banner never auto-clobbers, render-token guard for async switches.
- **Correctness:** chunked-read with bounds, regex split validator, case-collision detection, symlink-safe path assembly.
- **A11y:** keyboard, focus, `aria-live`, WCAG AA contrast, non-color +/- glyphs, axe scan as blocking gate.
- **Operations:** pinned versions, bundle-size CI gate with fallback ladder, documented threat model.
