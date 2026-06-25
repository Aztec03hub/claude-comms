<!--
  @component ReactionBar
  @description Displays a row of emoji reaction pills below a message, each
    showing the emoji and its count. Active reactions (from the current user)
    are highlighted. Includes a "+" button to add new reactions.

    Who-reacted (reactions hover feature): hovering or keyboard-focusing a pill
    reveals an interactive tooltip listing up to MAX_TOOLTIP_NAMES reactor names
    (then "+N others"), with a "See all" control that opens the full
    ReactionDetailsPanel. The tooltip is itself hoverable so the pointer can
    move into it to click "See all". On touch / no-hover devices a 500ms
    long-press on the pill opens the panel; a short tap still toggles.

    The pill's own click STAYS a reaction toggle (regression-critical).

  @prop {Array} reactions - Reaction objects: { emoji, count, active, users[] }.
    ``users`` is the source of truth (server insertion order); count/active are
    derived from it upstream in the store.
  @prop {Function} onAddReaction - Opens the emoji picker for a new reaction.
  @prop {Function} onToggleReaction - Invoked with the emoji to toggle a reaction.
  @prop {Function} [resolveReactor] - ``(actorKey) => { name, isSelf }`` used to
    render reactor names at render time (reactive to the participant map). Self
    renders as "You". Falls back to the raw key when omitted.
  @prop {Function} [onOpenDetails] - ``(emoji, anchorRect) => void`` opens the
    ReactionDetailsPanel anchored to the pill. Fired by "See all" and long-press.
-->
<script>
  const MAX_TOOLTIP_NAMES = 3;
  const LONG_PRESS_MS = 500;

  let {
    reactions = [],
    onAddReaction,
    onToggleReaction,
    resolveReactor,
    onOpenDetails,
  } = $props();

  /** Default resolver when none is injected (key passthrough, no self mark). */
  function resolve(key) {
    return resolveReactor ? resolveReactor(key) : { name: key, isSelf: false };
  }

  /** The display label for a reactor key ("You" for self). */
  function reactorLabel(key) {
    const { name, isSelf } = resolve(key);
    return isSelf ? 'You' : name;
  }

  /**
   * Tooltip text: up to MAX_TOOLTIP_NAMES names joined by ", ", then
   * "+N others" when there are more reactors (edge-map N2 wording).
   */
  function tooltipText(reaction) {
    const users = reaction.users ?? [];
    const shown = users.slice(0, MAX_TOOLTIP_NAMES).map(reactorLabel);
    const overflow = users.length - shown.length;
    const names = shown.join(', ');
    return overflow > 0 ? `${names} +${overflow} others` : names;
  }

  // ── Long-press (touch / no-hover panel open) ──
  let pressTimer = null;
  let longPressed = false;

  function startPress(event, reaction) {
    longPressed = false;
    const rect = event.currentTarget.getBoundingClientRect();
    pressTimer = setTimeout(() => {
      longPressed = true;
      onOpenDetails?.(reaction.emoji, rect);
    }, LONG_PRESS_MS);
  }

  function cancelPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function handlePillClick(reaction) {
    cancelPress();
    if (longPressed) {
      // The long-press already opened the panel; do NOT also toggle.
      longPressed = false;
      return;
    }
    onToggleReaction?.(reaction.emoji);
  }

  function openDetailsFromTooltip(event, reaction) {
    const wrap = event.currentTarget.closest('.reaction-wrap');
    const pill = wrap?.querySelector('.reaction');
    const rect = (pill ?? event.currentTarget).getBoundingClientRect();
    onOpenDetails?.(reaction.emoji, rect);
  }
</script>

<div class="reactions">
  {#each reactions as reaction (reaction.emoji)}
    <span class="reaction-wrap">
      <button
        class="reaction"
        class:active={reaction.active}
        onclick={() => handlePillClick(reaction)}
        onpointerdown={(e) => startPress(e, reaction)}
        onpointerup={cancelPress}
        onpointerleave={cancelPress}
        onpointercancel={cancelPress}
        aria-label="{reaction.emoji} reaction, {reaction.count} {reaction.count === 1 ? 'person' : 'people'}"
        aria-pressed={reaction.active}
      >
        <span class="emoji" aria-hidden="true">{reaction.emoji}</span>
        <span class="count">{reaction.count}</span>
      </button>
      <span class="reaction-tooltip" role="tooltip">
        <span class="tooltip-names">{tooltipText(reaction)}</span>
        <button
          type="button"
          class="tooltip-see-all"
          onclick={(e) => openDetailsFromTooltip(e, reaction)}
        >
          See all
        </button>
      </span>
    </span>
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

  .reaction-wrap {
    position: relative;
    display: inline-flex;
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

  /* ── Interactive hover/focus tooltip ── */
  .reaction-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(37, 37, 40, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    font-size: 12px;
    color: var(--text-primary, #f1f1f3);
    /* Hidden until the pill (or tooltip) is hovered / focused. visibility
       (not display:none) keeps the "See all" button focusable once shown. */
    visibility: hidden;
    opacity: 0;
    transition: opacity 100ms ease, visibility 100ms ease;
    pointer-events: none;
  }

  /* The tooltip is a DOM descendant of .reaction-wrap, so :hover on the wrap
     stays true while the pointer is over the tooltip — letting the user move
     into it to click "See all". :focus-within covers the keyboard path. */
  .reaction-wrap:hover .reaction-tooltip,
  .reaction-wrap:focus-within .reaction-tooltip {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
  }

  .tooltip-names { color: var(--text-secondary, #c8c8cf); }

  .tooltip-see-all {
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--ember-400, #fbbf24);
  }

  .tooltip-see-all:hover,
  .tooltip-see-all:focus-visible {
    text-decoration: underline;
    outline: none;
  }

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
