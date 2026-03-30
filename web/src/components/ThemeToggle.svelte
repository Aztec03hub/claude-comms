<script>
  let { mode = 'dark', onToggle } = $props();
</script>

<button class="theme-toggle" onclick={onToggle} title="Toggle theme">
  {#if mode === 'dark'}
    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="4"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></svg>
  {:else}
    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13.5 12.5A7 7 0 013.5 2.5 7 7 0 0013.5 12.5z"/></svg>
  {/if}
</button>

<style>
  .theme-toggle {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .theme-toggle:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }
</style>
