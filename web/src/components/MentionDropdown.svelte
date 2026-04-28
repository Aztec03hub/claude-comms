<!--
  @component MentionDropdown
  @description Pure-presentational autocomplete dropdown shown above the
    message input when typing @mentions. The dropdown does NOT capture
    keyboard focus — its parent (MessageInput) owns all keyboard handling
    and passes the highlighted index down. Click on a candidate to commit.
  @prop {Array<{name:string,key:string,online:boolean}>} candidates - Pre-filtered, capped, sorted list (see `lib/mentions.js`).
  @prop {number} highlightIndex - Index of the currently-highlighted candidate.
  @prop {(index:number) => void} onHover - Called when the user hovers a candidate (parent updates highlight).
  @prop {(candidate:object) => void} onCommit - Called when the user clicks a candidate.
  @prop {string} listboxId - DOM id used for ARIA wiring (textarea aria-controls + aria-activedescendant).
-->
<script>
  import { getInitials, getParticipantColor } from '../lib/utils.js';

  let {
    candidates = [],
    highlightIndex = 0,
    onHover,
    onCommit,
    listboxId = 'mention-listbox',
  } = $props();

  /**
   * Build a stable DOM id for each candidate row so the parent can wire
   * `aria-activedescendant` on the textarea to the highlighted row.
   *
   * @param {string} key
   * @returns {string}
   */
  function optionId(key) {
    return listboxId + '-opt-' + key;
  }
</script>

<div
  class="mention-dropdown"
  role="listbox"
  id={listboxId}
  aria-label="Mention suggestions"
  data-testid="mention-dropdown"
>
  {#if candidates.length === 0}
    <div class="mention-empty" data-testid="mention-empty">No matches</div>
  {:else}
    {#each candidates as p, i (p.key)}
      {@const color = getParticipantColor(p.key)}
      {@const isHighlighted = i === highlightIndex}
      <button
        type="button"
        role="option"
        id={optionId(p.key)}
        aria-selected={isHighlighted}
        class="mention-item"
        class:selected={isHighlighted}
        data-testid={'mention-item-' + p.key}
        onmouseenter={() => onHover?.(i)}
        onfocus={() => onHover?.(i)}
        onmousedown={(e) => {
          // mousedown (not click) so we commit BEFORE the textarea blurs;
          // preventDefault keeps the textarea focused so the parent can
          // restore the cursor at the inserted token's end.
          e.preventDefault();
          onCommit?.(p);
        }}
      >
        <div class="mention-avatar" style="background: {color.gradient}">
          {getInitials(p.name)}
        </div>
        <div class="mention-info">
          <span class="mention-name" style="color: {color.textColor}">{p.name}</span>
          {#if p.online}
            <span class="mention-online-dot" aria-label="online" title="online"></span>
          {/if}
        </div>
      </button>
    {/each}
  {/if}
</div>

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
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03);
    padding: 4px;
    z-index: 20;
    animation: panelIn 0.2s ease both;
  }

  .mention-empty {
    padding: 10px 12px;
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
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

  .mention-item:hover,
  .mention-item.selected {
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
    align-items: center;
    gap: 6px;
  }

  .mention-name {
    font-size: 13px;
    font-weight: 600;
  }

  .mention-online-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.18);
  }
</style>
