<!--
  @component CodeBlock
  @description Renders a syntax-highlighted code block with line numbers, language label, and a copy-to-clipboard button. Uses a keyword-based highlighter tuned to the Carbon Ember color palette.
  @prop {string} language - The programming language label displayed in the header (default: 'code').
  @prop {string} code - Raw code string (used if lines is empty).
  @prop {Array<string>} lines - Pre-split array of code lines (takes precedence over code).
-->
<script>
  import { Copy, Check } from 'lucide-svelte';

  let { language = '', code = '', lines = [] } = $props();

  let copied = $state(false);

  function copyCode() {
    const text = lines.length ? lines.join('\n') : code;
    navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);
  }

  let codeLines = $derived(
    lines.length ? lines : code.split('\n')
  );

  /* Simple keyword-based syntax highlighting tokens for Carbon Ember palette */
  const kwSet = new Set([
    'const','let','var','function','return','if','else','for','while','do',
    'switch','case','break','continue','class','extends','import','export',
    'from','default','new','this','typeof','instanceof','in','of','try',
    'catch','finally','throw','async','await','yield','void','delete',
    'true','false','null','undefined','def','self','print','elif','pass',
    'lambda','with','as','raise','except','None','True','False'
  ]);

  function highlightLine(text) {
    // Tokenize with a regex that captures strings, comments, numbers, and words
    return text.replace(
      /(\/\/.*$|#.*$)|(["'`])(?:(?!\2|\\).|\\.)*\2|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_]\w*\b)/gm,
      (match, comment, _q, num, word) => {
        if (comment) return `<span class="hl-comment">${match}</span>`;
        if (_q) return `<span class="hl-string">${match}</span>`;
        if (num) return `<span class="hl-number">${match}</span>`;
        if (word && kwSet.has(word)) return `<span class="hl-keyword">${match}</span>`;
        if (word && /^[A-Z]/.test(word)) return `<span class="hl-type">${match}</span>`;
        return match;
      }
    );
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let highlightedLines = $derived(
    codeLines.map(line => highlightLine(escapeHtml(line)))
  );
</script>

<div class="code-block-wrap">
  <div class="code-block-header">
    <span class="code-lang">{language || 'code'}</span>
    <button
      class="code-copy-btn"
      class:copied
      onclick={copyCode}
      aria-label={copied ? 'Copied to clipboard' : 'Copy code to clipboard'}
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
  <pre class="code-block">{#each highlightedLines as html, i}<span class="line"><span class="line-num">{i + 1}</span><span class="line-code">{@html html}</span>
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

  /* ── Syntax Highlighting: Carbon Ember Palette ── */
  .code-block :global(.hl-keyword) {
    color: var(--ember-400, #f59e0b);
    font-weight: 600;
  }

  .code-block :global(.hl-string) {
    color: #34d399;
  }

  .code-block :global(.hl-comment) {
    color: #4a4540;
    font-style: italic;
  }

  .code-block :global(.hl-number) {
    color: #c084fc;
  }

  .code-block :global(.hl-type) {
    color: #67e8f9;
  }

  /* Light theme syntax overrides */
  :global(:root[data-theme="light"]) .code-block :global(.hl-keyword) {
    color: var(--ember-600, #b45309);
  }

  :global(:root[data-theme="light"]) .code-block :global(.hl-string) {
    color: #059669;
  }

  :global(:root[data-theme="light"]) .code-block :global(.hl-comment) {
    color: #b5b0a8;
  }

  :global(:root[data-theme="light"]) .code-block :global(.hl-number) {
    color: #9333ea;
  }

  :global(:root[data-theme="light"]) .code-block :global(.hl-type) {
    color: #0891b2;
  }
</style>
