<!--
  @component ArtifactDiff
  @description VSCode-style side-by-side diff of two artifact versions.
    Rows are computed via `diffLines()`; within a paired remove+add
    modification, inline char-level highlights come from `diffWords()`.

    Axis convention: left = older (from), right = newer (to).

    Responsive behavior: ≥600px shows a two-column table with line numbers on
    each side. <600px collapses to a single unified column with interleaved
    +/- lines.

    Accessibility (R2-5): gutter glyphs `+` / `-` / `=` are rendered in
    addition to background colour so color-blind users can still disambiguate.
    Inline char-level highlights are additionally underlined.

  @prop {string} fromContent - The older version's full content.
  @prop {string} toContent   - The newer version's full content.
  @prop {number|string} fromVersion - Display label for the older version.
  @prop {number|string} toVersion   - Display label for the newer version.
-->
<script>
  import { diffLines, diffWords } from 'diff';

  /** @type {{ fromContent: string, toContent: string, fromVersion: number|string, toVersion: number|string }} */
  let { fromContent, toContent, fromVersion, toVersion } = $props();

  // ── Responsive layout ────────────────────────────────────────────────────
  // Track window width so we can collapse to a unified column below 600px.
  // Svelte 5 idiom: $state + $effect for the window resize listener, with
  // cleanup returned from the effect to remove the listener on unmount.
  let viewportWidth = $state(
    typeof window === 'undefined' ? 1024 : window.innerWidth,
  );

  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      viewportWidth = window.innerWidth;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  const UNIFIED_BREAKPOINT = 600;
  let isUnified = $derived(viewportWidth < UNIFIED_BREAKPOINT);

  // ── Row assembly ─────────────────────────────────────────────────────────
  // `diffLines` returns an array of parts where each part has:
  //   { value: string, added?: boolean, removed?: boolean, count: number }
  // We walk the parts and emit display rows. A "removed" run immediately
  // followed by an "added" run forms a MODIFICATION — we pair them line-by-line
  // and compute inline `diffWords` so changed characters highlight within the
  // row. Unpaired adds/removes stand alone (pure insertion / deletion).

  /**
   * Split a chunk `.value` into its component lines WITHOUT losing the last
   * line when the chunk doesn't end in a newline. `diffLines` keeps the
   * trailing `\n` on each line; we strip it for display.
   *
   * @param {string} value
   * @returns {string[]}
   */
  function splitLines(value) {
    if (value === '') return [];
    // Strip exactly one trailing \n if present so "foo\nbar\n" → ["foo", "bar"].
    const trimmed = value.endsWith('\n') ? value.slice(0, -1) : value;
    return trimmed.split('\n');
  }

  /**
   * Compute inline segments for a modified row via `diffWords`. Returns
   * parallel `fromSegs` / `toSegs` arrays where each entry is
   * `{ text: string, changed: boolean }`.
   *
   * @param {string} fromLine
   * @param {string} toLine
   */
  function inlineSegments(fromLine, toLine) {
    const wordParts = diffWords(fromLine, toLine);
    const fromSegs = [];
    const toSegs = [];
    for (const p of wordParts) {
      if (p.added) {
        toSegs.push({ text: p.value, changed: true });
      } else if (p.removed) {
        fromSegs.push({ text: p.value, changed: true });
      } else {
        fromSegs.push({ text: p.value, changed: false });
        toSegs.push({ text: p.value, changed: false });
      }
    }
    return { fromSegs, toSegs };
  }

  /**
   * Build the full row list from the two contents. Each row is one of:
   *   { type: 'equal',  fromNum, toNum, fromSegs, toSegs }
   *   { type: 'remove', fromNum, toNum: null, fromSegs, toSegs: null }
   *   { type: 'add',    fromNum: null, toNum, fromSegs: null, toSegs }
   *   { type: 'modify', fromNum, toNum, fromSegs, toSegs }
   *
   * The segments arrays contain `{ text, changed }` entries so the template
   * can render char-level highlights uniformly.
   */
  function buildRows(a, b) {
    const parts = diffLines(a, b);
    /** @type {Array<{type:string, fromNum:number|null, toNum:number|null, fromSegs:any, toSegs:any}>} */
    const rows = [];
    let fromCounter = 0;
    let toCounter = 0;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const next = parts[i + 1];
      const lines = splitLines(p.value);

      if (!p.added && !p.removed) {
        // Equal/context run.
        for (const line of lines) {
          fromCounter++;
          toCounter++;
          rows.push({
            type: 'equal',
            fromNum: fromCounter,
            toNum: toCounter,
            fromSegs: [{ text: line, changed: false }],
            toSegs: [{ text: line, changed: false }],
          });
        }
        continue;
      }

      if (p.removed && next && next.added) {
        // Modification: pair removed lines with added lines one-for-one; any
        // overflow on either side falls through as plain remove/add rows.
        const fromLines = lines;
        const toLines = splitLines(next.value);
        const paired = Math.min(fromLines.length, toLines.length);

        for (let j = 0; j < paired; j++) {
          fromCounter++;
          toCounter++;
          const { fromSegs, toSegs } = inlineSegments(fromLines[j], toLines[j]);
          rows.push({
            type: 'modify',
            fromNum: fromCounter,
            toNum: toCounter,
            fromSegs,
            toSegs,
          });
        }
        for (let j = paired; j < fromLines.length; j++) {
          fromCounter++;
          rows.push({
            type: 'remove',
            fromNum: fromCounter,
            toNum: null,
            fromSegs: [{ text: fromLines[j], changed: true }],
            toSegs: null,
          });
        }
        for (let j = paired; j < toLines.length; j++) {
          toCounter++;
          rows.push({
            type: 'add',
            fromNum: null,
            toNum: toCounter,
            fromSegs: null,
            toSegs: [{ text: toLines[j], changed: true }],
          });
        }
        i++; // Consume the paired `added` part.
        continue;
      }

      if (p.removed) {
        for (const line of lines) {
          fromCounter++;
          rows.push({
            type: 'remove',
            fromNum: fromCounter,
            toNum: null,
            fromSegs: [{ text: line, changed: true }],
            toSegs: null,
          });
        }
        continue;
      }

      // p.added only (unpaired).
      for (const line of lines) {
        toCounter++;
        rows.push({
          type: 'add',
          fromNum: null,
          toNum: toCounter,
          fromSegs: null,
          toSegs: [{ text: line, changed: true }],
        });
      }
    }
    return rows;
  }

  let rows = $derived(buildRows(fromContent ?? '', toContent ?? ''));

  // Empty-diff guard: identical content (only `equal` rows, or the contents
  // are literally the same string).
  let hasDifferences = $derived(
    fromContent !== toContent && rows.some((r) => r.type !== 'equal'),
  );

  // Gutter glyph for accessibility — colour is not the only signal.
  function glyphFor(type) {
    if (type === 'add') return '+';
    if (type === 'remove') return '-';
    if (type === 'modify') return '±';
    return '=';
  }
</script>

<section class="artifact-diff" aria-label="Version diff viewer">
  <header class="diff-header">
    <span class="diff-from">v{fromVersion}</span>
    <span class="diff-arrow" aria-hidden="true">→</span>
    <span class="diff-to">v{toVersion}</span>
  </header>

  {#if !hasDifferences}
    <p class="diff-empty" role="status">
      No differences between v{fromVersion} and v{toVersion}
    </p>
  {:else if isUnified}
    <!-- Narrow: unified single-column view. -->
    <div class="diff-scroll">
      <table class="diff-table unified">
        <tbody>
          {#each rows as row, idx (idx)}
            {#if row.type === 'modify'}
              <tr class="row remove">
                <td class="gutter-num" aria-hidden="true">{row.fromNum ?? ''}</td>
                <td class="gutter-glyph" aria-label="removed line">-</td>
                <td class="line">
                  {#each row.fromSegs as seg, segIdx (segIdx)}
                    {#if seg.changed}
                      <span class="char-change">{seg.text}</span>
                    {:else}{seg.text}{/if}
                  {/each}
                </td>
              </tr>
              <tr class="row add">
                <td class="gutter-num" aria-hidden="true">{row.toNum ?? ''}</td>
                <td class="gutter-glyph" aria-label="added line">+</td>
                <td class="line">
                  {#each row.toSegs as seg, segIdx (segIdx)}
                    {#if seg.changed}
                      <span class="char-change">{seg.text}</span>
                    {:else}{seg.text}{/if}
                  {/each}
                </td>
              </tr>
            {:else}
              <tr class="row {row.type}">
                <td class="gutter-num" aria-hidden="true">
                  {row.type === 'add' ? row.toNum ?? '' : row.fromNum ?? ''}
                </td>
                <td class="gutter-glyph" aria-label="{row.type} line">
                  {glyphFor(row.type)}
                </td>
                <td class="line">
                  {#if row.type === 'add'}
                    {#each row.toSegs as seg, segIdx (segIdx)}
                      {#if seg.changed}
                        <span class="char-change">{seg.text}</span>
                      {:else}{seg.text}{/if}
                    {/each}
                  {:else}
                    {#each row.fromSegs as seg, segIdx (segIdx)}
                      {#if seg.changed}
                        <span class="char-change">{seg.text}</span>
                      {:else}{seg.text}{/if}
                    {/each}
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <!-- Wide: two-column split view, shared scroll wrapper. -->
    <div class="diff-scroll">
      <table class="diff-table split">
        <colgroup>
          <col class="col-num" />
          <col class="col-glyph" />
          <col class="col-line" />
          <col class="col-num" />
          <col class="col-glyph" />
          <col class="col-line" />
        </colgroup>
        <tbody>
          {#each rows as row, idx (idx)}
            <tr class="row {row.type}">
              <!-- LEFT (from / older) -->
              <td class="gutter-num" aria-hidden="true">{row.fromNum ?? ''}</td>
              <td class="gutter-glyph" aria-label={row.fromSegs ? `${row.type === 'equal' ? 'unchanged' : row.type === 'modify' ? 'modified' : 'removed'} line` : 'empty'}>
                {#if row.fromSegs}
                  {row.type === 'equal' ? '=' : row.type === 'modify' ? '-' : '-'}
                {/if}
              </td>
              <td class="line line-from" class:empty-side={!row.fromSegs}>
                {#if row.fromSegs}
                  {#each row.fromSegs as seg, segIdx (segIdx)}
                    {#if seg.changed}
                      <span class="char-change">{seg.text}</span>
                    {:else}{seg.text}{/if}
                  {/each}
                {/if}
              </td>

              <!-- RIGHT (to / newer) -->
              <td class="gutter-num" aria-hidden="true">{row.toNum ?? ''}</td>
              <td class="gutter-glyph" aria-label={row.toSegs ? `${row.type === 'equal' ? 'unchanged' : row.type === 'modify' ? 'modified' : 'added'} line` : 'empty'}>
                {#if row.toSegs}
                  {row.type === 'equal' ? '=' : row.type === 'modify' ? '+' : '+'}
                {/if}
              </td>
              <td class="line line-to" class:empty-side={!row.toSegs}>
                {#if row.toSegs}
                  {#each row.toSegs as seg, segIdx (segIdx)}
                    {#if seg.changed}
                      <span class="char-change">{seg.text}</span>
                    {:else}{seg.text}{/if}
                  {/each}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .artifact-diff {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
  }

  .diff-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 12px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    background: var(--bg-surface, transparent);
  }

  .diff-arrow {
    color: var(--text-faint);
  }

  .diff-empty {
    padding: 48px 16px;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
    font-family: inherit;
  }

  .diff-scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  .diff-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  /* Gutter columns. */
  .gutter-num {
    width: 52px;
    padding: 0 8px;
    text-align: right;
    color: var(--text-faint);
    border-right: 1px solid var(--border);
    user-select: none;
    vertical-align: top;
    white-space: nowrap;
  }

  .gutter-glyph {
    width: 18px;
    padding: 0 4px;
    text-align: center;
    color: var(--text-faint);
    user-select: none;
    vertical-align: top;
    white-space: nowrap;
  }

  /* Line content cells. */
  .line {
    padding: 0 8px;
    vertical-align: top;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }

  .line.empty-side {
    background: var(--bg-surface, transparent);
  }

  /* Row backgrounds per diff type. */
  .row.remove .line-from,
  .row.remove .line {
    background: rgba(248, 81, 73, 0.12);
  }
  .row.add .line-to,
  .row.add .line {
    background: rgba(63, 185, 80, 0.12);
  }
  .row.modify .line-from {
    background: rgba(248, 81, 73, 0.12);
  }
  .row.modify .line-to {
    background: rgba(63, 185, 80, 0.12);
  }

  /* Unified (narrow) rows use the type class on the <tr> directly. */
  .unified .row.remove .line {
    background: rgba(248, 81, 73, 0.12);
  }
  .unified .row.add .line {
    background: rgba(63, 185, 80, 0.12);
  }

  /* Inline char-level highlight within a modified row. Underline + bolder
     colour are the non-colour signalling per R2-5. */
  .row.remove .char-change,
  .row.modify .line-from .char-change,
  .unified .row.remove .char-change {
    background: rgba(248, 81, 73, 0.35);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  .row.add .char-change,
  .row.modify .line-to .char-change,
  .unified .row.add .char-change {
    background: rgba(63, 185, 80, 0.35);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  /* Equal rows: neutral. */
  .row.equal .line {
    background: transparent;
  }
</style>
