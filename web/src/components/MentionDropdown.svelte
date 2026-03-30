<script>
  import { Combobox } from 'bits-ui';
  import { getInitials, getParticipantColor } from '../lib/utils.js';

  let { query = '', participants = [], onSelect, onClose } = $props();

  let filtered = $derived(
    participants.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 8)
  );

  let comboValue = $state('');
  let hiddenInputRef = $state(null);

  // Auto-focus the hidden combobox input so bits-ui handles
  // ArrowUp/Down, Enter, and Escape keyboard navigation natively.
  // The external message input passes the query as a prop for filtering.
  $effect(() => {
    if (hiddenInputRef && filtered.length > 0) {
      hiddenInputRef.focus();
    }
  });

  function handleValueChange(value) {
    if (value) {
      const participant = filtered.find(p => p.key === value);
      if (participant) {
        onSelect(participant.name);
      }
    }
  }

  function handleOpenChange(open) {
    if (!open) {
      onClose();
    }
  }
</script>

{#if filtered.length > 0}
  <Combobox.Root
    type="single"
    bind:value={comboValue}
    open={true}
    onOpenChange={handleOpenChange}
    onValueChange={handleValueChange}
    loop={true}
  >
    <Combobox.Input
      bind:ref={hiddenInputRef}
      value={query}
      aria-label="Search participants"
      class="mention-hidden-input"
      data-testid="mention-combobox-input"
    />

    <Combobox.ContentStatic
      data-testid="mention-dropdown"
      trapFocus={false}
      preventScroll={false}
    >
      {#snippet child({ props })}
        {@const { style: _floatingStyle, class: _cls, ...ariaProps } = props}
        <div {...ariaProps} class="mention-dropdown">
          {#each filtered as p (p.key)}
            {@const color = getParticipantColor(p.key)}
            <Combobox.Item value={p.key} label={p.name} data-testid="mention-item-{p.key}">
              {#snippet children({ selected, highlighted })}
                <div class="mention-item" class:selected={highlighted}>
                  <div class="mention-avatar" style="background: {color.gradient}">
                    {getInitials(p.name)}
                  </div>
                  <div class="mention-info">
                    <span class="mention-name" style="color: {color.textColor}">{p.name}</span>
                    <span class="mention-type">{p.type}</span>
                  </div>
                </div>
              {/snippet}
            </Combobox.Item>
          {/each}
        </div>
      {/snippet}
    </Combobox.ContentStatic>
  </Combobox.Root>
{/if}

<style>
  :global(.mention-hidden-input) {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    padding: 0 !important;
    margin: -1px !important;
    overflow: hidden !important;
    clip: rect(0, 0, 0, 0) !important;
    white-space: nowrap !important;
    border: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

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
