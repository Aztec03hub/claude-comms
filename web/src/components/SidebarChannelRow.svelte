<!--
  @component SidebarChannelRow
  @description Atomic sidebar row that renders ONE channel. Used by all three
    sidebar sections (Starred / Active / Available) in v0.4.0 — see Step 2.9
    (`SidebarChannelSection.svelte`) and Step 2.12 (`Sidebar.svelte` rewrite).
    Layout left-to-right: mode glyph (Hash / Lock), channel name, member-count
    chip, topic preview (Available only), unread badge or mention dot (Active +
    Starred only), mute icon (when muted), star button.

    Per the SORT-LOCK constraint (architecture spec §III.4 preamble), this
    component does NOT sort — it renders one row. Sorting lives in the
    store's $derived projections (`starredChannels`, `activeChannels`,
    `availableChannels`).

    Per the ChannelRow data contract (Design Spec §13.4), the `channel`
    prop carries every field the store populates: id, name, topic, member,
    memberCount, lastActivity, mode, visibility, starred, muted, muteLevel,
    unread, unreadHasMention, unreadFrom, createdAt, createdBy, archived,
    archived_at, archived_by. The store guarantees no `undefined` leaks
    (#channelRowFromPayload), so this component reads fields directly
    without optional-chaining guards.

  A11y note: the row root is a `<div role="button" tabindex="0">` rather
  than a real `<button>` element because we nest a real `<button>` (the
  star toggle) inside it. The HTML spec forbids nested `<button>` (the
  browser silently repairs the DOM by moving/closing the inner button,
  which breaks Svelte's tree assumptions). The keydown handler on the
  row maps Enter/Space → click so keyboard activation still works, and
  `aria-pressed` on the row signals selection state for assistive tech.

  @prop {object} channel - ChannelRow object from the store's $derived
    projection. Required. Must carry the full ChannelRow contract.
  @prop {boolean} isActive - True when this is the currently-viewing
    channel (`channel.id === store.activeChannel`). Drives the
    `--row-active-bg` background + ember left-border accent.
  @prop {'starred'|'active'|'available'} sectionVariant - Which section
    rendered this row. Drives variant-specific decisions documented
    inline below:
      starred   → star icon always visible + filled; unread badge shown;
                  member-count chip hover-only; topic line hidden.
      active    → star icon hover-only + hollow; unread badge shown;
                  member-count chip hover-only; topic line hidden.
      available → star icon hover-only + hollow; unread badge NOT shown
                  (Available-section channels are non-member, no unread
                  state applies); member-count chip always visible;
                  topic line rendered on a second line with 1-line clamp.
    Default: 'active' — matches the most common section by row count.
  @prop {(id: string) => void} onClick - Invoked with the channel id when
    the row body is activated (mouse click, Enter, Space). The star
    button stops propagation so this fires for clicks anywhere EXCEPT
    the star icon.
  @prop {(event: Event, id: string) => void} onContextMenu - Invoked on
    right-click. The component does NOT call `event.preventDefault()`
    itself; the caller decides (the Step 2.10 `ChannelContextMenu`
    component will call preventDefault to suppress the browser's native
    context menu).
  @prop {(id: string) => void} onStarToggle - Invoked when the star
    button is clicked. The click event has `stopPropagation()` called
    on it inside this component so the row-level onClick does NOT also
    fire (this is the same pattern as the existing Sidebar.svelte
    G-4 fix).
  @prop {'fly'|'crossfade'|'instant'} [transitionFlavor='fly'] -
    Forwarded by the parent SidebarChannelSection. Surfaced on the row
    root as `data-transition-flavor` for tests + DevTools inspection.
    The row itself does NOT mount its own Svelte transitions — the
    parent section owns the wrapper that animates (4-phase choreography
    in Design Spec §10). This prop is purely an inspection breadcrumb
    so other components (e.g. the future omnibar in Step 2.19) can
    suppress duplicate animations when they're already in flight.
-->

<script>
  import { Hash, Lock, Star, VolumeX } from 'lucide-svelte';

  let {
    channel,
    isActive = false,
    sectionVariant = 'active',
    transitionFlavor = 'fly',
    onClick,
    onContextMenu,
    onStarToggle,
  } = $props();

  // The store's #channelRowFromPayload guarantees these fields exist, but
  // we still apply defensible defaults at the read site so a hand-rolled
  // test fixture that omits a field doesn't crash the render (matches the
  // permissive shape the existing Sidebar.svelte / sidebar-fixes.spec.js
  // pattern uses).
  let mode = $derived(channel?.mode || 'public');
  let isPrivate = $derived(mode === 'private');
  let memberCount = $derived(typeof channel?.memberCount === 'number' ? channel.memberCount : 0);
  let unread = $derived(typeof channel?.unread === 'number' ? channel.unread : 0);
  let unreadHasMention = $derived(channel?.unreadHasMention === true);
  let muted = $derived(channel?.muted === true);
  let starred = $derived(channel?.starred === true);
  let topic = $derived(channel?.topic || '');
  let displayName = $derived(channel?.name || channel?.id || '');

  // Per-section visibility decisions. The store-side derivations
  // (starredChannels/activeChannels/availableChannels) already partition
  // by section, so a row's actual `starred` field is redundant with
  // `sectionVariant === 'starred'` — but we still drive the star ICON
  // off the section variant so the visual matches the section the row
  // lives in (e.g. a row rendered in the Available section that
  // somehow has starred=true would still show the hover-hollow variant,
  // which is the right thing because the user can't have starred a
  // channel they're not a member of — Design Spec §2.6 starred-but-left
  // auto-unstar).
  let showUnreadBadge = $derived(
    (sectionVariant === 'active' || sectionVariant === 'starred') && unread > 0,
  );
  let showMentionDot = $derived(showUnreadBadge && unreadHasMention);
  let showTopicLine = $derived(sectionVariant === 'available');
  let showStarFilled = $derived(sectionVariant === 'starred');
  let memberChipAlwaysVisible = $derived(sectionVariant === 'available');
  let showMemberChip = $derived(memberCount >= 2);

  // ARIA: the star button gets a Star/Unstar label that includes the
  // channel name so screen-reader users hear an unambiguous action.
  // `aria-pressed` flips to track current starred state.
  let starAriaLabel = $derived(starred ? `Unstar ${displayName}` : `Star ${displayName}`);

  function handleClick() {
    if (typeof onClick === 'function') {
      onClick(channel.id);
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }

  function handleContextMenu(e) {
    if (typeof onContextMenu === 'function') {
      onContextMenu(e, channel.id);
    }
  }

  // The star button stops propagation so the row-level onClick does
  // NOT fire when the user clicks the star (otherwise starring a
  // channel would also switch to it — same fix as Sidebar G-4 in
  // v0.3.3 Step 1.4). The parent (`Sidebar.svelte` / Step 2.12) is
  // responsible for deciding what onStarToggle does (toggle the
  // store's per-channel starred flag, optimistic-then-revert, etc.).
  function handleStarToggle(e) {
    e.stopPropagation();
    if (typeof onStarToggle === 'function') {
      onStarToggle(channel.id);
    }
  }
</script>

<div
  class="channel-row"
  class:active={isActive}
  class:unread={unread > 0}
  class:muted
  class:starred-section={sectionVariant === 'starred'}
  class:active-section={sectionVariant === 'active'}
  class:available-section={sectionVariant === 'available'}
  class:member-chip-always={memberChipAlwaysVisible}
  role="button"
  tabindex="0"
  aria-pressed={isActive}
  onclick={handleClick}
  onkeydown={handleKeydown}
  oncontextmenu={handleContextMenu}
  data-testid="sidebar-channel-row-{channel?.id ?? ''}"
  data-section={sectionVariant}
  data-transition-flavor={transitionFlavor}
>
  <span class="row-glyph" aria-hidden="true">
    {#if isPrivate}
      <Lock size={16} strokeWidth={2} />
    {:else}
      <Hash size={16} strokeWidth={2} />
    {/if}
  </span>

  <span class="row-body">
    <span class="row-name" data-testid="row-name-{channel?.id ?? ''}">{displayName}</span>
    {#if showTopicLine && topic}
      <span class="row-topic" data-testid="row-topic-{channel?.id ?? ''}">{topic}</span>
    {/if}
  </span>

  {#if showMemberChip}
    <span
      class="row-member-chip"
      class:always-visible={memberChipAlwaysVisible}
      data-testid="row-member-chip-{channel?.id ?? ''}"
      aria-label="{memberCount} members"
    >
      {memberCount}
    </span>
  {/if}

  {#if showUnreadBadge}
    {#if showMentionDot}
      <span
        class="row-mention-dot"
        data-testid="row-mention-dot-{channel?.id ?? ''}"
        aria-label="{unread} unread including a mention"
      ></span>
    {:else}
      <span
        class="row-unread-badge"
        data-testid="row-unread-badge-{channel?.id ?? ''}"
        aria-label="{unread} unread"
      >
        {unread}
      </span>
    {/if}
  {/if}

  {#if muted}
    <span
      class="row-mute"
      aria-label="Muted"
      data-testid="row-mute-{channel?.id ?? ''}"
    >
      <VolumeX size={12} strokeWidth={2.25} />
    </span>
  {/if}

  <span
    class="row-star-wrap"
    class:always-visible={showStarFilled}
  >
    <button
      type="button"
      class="row-star-btn"
      class:starred={showStarFilled || starred}
      onclick={handleStarToggle}
      aria-label={starAriaLabel}
      aria-pressed={starred}
      data-testid="row-star-{channel?.id ?? ''}"
    >
      {#if showStarFilled || starred}
        <Star size={12} strokeWidth={2} fill="currentColor" />
      {:else}
        <Star size={12} strokeWidth={2} />
      {/if}
    </button>
  </span>
</div>

<style>
  .channel-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    margin: 1px 0;
    border-radius: var(--radius-sm, 6px);
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font: inherit;
    position: relative;
    /* Reserve space for the 3px ember left-border accent shown when
       `isActive` is true (matches the existing Sidebar.svelte styling
       so visual parity with the v0.3.x rows stays close). */
    padding-left: 13px;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .channel-row:hover {
    background: var(--row-hover-bg, var(--bg-surface, rgba(255, 255, 255, 0.03)));
  }

  .channel-row.muted {
    opacity: 0.5;
  }
  .channel-row.muted:hover {
    opacity: 0.75;
  }

  .channel-row.active {
    background: var(--row-active-bg, var(--bg-surface, rgba(255, 255, 255, 0.04)));
    box-shadow: 0 0 16px rgba(245, 158, 11, 0.08),
      inset 0 0 0 1px rgba(245, 158, 11, 0.1);
  }

  .channel-row.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 60%;
    border-radius: 0 3px 3px 0;
    background: var(--ember-500, #f59e0b);
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.4), 0 0 4px rgba(245, 158, 11, 0.6);
  }

  .channel-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3);
  }

  .row-glyph {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    color: var(--text-faint, #6b6b6b);
  }
  .channel-row.active .row-glyph {
    color: var(--ember-300, #fcd34d);
  }

  .row-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    gap: 1px;
  }

  .row-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary, inherit);
    /* 18ch truncation per spec §III.4 step 2.8 visual element #2. */
    max-width: 18ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .channel-row.unread .row-name {
    font-weight: 700;
  }
  .channel-row.active .row-name {
    color: var(--ember-300, #fcd34d);
  }

  .row-topic {
    font-size: 11px;
    color: var(--text-muted, var(--text-faint, #6b6b6b));
    /* Single-line ellipsis clamp per spec for Available section. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  .row-member-chip {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-faint, #6b6b6b);
    background: var(--bg-elevated, rgba(255, 255, 255, 0.04));
    border-radius: 9px;
    padding: 1px 7px;
    line-height: 1.4;
    /* Hover-only by default (matches Active/Starred variants). */
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .channel-row:hover .row-member-chip {
    opacity: 1;
  }

  /* Available section: chip is always visible regardless of hover. */
  .row-member-chip.always-visible {
    opacity: 1;
  }

  .row-unread-badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    color: #0a0a0c;
    background: linear-gradient(
      135deg,
      var(--ember-500, #f59e0b),
      var(--ember-400, #fbbf24)
    );
    border-radius: 10px;
    padding: 1px 7px;
    min-width: 18px;
    text-align: center;
    line-height: 1.4;
    box-shadow: 0 0 10px rgba(245, 158, 11, 0.3),
      0 0 2px rgba(245, 158, 11, 0.5);
  }

  /* Mention dot variant — replaces the numeric badge when an @mention is
     among the unread set. Persists on muted channels per Design Spec §8.2;
     the muted modifier above only reduces row opacity, it does not hide
     the dot. */
  .row-mention-dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ember-400, #fbbf24);
    box-shadow: 0 0 6px rgba(251, 191, 36, 0.5);
  }

  .row-mute {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint, #6b6b6b);
  }

  .row-star-wrap {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Hover-only by default — overridden by .always-visible for the
       Starred section so filled stars persist outside of hover. */
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .channel-row:hover .row-star-wrap {
    opacity: 1;
  }
  .row-star-wrap.always-visible {
    opacity: 1;
  }

  .row-star-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--text-faint, #6b6b6b);
    cursor: pointer;
    padding: 0;
    transition: color 0.12s ease, background 0.12s ease;
  }
  .row-star-btn:hover {
    color: var(--ember-400, #fbbf24);
    background: var(--bg-elevated, rgba(245, 158, 11, 0.06));
  }
  .row-star-btn.starred {
    color: var(--ember-500, #f59e0b);
  }
  .row-star-btn.starred:hover {
    color: var(--ember-300, #fcd34d);
  }
  .row-star-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.4);
  }
</style>
