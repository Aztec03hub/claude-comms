<script>
  import { Sun, Moon } from 'lucide-svelte';
  let { mode = 'dark', onToggle } = $props();
</script>

<button class="theme-toggle" onclick={onToggle} title="Toggle theme" data-testid="theme-toggle">
  {#if mode === 'dark'}
    <Sun size={16} strokeWidth={2} />
  {:else}
    <Moon size={16} strokeWidth={2} />
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
