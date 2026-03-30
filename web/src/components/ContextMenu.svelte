<script>
  let { x = 0, y = 0, message = null, onAction, onClose } = $props();

  // Clamp position to keep menu within viewport
  const MENU_WIDTH = 200;
  const MENU_HEIGHT = 290; // approximate height of all items
  let clampedX = $derived(Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  let clampedY = $derived(Math.min(y, window.innerHeight - MENU_HEIGHT - 8));

  function handleAction(action) {
    onAction({ action, message });
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<!-- Escape handled by App.svelte global handler -->

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-backdrop" onclick={handleBackdrop}>
  <div class="context-menu" style="top: {clampedY}px; left: {clampedX}px;" data-testid="context-menu">
    <button class="ctx-item" onclick={() => handleAction('reply')} data-testid="ctx-reply">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4L1 7.5 5 11"/><path d="M1 7.5h8a4 4 0 014 4v.5"/></svg>
      <span>Reply</span>
      <span class="ctx-kbd">R</span>
    </button>
    <button class="ctx-item" onclick={() => handleAction('forward')} data-testid="ctx-forward">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7h8 M7 3l4 4-4 4"/></svg>
      <span>Forward</span>
    </button>
    <button class="ctx-item" onclick={() => handleAction('pin')} data-testid="ctx-pin">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 2l5 5-3 3-1 4-4-4-4 1 3-3z"/></svg>
      <span>Pin Message</span>
      <span class="ctx-kbd">P</span>
    </button>
    <button class="ctx-item" onclick={() => handleAction('copy')} data-testid="ctx-copy">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><path d="M3 9V2.5A1.5 1.5 0 014.5 1H9"/></svg>
      <span>Copy Text</span>
      <span class="ctx-kbd">C</span>
    </button>
    <div class="ctx-divider"></div>
    <button class="ctx-item" onclick={() => handleAction('react')} data-testid="ctx-react">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="7" r="5.5"/><path d="M5 8.5s.8 1 2 1 2-1 2-1"/></svg>
      <span>React</span>
    </button>
    <button class="ctx-item" onclick={() => handleAction('unread')} data-testid="ctx-unread">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h10 M4 3V2h6v1 M3 3v9a1 1 0 001 1h6a1 1 0 001-1V3"/></svg>
      <span>Mark Unread</span>
    </button>
    <div class="ctx-divider"></div>
    <button class="ctx-item danger" onclick={() => handleAction('delete')} data-testid="ctx-delete">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h10 M4 3V2h6v1 M3 3v9a1 1 0 001 1h6a1 1 0 001-1V3 M6 6v4 M8 6v4"/></svg>
      <span>Delete</span>
      <span class="ctx-kbd">Del</span>
    </button>
  </div>
</div>

<style>
  .ctx-backdrop {
    position: fixed;
    inset: 0;
    z-index: 199;
  }

  .context-menu {
    position: fixed;
    z-index: 200;
    width: 200px;
    background: rgba(37, 37, 40, 0.96);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm);
    box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02);
    padding: 4px;
    animation: ctxIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .ctx-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: var(--transition-fast);
    font-size: 13px;
    color: var(--text-secondary);
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    font-family: inherit;
  }

  .ctx-item:hover { background: var(--bg-surface); color: var(--text-primary); }
  .ctx-item.danger { color: #ef4444; }
  .ctx-item.danger:hover { background: rgba(239,68,68,0.1); color: #f87171; }
  .ctx-item :global(svg) { flex-shrink: 0; opacity: 0.7; }
  .ctx-item span { flex: 1; }

  .ctx-item .ctx-kbd {
    font-size: 9px;
    color: var(--text-faint);
    font-family: 'SF Mono', Consolas, monospace;
  }

  .ctx-divider {
    height: 1px;
    background: var(--border);
    margin: 4px 8px;
  }
</style>
