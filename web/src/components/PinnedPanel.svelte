<script>
  import { formatTime, getParticipantColor, getInitials } from '../lib/utils.js';

  let { messages = [], onClose } = $props();
</script>

<div class="pinned-panel">
  <div class="pinned-header">
    <div class="pinned-title">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 2l5 5-3 3-1 4-4-4-4 1 3-3z"/></svg>
      Pinned Messages
      <span class="pinned-count">{messages.length}</span>
    </div>
    <button class="pinned-close" onclick={onClose}>&times;</button>
  </div>
  <div class="pinned-list">
    {#each messages as msg (msg.id)}
      {@const color = getParticipantColor(msg.sender.key)}
      <div class="pinned-item">
        <div class="pinned-item-header">
          <div class="pinned-item-avatar" style="background: {color.gradient}">{getInitials(msg.sender.name)}</div>
          <span class="pinned-item-name" style="color: {color.textColor}">{msg.sender.name}</span>
          <span class="pinned-item-time">{formatTime(msg.ts, 'relative')}</span>
        </div>
        <div class="pinned-item-text">{msg.body}</div>
        <div class="pinned-item-pin">
          <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1l3.5 3.5-2 2-.7 2.8L4 6.5l-2.8.7L3 5z"/></svg>
          Pinned by {msg.sender.name}
        </div>
      </div>
    {:else}
      <div class="pinned-empty">No pinned messages yet</div>
    {/each}
  </div>
</div>

<style>
  .pinned-panel {
    position: absolute;
    top: 88px;
    right: 16px;
    z-index: 50;
    width: 340px;
    background: rgba(37, 37, 40, 0.92);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius);
    box-shadow: 0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02);
    overflow: hidden;
    animation: panelIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .pinned-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }

  .pinned-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 700;
  }

  .pinned-title :global(svg) { color: var(--ember-400); }

  .pinned-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-faint);
    background: var(--bg-surface);
    padding: 1px 7px;
    border-radius: 8px;
  }

  .pinned-close {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    font-size: 16px;
  }

  .pinned-close:hover { background: var(--bg-surface); color: var(--text-primary); }

  .pinned-list { padding: 8px; max-height: 300px; overflow-y: auto; }

  .pinned-item {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    margin-bottom: 6px;
    cursor: pointer;
    transition: var(--transition-fast);
  }

  .pinned-item:last-child { margin-bottom: 0; }
  .pinned-item:hover { border-color: var(--ember-700); background: var(--bg-elevated); }

  .pinned-item-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .pinned-item-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    font-weight: 700;
    color: #0a0a0c;
  }

  .pinned-item-name { font-size: 11px; font-weight: 600; }
  .pinned-item-time { font-size: 10px; color: var(--text-faint); margin-left: auto; }

  .pinned-item-text {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .pinned-item-pin {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--text-faint);
    margin-top: 6px;
  }

  .pinned-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-faint);
    font-size: 12px;
  }
</style>
