<script>
  import { getInitials, getParticipantColor } from '../lib/utils.js';

  let { query = '', participants = [], onSelect, onClose } = $props();

  let filtered = $derived(
    participants.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 8)
  );

  let selectedIndex = $state(0);

  function handleKeydown(e) {
    if (e.key === 'ArrowDown') {
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      selectedIndex = Math.max(selectedIndex - 1, 0);
      e.preventDefault();
    } else if (e.key === 'Enter' && filtered.length > 0) {
      onSelect(filtered[selectedIndex].name);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if filtered.length > 0}
  <div class="mention-dropdown">
    {#each filtered as p, i (p.key)}
      {@const color = getParticipantColor(p.key)}
      <button
        class="mention-item"
        class:selected={i === selectedIndex}
        onclick={() => onSelect(p.name)}
      >
        <div class="mention-avatar" style="background: {color.gradient}">
          {getInitials(p.name)}
        </div>
        <div class="mention-info">
          <span class="mention-name" style="color: {color.textColor}">{p.name}</span>
          <span class="mention-type">{p.type}</span>
        </div>
      </button>
    {/each}
  </div>
{/if}

<style>
  .mention-dropdown {
    position: absolute;
    bottom: 100%;
    left: 16px;
    margin-bottom: 8px;
    width: 260px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03);
    padding: 4px;
    z-index: 20;
    animation: panelIn 0.2s ease both;
  }

  .mention-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: var(--transition-fast);
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    font-family: inherit;
    color: var(--text-primary);
  }

  .mention-item:hover, .mention-item.selected {
    background: var(--bg-surface);
  }

  .mention-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: #0a0a0c;
    flex-shrink: 0;
  }

  .mention-info {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .mention-name { font-size: 13px; font-weight: 600; }
  .mention-type { font-size: 10px; color: var(--text-faint); }
</style>
