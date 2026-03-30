<!--
  @component ForwardPicker
  @description Overlay dialog that lets the user forward a message to another channel. Displays a filterable list of available channels (excluding the current one) with their topics.
  @prop {Array} channels - Array of channel objects with id and optional topic fields.
  @prop {string} currentChannel - The ID of the current channel (excluded from the list).
  @prop {Function} onSelect - Callback invoked with the selected channel ID.
  @prop {Function} onClose - Callback invoked when the picker is dismissed.
-->
<script>
  import { X, Forward } from 'lucide-svelte';

  let { channels = [], currentChannel = '', onSelect, onClose } = $props();

  let filteredChannels = $derived(
    channels.filter(c => c.id !== currentChannel)
  );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="forward-overlay" onmousedown={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="forward-picker" onmousedown={(e) => e.stopPropagation()}>
    <div class="forward-header">
      <Forward size={14} strokeWidth={2} />
      <span class="forward-title">Forward to channel</span>
      <button class="forward-close" onclick={onClose} aria-label="Close forward picker">
        <X size={14} strokeWidth={2} />
      </button>
    </div>
    <div class="forward-list">
      {#each filteredChannels as channel (channel.id)}
        <button
          class="forward-item"
          onclick={() => onSelect(channel.id)}
        >
          <span class="channel-hash">#</span>
          <span class="channel-name">{channel.id}</span>
          {#if channel.topic}
            <span class="channel-topic">{channel.topic}</span>
          {/if}
        </button>
      {/each}
      {#if filteredChannels.length === 0}
        <div class="forward-empty">No other channels available</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .forward-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.15s ease;
  }

  .forward-picker {
    width: 340px;
    max-height: 400px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 12px);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .forward-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ember-400);
  }

  .forward-title {
    font-size: 13px;
    font-weight: 700;
    flex: 1;
  }

  .forward-close {
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
  }

  .forward-close:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .forward-list {
    overflow-y: auto;
    padding: 6px;
  }

  .forward-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: none;
    background: none;
    border-radius: var(--radius-sm, 8px);
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
    text-align: left;
    color: var(--text-primary);
  }

  .forward-item:hover {
    background: var(--bg-surface);
  }

  .channel-hash {
    color: var(--text-faint);
    font-size: 14px;
    font-weight: 300;
  }

  .channel-name {
    font-size: 13px;
    font-weight: 600;
  }

  .channel-topic {
    font-size: 11px;
    color: var(--text-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-left: 4px;
  }

  .forward-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-faint);
    font-size: 12px;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes scaleIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }
</style>
