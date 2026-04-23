<!--
  @component ArtifactDetailBody
  @description Content area of the artifact detail view. For `plan` / `doc` types,
    renders markdown via the sanitized `renderMarkdown` pipeline using the
    monotonic-token `$effect` pattern (Pattern A per §"Svelte 5 conventions").
    For `code` type, renders the raw content in a `<pre>`. When `viewMode` is
    `'diff'` and `compareVersion` is set, fetches both full versions via the
    chunked-read helper (with LRU cache) and mounts `<ArtifactDiff>`.

  Wires a delegated click listener on the markdown container so blocked external
  images (R2-6 placeholder class) can be revealed when the user explicitly clicks
  them.

  @prop {object} artifact               - Currently-selected artifact detail (has `.type`, `.content`, `.version`, `.versions`, `.name`, `.channel`).
  @prop {string|null} detailError       - Error message if the detail fetch failed.
  @prop {'content'|'diff'} viewMode     - Active view mode.
  @prop {number|null} compareVersion    - The "from" version number when in diff mode.
-->
<script>
  import { renderMarkdown } from '../lib/markdown.js';
  import { fetchFullVersion } from '../lib/fetchFullVersion.js';
  import * as versionCache from '../lib/versionCache.js';
  import ArtifactDiff from './ArtifactDiff.svelte';

  let {
    artifact,
    detailError,
    viewMode = 'content',
    compareVersion = null,
  } = $props();

  // ── Markdown render state (Pattern A: monotonic token guard) ─────────────
  /** The most-recently-applied sanitized HTML string. */
  let rendered = $state('');
  /** Monotonic render counter — every $effect run bumps & captures this. */
  let renderToken = 0;

  let isMarkdown = $derived(
    artifact?.type === 'plan' || artifact?.type === 'doc',
  );

  // Render markdown whenever the source artifact's content changes. Sync
  // $effect with an IIFE — NEVER `$effect(async () => ...)`. The captured
  // token `t` is compared against the live counter before assignment so a
  // slow previous render cannot overwrite a fresher one (R2-10).
  $effect(() => {
    const t = ++renderToken;
    const src = artifact?.content;
    const shouldRender = isMarkdown;
    if (!src || !shouldRender) {
      rendered = '';
      return;
    }
    (async () => {
      try {
        const html = await renderMarkdown(src);
        if (t === renderToken) rendered = html;
      } catch {
        if (t === renderToken) rendered = '';
      }
    })();
  });

  // ── Diff state ───────────────────────────────────────────────────────────
  /** @type {{ from: string, to: string, fromVersion: number, toVersion: number } | null} */
  let diffData = $state(null);
  let diffLoading = $state(false);
  let diffErrorMsg = $state(null);
  let diffTooLarge = $state(false);
  let diffToken = 0;

  /** 200 000 char cap per §2 "Too-large guard". */
  const DIFF_MAX_CHARS = 200_000;

  // Fetch both versions whenever we enter diff mode with a valid compare
  // target. Uses Pattern B (AbortController) because chunked reads are
  // expensive and should be explicitly cancelled on unmount / rapid switch.
  $effect(() => {
    const channel = artifact?.channel;
    const name = artifact?.name;
    const toVersion = artifact?.version;
    const fromVersion = compareVersion;

    // Reset derived state on every re-run of this effect.
    diffData = null;
    diffErrorMsg = null;
    diffTooLarge = false;

    if (viewMode !== 'diff' || fromVersion == null) return;
    if (!channel || !name || toVersion == null) return;
    if (fromVersion === toVersion) return;

    const t = ++diffToken;
    const ctrl = new AbortController();
    diffLoading = true;

    (async () => {
      try {
        const [fromBlob, toBlob] = await Promise.all([
          loadVersionCached(channel, name, fromVersion, ctrl.signal),
          loadVersionCached(channel, name, toVersion, ctrl.signal),
        ]);
        if (t !== diffToken || ctrl.signal.aborted) return;
        if (fromBlob.content.length > DIFF_MAX_CHARS || toBlob.content.length > DIFF_MAX_CHARS) {
          diffTooLarge = true;
          diffData = null;
        } else {
          diffData = {
            from: fromBlob.content,
            to: toBlob.content,
            fromVersion,
            toVersion,
          };
        }
      } catch (err) {
        if (t !== diffToken) return;
        if (err?.name === 'AbortError') return;
        diffErrorMsg = err?.message ?? String(err);
      } finally {
        if (t === diffToken) diffLoading = false;
      }
    })();

    return () => ctrl.abort();
  });

  /**
   * Fetch a full version, consulting the module-level LRU cache first.
   */
  async function loadVersionCached(channel, name, version, signal) {
    const hit = versionCache.get(channel, name, version);
    if (hit) return hit;
    const data = await fetchFullVersion(channel, name, version, { signal });
    versionCache.set(channel, name, version, data);
    return data;
  }

  // ── External-image click handler (R2-6 fix) ──────────────────────────────
  // Delegated listener on the markdown container: when the user clicks a
  // blocked placeholder image, swap `src` back in from the stashed
  // `data-external-src` and remove the placeholder class. This is explicit
  // user consent — no network call happens until the click.
  //
  // Implemented as an attachment (Svelte 5.29+) rather than `bind:this` +
  // a separate $effect — per the §"DOM attachments" convention, `{@attach}`
  // is the canonical way to co-locate mount + cleanup logic with the element.
  /**
   * @type {import('svelte/attachments').Attachment}
   */
  function externalImageClickInterceptor(node) {
    const onClick = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.tagName !== 'IMG') return;
      if (!target.classList.contains('external-image-blocked')) return;
      const stashed = target.getAttribute('data-external-src');
      if (!stashed) return;
      target.setAttribute('src', stashed);
      target.removeAttribute('data-external-src');
      target.classList.remove('external-image-blocked');
      // Clear the placeholder alt text — the image itself now speaks for it.
      target.removeAttribute('alt');
    };
    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }
</script>

<div class="artifact-content-area">
  {#if detailError}
    <div class="artifact-error">{detailError}</div>
  {:else if viewMode === 'diff'}
    {#if compareVersion == null}
      <div class="artifact-empty-diff">Select a version to compare</div>
    {:else if diffTooLarge}
      <div class="artifact-empty-diff">Diff too large — view versions individually</div>
    {:else if diffErrorMsg}
      <div class="artifact-error">{diffErrorMsg}</div>
    {:else if diffLoading}
      <div class="artifact-empty-diff">Loading diff…</div>
    {:else if diffData}
      <ArtifactDiff
        fromContent={diffData.from}
        toContent={diffData.to}
        fromVersion={diffData.fromVersion}
        toVersion={diffData.toVersion}
      />
    {/if}
  {:else if isMarkdown}
    {#if rendered}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="artifact-md-body" {@attach externalImageClickInterceptor} data-testid="artifact-md-body">{@html rendered}</div>
    {:else}
      <div class="artifact-md-body" {@attach externalImageClickInterceptor} data-testid="artifact-md-body"></div>
    {/if}
  {:else}
    <pre class="artifact-raw-body" data-testid="artifact-raw-body">{artifact?.content ?? ''}</pre>
  {/if}
</div>

<style>
  .artifact-content-area {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .artifact-raw-body {
    font-family: 'SF Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    margin: 0;
    background: none;
  }

  .artifact-error {
    padding: 16px;
    font-size: 12px;
    color: #f87171;
  }

  .artifact-empty-diff {
    padding: 32px 16px;
    font-size: 13px;
    color: var(--text-muted);
    text-align: center;
  }

  /*
   * Markdown body CSS contract (Batch 2H, plan §9). The HTML is injected via
   * `{@html}` so we pierce scope with `:global(...)` — the Svelte compiler
   * doesn't see those elements at scope-analysis time.
   */
  :global(.artifact-md-body h1) {
    font-size: 18px; font-weight: 600; color: var(--text-primary);
    margin: 0 0 12px; line-height: 1.3;
  }
  :global(.artifact-md-body h2) {
    font-size: 16px; font-weight: 600; color: var(--text-primary);
    margin: 20px 0 8px; line-height: 1.35;
  }
  :global(.artifact-md-body h3) {
    font-size: 14px; font-weight: 600; color: var(--text-primary);
    margin: 16px 0 6px;
  }
  :global(.artifact-md-body h4) {
    font-size: 13px; font-weight: 600; color: var(--text-primary);
    margin: 14px 0 6px;
  }
  :global(.artifact-md-body p) {
    font-size: 13px; line-height: 1.6; color: var(--text-secondary);
    margin: 0 0 10px;
  }
  :global(.artifact-md-body a) {
    color: var(--ember-400); text-decoration: none;
  }
  :global(.artifact-md-body a:hover) { text-decoration: underline; }
  :global(.artifact-md-body ul),
  :global(.artifact-md-body ol) {
    padding-left: 20px; margin: 0 0 10px;
  }
  :global(.artifact-md-body li) {
    margin: 4px 0; font-size: 13px; line-height: 1.55;
  }
  :global(.artifact-md-body table) {
    border-collapse: collapse; margin: 10px 0; font-size: 13px;
  }
  :global(.artifact-md-body th),
  :global(.artifact-md-body td) {
    border: 1px solid var(--border); padding: 6px 10px; text-align: left;
  }
  :global(.artifact-md-body th) {
    background: var(--bg-surface); font-weight: 600;
  }
  :global(.artifact-md-body blockquote) {
    border-left: 3px solid var(--ember-600);
    padding: 4px 12px; margin: 8px 0;
    color: var(--text-muted); font-style: italic;
  }
  :global(.artifact-md-body code:not(pre code)) {
    background: var(--bg-elevated); padding: 1px 6px; border-radius: 4px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px; color: var(--ember-300);
  }
  :global(.artifact-md-body pre) {
    margin: 10px 0; border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    overflow-x: auto;
  }
  :global(.artifact-md-body hr) {
    border: none; border-top: 1px solid var(--border); margin: 16px 0;
  }
  :global(.artifact-md-body img.external-image-blocked) {
    background: var(--bg-elevated); border: 1px dashed var(--border);
    padding: 24px; cursor: pointer; color: var(--text-muted);
    font-size: 12px; text-align: center; width: 100%;
    box-sizing: border-box; border-radius: var(--radius-sm);
  }
</style>
