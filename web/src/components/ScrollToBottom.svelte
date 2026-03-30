<script>
  import { ChevronDown } from 'lucide-svelte';

  let { count = 0, onClick } = $props();
</script>

<button class="scroll-bottom" title="Scroll to bottom" aria-label="Scroll to bottom{count > 0 ? `, ${count} unread messages` : ''}" onclick={onClick} data-testid="scroll-to-bottom">
  <ChevronDown size={16} />
  {#if count > 0}
    <span class="badge">{count}</span>
  {/if}
</button>

<style>
  .scroll-bottom {
    position: absolute;
    bottom: 90px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.03);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: var(--transition-med);
    color: var(--text-muted);
  }

  .scroll-bottom:hover {
    background: var(--bg-surface);
    border-color: var(--ember-700);
    color: var(--ember-300);
    box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 8px rgba(245,158,11,0.1);
    transform: translateX(-50%) translateY(-2px);
  }

  .badge {
    position: absolute;
    top: -6px;
    right: -6px;
    font-size: 9px;
    font-weight: 700;
    color: #0a0a0c;
    background: linear-gradient(135deg, var(--ember-500), var(--ember-400));
    border-radius: 10px;
    padding: 1px 6px;
    min-width: 16px;
    text-align: center;
    box-shadow: 0 0 8px rgba(245,158,11,0.3);
  }
</style>
