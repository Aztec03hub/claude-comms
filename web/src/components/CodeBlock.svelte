<script>
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
</script>

<div class="code-block-wrap">
  <div class="code-block-header">
    <span class="code-lang">{language || 'code'}</span>
    <button class="code-copy-btn" class:copied onclick={copyCode}>
      {#if copied}
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l3 3 5-6"/></svg>
        Copied!
      {:else}
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><path d="M3 9V2.5A1.5 1.5 0 014.5 1H9"/></svg>
        Copy
      {/if}
    </button>
  </div>
  <pre class="code-block">{#each codeLines as line, i}<span class="line"><span class="line-num">{i + 1}</span>{line}
</span>{/each}</pre>
</div>

<style>
  .code-block-wrap {
    margin-top: 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: #0e0e11;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  }

  .code-block-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 14px;
    background: #141417;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
    font-family: 'SF Mono', Consolas, monospace;
  }

  .code-lang {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 10px;
    color: var(--ember-400);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .code-copy-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-faint);
    cursor: pointer;
    padding: 3px 10px;
    font-size: 10px;
    font-family: inherit;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: var(--transition-fast);
  }

  .code-copy-btn:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border-color: var(--text-faint);
  }

  .code-copy-btn.copied {
    color: var(--ember-300);
    border-color: var(--ember-600);
  }

  .code-block {
    padding: 16px 18px;
    font-family: 'SF Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.75;
    overflow-x: auto;
    color: #c9c5bd;
    margin: 0;
  }

  .code-block .line {
    display: flex;
    padding: 0 2px;
    border-radius: 3px;
    transition: background 0.1s;
  }

  .code-block .line:hover {
    background: rgba(245,158,11,0.04);
  }

  .code-block .line:hover .line-num {
    color: var(--ember-500);
    opacity: 1;
  }

  .code-block .line-num {
    user-select: none;
    width: 28px;
    flex-shrink: 0;
    text-align: right;
    color: var(--text-faint);
    margin-right: 16px;
    opacity: 0.5;
  }
</style>
