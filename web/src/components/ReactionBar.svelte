<script>
  let { reactions = [], onAddReaction, onToggleReaction } = $props();
</script>

<div class="reactions">
  {#each reactions as reaction}
    <button
      class="reaction"
      class:active={reaction.active}
      onclick={() => onToggleReaction?.(reaction.emoji)}
      aria-label="{reaction.emoji} reaction, {reaction.count} {reaction.count === 1 ? 'person' : 'people'}"
      aria-pressed={reaction.active}
    >
      <span class="emoji" aria-hidden="true">{reaction.emoji}</span>
      <span class="count">{reaction.count}</span>
    </button>
  {/each}
  <button class="reaction-add" onclick={() => onAddReaction?.()} aria-label="Add reaction">+</button>
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
    gap: 5px;
    padding: 4px 10px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.10);
    font-size: 12px;
    cursor: pointer;
    transition: var(--transition-fast);
    user-select: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
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
    border-color: rgba(245,158,11,0.4);
    background: rgba(245,158,11,0.12);
    box-shadow: 0 1px 4px rgba(245, 158, 11, 0.15);
  }

  .emoji { font-size: 15px; }
  .count { color: var(--text-secondary); font-size: 11px; font-weight: 700; }
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
