<script>
  let { reactions = [], onAddReaction, onToggleReaction } = $props();
</script>

<div class="reactions">
  {#each reactions as reaction}
    <button
      class="reaction"
      class:active={reaction.active}
      onclick={() => onToggleReaction?.(reaction.emoji)}
    >
      <span class="emoji">{reaction.emoji}</span>
      <span class="count">{reaction.count}</span>
    </button>
  {/each}
  <button class="reaction-add" onclick={() => onAddReaction?.()}>+</button>
</div>

<style>
  .reactions {
    display: flex;
    gap: 5px;
    padding: 3px 4px;
    flex-wrap: wrap;
  }

  .reaction {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    font-size: 12px;
    cursor: pointer;
    transition: var(--transition-fast);
    user-select: none;
  }

  .reaction:hover {
    border-color: var(--ember-700);
    background: var(--bg-elevated);
    transform: translateY(-1px);
  }

  .reaction:focus-visible {
    box-shadow: 0 0 0 2px rgba(245,158,11,0.3);
  }

  .reaction.active {
    border-color: rgba(245,158,11,0.3);
    background: rgba(245,158,11,0.08);
  }

  .emoji { font-size: 14px; }
  .count { color: var(--text-muted); font-size: 11px; font-weight: 600; }
  .reaction.active .count { color: var(--ember-400); }

  .reaction-add {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 24px;
    border-radius: 12px;
    background: transparent;
    border: 1px dashed var(--border);
    color: var(--text-faint);
    cursor: pointer;
    font-size: 14px;
    transition: var(--transition-fast);
    opacity: 0;
  }

  :global(.msg-row:hover) .reaction-add { opacity: 1; }

  .reaction-add:hover {
    border-color: var(--ember-700);
    border-style: solid;
    color: var(--ember-400);
    background: var(--bg-surface);
  }
</style>
