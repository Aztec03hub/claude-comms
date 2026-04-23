<!--
  @component CodeBlock
  @description Renders a syntax-highlighted code block with line numbers, language label, and a copy-to-clipboard button. Highlighting is delegated to Shiki via `lib/markdown.js`'s `highlightCode` export — one grammar engine, one theme, across chat code blocks, markdown fences, and artifact `code` bodies.
  @prop {string} language - The programming language label displayed in the header (default: 'code').
  @prop {string} code - Raw code string (used if lines is empty).
  @prop {Array<string>} lines - Pre-split array of code lines (takes precedence over code).
-->
<script>
  import { Copy, Check } from 'lucide-svelte';
  import { highlightCode } from '../lib/markdown.js';

  let { language = '', code = '', lines = [] } = $props();

  let copied = $state(false);

  let codeText = $derived(lines.length ? lines.join('\n') : code);
  let codeLines = $derived(
    lines.length ? lines : code.split('\n')
  );

  // Shiki-powered highlighted HTML lines. Populated asynchronously by the
  // effect below; until the first resolution lands, we render the raw code
  // lines so the block is never empty on mount.
  let highlightedLines = $state([]);

  // Monotonic render token (Pattern A from the "Svelte 5 conventions" section).
  // Every effect run snapshots a fresh token and only applies the awaited
  // result if the snapshot still matches. Guards against stale resolution if
  // `codeText` or `language` change faster than Shiki finishes.
  let renderToken = 0;

  $effect(() => {
    const t = ++renderToken;
    const src = codeText;
    const lang = language;
    highlightCode(src, lang).then((htmlLines) => {
      if (t === renderToken) highlightedLines = htmlLines;
    });
  });

  function copyCode() {
    navigator.clipboard.writeText(codeText);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }
</script>

<div class="code-block-wrap" data-testid="code-block">
  <div class="code-block-header">
    <span class="code-lang" data-testid="code-block-lang">{language || 'code'}</span>
    <button
      class="code-copy-btn"
      class:copied
      onclick={copyCode}
      aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
      data-testid="code-block-copy"
    >
      {#if copied}
        <span class="copy-icon copied-icon"><Check size={12} strokeWidth={2.5} /></span>
        <span class="copy-label">Copied!</span>
      {:else}
        <span class="copy-icon"><Copy size={12} strokeWidth={2} /></span>
        <span class="copy-label">Copy</span>
      {/if}
    </button>
  </div>
  <pre class="code-block" data-testid="code-block-pre">{#each (highlightedLines.length ? highlightedLines : codeLines) as html, i (i)}<span class="line"><span class="line-num">{i + 1}</span><!-- eslint-disable-next-line svelte/no-at-html-tags --><span class="line-code">{@html html}</span>
</span>{/each}</pre>
</div>

<style>
  .code-block-wrap {
    margin-top: 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border, #222225);
    background: #0e0e11;
    overflow: hidden;
    box-shadow: 0 2px 12px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.1);
  }

  :global(:root[data-theme="light"]) .code-block-wrap {
    background: #f8f6f3;
    border-color: var(--border, #d5d0c8);
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }

  .code-block-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px;
    background: #141417;
    border-bottom: 1px solid #222225;
    font-size: 11px;
    color: #3d3a36;
    font-family: 'SF Mono', Consolas, monospace;
  }

  :global(:root[data-theme="light"]) .code-block-header {
    background: #edeae5;
    border-bottom-color: var(--border, #d5d0c8);
    color: #8a8480;
  }

  .code-lang {
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.15);
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 10px;
    color: var(--ember-400);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }

  :global(:root[data-theme="light"]) .code-lang {
    background: rgba(217, 119, 6, 0.08);
    border-color: rgba(217, 119, 6, 0.2);
    color: var(--ember-500, #d97706);
  }

  .code-copy-btn {
    background: none;
    border: 1px solid #222225;
    border-radius: var(--radius-xs);
    color: #3d3a36;
    cursor: pointer;
    padding: 3px 10px;
    font-size: 10px;
    font-family: inherit;
    display: flex;
    align-items: center;
    gap: 5px;
    transition: all 0.15s ease;
  }

  .code-copy-btn:hover {
    background: #252528;
    color: #ede9e3;
    border-color: #3d3a36;
  }

  .code-copy-btn.copied {
    color: var(--ember-300, #fbbf24);
    border-color: var(--ember-600, #b45309);
    background: rgba(245, 158, 11, 0.06);
  }

  :global(:root[data-theme="light"]) .code-copy-btn {
    border-color: var(--border, #d5d0c8);
    color: #8a8480;
  }

  :global(:root[data-theme="light"]) .code-copy-btn:hover {
    background: #ddd9d3;
    color: #1a1816;
    border-color: #b5b0a8;
  }

  .copy-icon {
    display: flex;
    align-items: center;
    transition: transform 0.15s ease;
  }

  .copied-icon {
    animation: checkPop 0.3s ease;
  }

  @keyframes checkPop {
    0% { transform: scale(0.5); opacity: 0; }
    60% { transform: scale(1.2); }
    100% { transform: scale(1); opacity: 1; }
  }

  .copy-label {
    font-weight: 500;
    letter-spacing: 0.3px;
  }

  .code-block {
    padding: 14px 0;
    font-family: 'SF Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.75;
    overflow-x: auto;
    color: #c9c5bd;
    margin: 0;
    counter-reset: line;
  }

  :global(:root[data-theme="light"]) .code-block {
    color: #3d3530;
  }

  .code-block .line {
    display: flex;
    padding: 0 18px 0 0;
    border-radius: 0;
    transition: background 0.1s;
  }

  .code-block .line:hover {
    background: rgba(245,158,11,0.04);
  }

  :global(:root[data-theme="light"]) .code-block .line:hover {
    background: rgba(217,119,6,0.04);
  }

  .code-block .line:hover .line-num {
    color: var(--ember-500, #d97706);
    opacity: 1;
  }

  .code-block .line-num {
    user-select: none;
    width: 42px;
    flex-shrink: 0;
    text-align: right;
    color: #3d3a36;
    padding-right: 16px;
    opacity: 0.4;
    border-right: 1px solid rgba(34,34,37,0.5);
    margin-right: 16px;
    font-size: 11px;
    transition: color 0.1s, opacity 0.1s;
  }

  :global(:root[data-theme="light"]) .code-block .line-num {
    color: #b5b0a8;
    border-right-color: rgba(213,208,200,0.5);
  }

  .code-block .line-code {
    flex: 1;
    min-width: 0;
    white-space: pre;
  }
</style>
