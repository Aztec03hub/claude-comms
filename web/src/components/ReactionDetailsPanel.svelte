<!--
  @component ReactionDetailsPanel
  @description Top-layer popover listing WHO reacted to a message, per emoji
    (reactions hover feature, plan §4.4 / edge-map M6). Opened by the
    ReactionBar tooltip's "See all" control or a touch long-press.

    Left/top: every emoji on the message as a selectable row (emoji + count +
    a "yours" marker). Selecting an emoji shows, beside/below it, the full list
    of reactors (resolved names; "You" for self, in natural server insertion
    order). Clicking a different emoji re-filters the user list.

    Rendered TOP-LAYER via the ``portal()`` attachment so it escapes ancestor
    ``backdrop-filter`` stacking contexts (side panels), positioned ``fixed``
    from the anchor pill's ``getBoundingClientRect()`` with ``z-index >= 250``
    (ContextMenu uses 200). Closes on Esc, outside-click, or when its last
    emoji is removed; if the selected emoji vanishes it falls back to the next.

  @prop {Array} reactions - Live reaction objects { emoji, count, active,
    users[] } for the message. Reactive — live add/remove updates the open view.
  @prop {Function} resolveReactor - ``(actorKey) => { name, isSelf }``; resolved
    at render time so name changes / late participants reflect automatically.
  @prop {{left:number, bottom:number, top:number, right:number}} anchorRect -
    The anchor pill's bounding rect (viewport coords) for positioning.
  @prop {string} [initialEmoji] - Emoji to select first (defaults to the first).
  @prop {Function} onClose - Invoked on Esc / outside-click / empty.
-->
<script>
  import { tick } from 'svelte';
  import { portal } from '../lib/portal.js';

  let {
    reactions = [],
    resolveReactor,
    anchorRect = null,
    initialEmoji = null,
    onClose,
  } = $props();

  let panelEl = $state(null);

  // Selected emoji. Starts null; the $effect below seeds it (from initialEmoji
  // when valid, else the first reaction) and keeps it valid as reactions
  // mutate live. Writable because clicking an emoji row re-points it.
  let selectedEmoji = $state(null);

  const selectedReaction = $derived(
    reactions.find((r) => r.emoji === selectedEmoji) ?? null
  );
  const selectedUsers = $derived(selectedReaction?.users ?? []);

  // Keep the selection valid as reactions change (live add/remove). If every
  // emoji is gone, close; if the selected one is unset/vanished, seed it from
  // initialEmoji (when still present) or fall to the first emoji.
  $effect(() => {
    if (reactions.length === 0) {
      onClose?.();
      return;
    }
    if (!reactions.some((r) => r.emoji === selectedEmoji)) {
      selectedEmoji =
        initialEmoji && reactions.some((r) => r.emoji === initialEmoji)
          ? initialEmoji
          : reactions[0].emoji;
    }
  });

  /** Display label for a reactor key ("You" for self). */
  function reactorLabel(key) {
    const { name, isSelf } = resolveReactor
      ? resolveReactor(key)
      : { name: key, isSelf: false };
    return isSelf ? 'You' : name;
  }

  // ── Positioning (fixed, from the anchor rect; clamped to the viewport) ──
  const PANEL_W = 280;
  const GAP = 8;
  const pos = $derived.by(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
    const rect = anchorRect ?? { left: 0, bottom: 0, top: 0 };
    let left = rect.left ?? 0;
    if (left + PANEL_W > vw) left = Math.max(8, vw - PANEL_W - 8);
    // Prefer below the pill; flip above if it would overflow the viewport.
    let top = (rect.bottom ?? 0) + GAP;
    const estH = 260;
    if (top + estH > vh && (rect.top ?? 0) - GAP - estH >= 0) {
      top = (rect.top ?? 0) - GAP - estH;
    }
    return { left, top };
  });

  // ── Focus management + outside-click / Esc ──
  $effect(() => {
    if (!panelEl) return;
    tick().then(() => {
      const first = panelEl?.querySelector('[data-emoji-row]');
      if (first instanceof HTMLElement) first.focus();
    });
  });

  function handleWindowMouseDown(event) {
    if (!panelEl) return;
    const target = event.target;
    if (target instanceof Node && panelEl.contains(target)) return;
    onClose?.();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    // Arrow navigation across the emoji list.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const idx = reactions.findIndex((r) => r.emoji === selectedEmoji);
      if (idx === -1) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (idx + delta + reactions.length) % reactions.length;
      selectedEmoji = reactions[next].emoji;
      tick().then(() => {
        const row = panelEl?.querySelector(
          `[data-emoji-row="${reactions[next].emoji}"]`
        );
        if (row instanceof HTMLElement) row.focus();
      });
      return;
    }
    // Simple focus trap: keep Tab within the panel.
    if (event.key === 'Tab') {
      const focusable = panelEl?.querySelectorAll(
        'button, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
</script>

<svelte:window onmousedown={handleWindowMouseDown} />

<div
  bind:this={panelEl}
  class="reaction-details"
  role="dialog"
  aria-label="Who reacted"
  tabindex="-1"
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  onkeydown={handleKeydown}
  {@attach portal()}
>
  <div class="emoji-list" role="tablist" aria-label="Reactions">
    {#each reactions as reaction (reaction.emoji)}
      <button
        type="button"
        class="emoji-row"
        class:selected={reaction.emoji === selectedEmoji}
        role="tab"
        aria-selected={reaction.emoji === selectedEmoji}
        data-emoji-row={reaction.emoji}
        tabindex={reaction.emoji === selectedEmoji ? 0 : -1}
        onclick={() => (selectedEmoji = reaction.emoji)}
      >
        <span class="row-emoji" aria-hidden="true">{reaction.emoji}</span>
        <span class="row-count">{reaction.count}</span>
        {#if reaction.active}
          <span class="row-yours">you</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="user-list" role="tabpanel" aria-label="Reactors">
    {#if selectedReaction}
      <div class="user-list-header">
        <span class="header-emoji" aria-hidden="true">{selectedReaction.emoji}</span>
        <span class="header-count">{selectedUsers.length}</span>
      </div>
      <ul class="users">
        {#each selectedUsers as key (key)}
          <li class="user">{reactorLabel(key)}</li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .reaction-details {
    position: fixed;
    z-index: 250;
    width: 280px;
    max-height: 320px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: rgba(37, 37, 40, 0.98);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
    font-size: 13px;
    color: var(--text-primary, #f1f1f3);
  }

  .emoji-list {
    display: flex;
    gap: 4px;
    padding: 8px;
    overflow-x: auto;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .emoji-row {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.05);
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-secondary, #c8c8cf);
    white-space: nowrap;
    outline: none;
  }

  .emoji-row:hover,
  .emoji-row:focus-visible {
    background: var(--bg-surface, rgba(255, 255, 255, 0.08));
    color: var(--text-primary, #f1f1f3);
  }

  .emoji-row.selected {
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.12);
    color: var(--text-primary, #f1f1f3);
  }

  .row-emoji { font-size: 15px; }
  .row-count { font-size: 11px; font-weight: 700; }
  .row-yours {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ember-400, #fbbf24);
  }

  .user-list {
    padding: 8px;
    overflow-y: auto;
  }

  .user-list-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-bottom: 6px;
    color: var(--text-secondary, #c8c8cf);
  }

  .header-emoji { font-size: 16px; }
  .header-count { font-size: 12px; font-weight: 700; }

  .users {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .user {
    padding: 5px 6px;
    border-radius: 6px;
  }

  .user:hover {
    background: var(--bg-surface, rgba(255, 255, 255, 0.05));
  }
</style>
