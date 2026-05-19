<!--
  @component SidebarChannelSection
  @description Collapsible left-sidebar section that renders a header (icon +
  label + count + chevron) and a body region containing channel rows. Drives
  all three v0.4.0 sidebar sections (Starred / Active / Available) with
  different props. Mirrors the MemberList M-FIX (v0.3.3) invariant — the
  header ALWAYS renders, regardless of row count, so the section remains a
  stable UI surface that users can locate, collapse, and trust.

  @prop {string} label - Section title shown in the header (e.g. "Starred").
  @prop {Component} icon - Lucide icon component rendered at the head of the
    header (e.g. ``Star`` / ``Hash`` / ``Globe``).
  @prop {Array} channels - Pre-sorted array of ChannelRow objects from the
    store. The caller (Sidebar shell, Step 2.12) owns sort order.
  @prop {string} [activeChannelId] - id of the currently-viewed channel; the
    matching row receives ``isActive=true`` and renders highlighted.
  @prop {string} emptyState - Muted, italic line shown inside the body when
    ``channels.length === 0``. The body still renders so the section retains
    its vertical rhythm.
  @prop {string} storageKey - Per-section localStorage key used to persist
    the expanded/collapsed boolean across reloads.
  @prop {boolean} [defaultExpanded=true] - Initial expanded state used when
    ``storageKey`` is absent from localStorage.
  @prop {Function} [onChannelClick] - Forwarded to SidebarChannelRow as
    ``(id) => void``.
  @prop {Function} [onChannelContextMenu] - Forwarded as
    ``(event, id) => void``.
  @prop {Function} [onStarToggle] - Forwarded as ``(id) => void``.
  @prop {(channelId: string) => {policy: 'All' | 'Mentions' | 'Off', highlightWords: string[]}} [getNotificationPolicy] -
    v0.4.2 Wave G follow-up [VERIFY-WAVE-G-3]: optional resolver injected
    by Sidebar.svelte that returns the per-channel notification policy for
    each row. Forwarded into SidebarChannelRow as the ``notificationPolicy``
    prop, evaluated per-row at render time so reactive map writes in
    ``store.notificationPolicies`` propagate (see Sidebar.svelte's
    ``getChannelNotificationPolicy`` helper, which touches the $state
    map to register a dependency). When omitted, rows fall back to the
    Wave G default (``{policy: 'All', highlightWords: []}``) so the
    bell-icon variant stays off and pre-G consumers (tests, legacy
    mounts) keep their current render exactly.
  @prop {'fly'|'crossfade'|'instant'} [transitionFlavor='fly'] - Selects
    which animation primitives wrap each row's mount/unmount. ``'fly'``
    plays the 4-phase channelFly{In,Out} + channelSlide composition
    (Design Spec §10 cross-section moves). ``'crossfade'`` uses the
    smaller star-toggle pair. ``'instant'`` skips Svelte transitions
    entirely (the row mounts/unmounts in one frame). Reduced-motion
    users always get instant rendering regardless of this prop.
-->

<script>
  import { untrack } from 'svelte';
  import SidebarChannelRow from './SidebarChannelRow.svelte';
  import {
    channelFlyIn,
    channelFlyOut,
    starToggle,
  } from '../lib/transitions/channelMove.svelte.js';

  let {
    label,
    icon,
    channels = [],
    activeChannelId = null,
    emptyState = '',
    storageKey,
    defaultExpanded = true,
    onChannelClick,
    onChannelContextMenu,
    onStarToggle,
    transitionFlavor = 'fly',
    getNotificationPolicy = null,
  } = $props();

  // Pick the in/out transition pair based on the section's flavor. The
  // section's row wrapper applies both `in:` and `out:` so a row entering
  // the section animates in (phases 3+4), and a row leaving (the `{#each}`
  // block's keyed iteration evicts it when the store moves the row to
  // another section) animates out (phases 1+2).
  //
  // Each of channelFlyIn / channelFlyOut now ALSO animates height/padding
  // (the gap-collapse and gap-grow phases) in addition to opacity + slide,
  // because Svelte forbids `transition:` alongside `in:`/`out:` on the
  // same element (svelte.dev/e/transition_conflict). Stacking the box
  // geometry math into the `in:`/`out:` directives is the workaround.
  //
  // 'instant' returns a no-op transition object so Svelte still treats
  // the wrapper as a transition target (and the mount/unmount classes
  // still get applied for testability) but the duration is 0ms.
  let rowFlyIn = $derived.by(() => {
    if (transitionFlavor === 'instant') {
      return (_node) => ({ duration: 0 });
    }
    if (transitionFlavor === 'crossfade') {
      return (node, params) => starToggle(node, { ...params, direction: 'in' });
    }
    return channelFlyIn;
  });
  let rowFlyOut = $derived.by(() => {
    if (transitionFlavor === 'instant') {
      return (_node) => ({ duration: 0 });
    }
    if (transitionFlavor === 'crossfade') {
      return (node, params) => starToggle(node, { ...params, direction: 'out' });
    }
    return channelFlyOut;
  });

  /**
   * Read a boolean-as-"1"/"0" flag from localStorage with a fallback when
   * the key is absent or storage is unavailable (SSR / privacy mode). Same
   * encoding the MemberList M-FIX section toggles use, so user expectations
   * about how this state is stored are consistent across both sidebars.
   */
  function readStoredBool(key, fallback) {
    if (typeof localStorage === 'undefined') return fallback;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw === '1';
    } catch {
      // Storage may throw (Safari private mode, quota); fall back silently.
      return fallback;
    }
  }

  // `storageKey` and `defaultExpanded` are deliberately read once at mount.
  // The section's collapse state is owned by `isExpanded` thereafter — re-
  // reading the prop on every change would defeat the persistence model.
  // `untrack` makes that intent explicit so Svelte doesn't surface a
  // state_referenced_locally warning for reading props inside a $state
  // initializer.
  let isExpanded = $state(
    untrack(() => readStoredBool(storageKey, defaultExpanded)),
  );

  // Persist toggle state on every change. Guarded so SSR + storage-disabled
  // environments don't throw — render still works there, just without
  // persistence.
  $effect(() => {
    if (typeof localStorage === 'undefined' || !storageKey) return;
    try {
      localStorage.setItem(storageKey, isExpanded ? '1' : '0');
    } catch {
      // Quota / disabled storage; swallow.
    }
  });

  // Derive a stable id so the header's aria-controls and body's id stay
  // unique across multiple sections mounted in the same Sidebar (one each
  // for Starred / Active / Available). label is uppercase-letters-only after
  // normalization; falls back to a generic id if the caller passed a weird
  // value so the attribute never empties.
  let bodyId = $derived(
    `sidebar-channel-section-${(label || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-body`,
  );

  // Map the human-facing section ``label`` to the ``sectionVariant`` prop
  // SidebarChannelRow (Step 2.8) expects. The row uses this token to drive
  // its variant-specific visual treatments (unread badge gating, topic-line
  // visibility, star fill, member-chip visibility). Wave E §I.17 retroactive
  // contract reconciliation — added when integration revealed the prop-name
  // drift between agents 2.8 and 2.9.
  let variant = $derived.by(() => {
    if (label === 'Starred') return 'starred';
    if (label === 'Available') return 'available';
    return 'active';
  });

  function toggle() {
    isExpanded = !isExpanded;
  }
</script>

<section class="sidebar-channel-section" data-testid="sidebar-channel-section-{label}">
  <button
    class="sidebar-channel-section-header"
    type="button"
    data-testid="sidebar-channel-section-header-{label}"
    onclick={toggle}
    aria-expanded={isExpanded}
    aria-controls={bodyId}
  >
    <span
      class="sidebar-channel-section-chevron"
      class:expanded={isExpanded}
      aria-hidden="true"
    >▶</span>
    {#if icon}
      {@const IconComponent = icon}
      <span class="sidebar-channel-section-icon" aria-hidden="true">
        <IconComponent size={12} strokeWidth={2.5} />
      </span>
    {/if}
    <span class="sidebar-channel-section-label">{label}</span>
    <span
      class="sidebar-channel-section-count"
      data-testid="sidebar-channel-section-count-{label}"
    >{channels.length}</span>
  </button>

  {#if isExpanded}
    <div
      class="sidebar-channel-section-body"
      id={bodyId}
      role="region"
      aria-label={label}
      data-testid="sidebar-channel-section-body-{label}"
    >
      {#if channels.length === 0}
        <div
          class="sidebar-channel-section-empty"
          data-testid="sidebar-channel-section-empty-{label}"
        >{emptyState}</div>
      {:else}
        {#each channels as channel (channel.id)}
          <!--
            Row wrapper carries the per-row transitions so the section's
            choreography is a property of THIS section, not baked into the
            row. `in:rowFlyIn` runs phases 3+4 (gap-grow + fade-in) for
            arriving rows; `out:rowFlyOut` runs phases 1+2 (fade-out +
            gap-collapse) for departing ones. Both directives also
            animate height/padding/margin/border alongside opacity +
            translate, since Svelte rejects `transition:` alongside
            `in:`/`out:` on the same element. The
            `data-transition-flavor` attribute is exposed for tests and
            for the upcoming Sidebar shell (Step 2.12) so callers can
            inspect what the section is doing per-row.
          -->
          <div
            class="sidebar-channel-section-row-wrap"
            data-testid="sidebar-channel-section-row-wrap-{channel.id}"
            data-transition-flavor={transitionFlavor}
            in:rowFlyIn
            out:rowFlyOut
          >
            <SidebarChannelRow
              {channel}
              isActive={channel.id === activeChannelId}
              sectionVariant={variant}
              {transitionFlavor}
              onClick={onChannelClick}
              onContextMenu={onChannelContextMenu}
              {onStarToggle}
              notificationPolicy={typeof getNotificationPolicy === 'function'
                ? getNotificationPolicy(channel.id)
                : { policy: 'All', highlightWords: [] }}
            />
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</section>

<style>
  .sidebar-channel-section {
    display: flex;
    flex-direction: column;
    margin-top: 4px;
  }

  /*
   * Header button. Matches the MemberList .members-section-button surface so
   * the left and right sidebars feel like siblings — same 10px font, same
   * uppercase letter-spaced label, same 6px gap, same hover treatment.
   */
  .sidebar-channel-section-header {
    width: 100%;
    padding: 10px 16px 4px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.8px;
    color: var(--text-faint);
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .sidebar-channel-section-header:hover {
    color: var(--text-secondary);
  }

  .sidebar-channel-section-header:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3);
    border-radius: 4px;
  }

  /*
   * Chevron rotates from 0deg (collapsed) to 90deg (expanded). 150ms
   * transition matches MemberList; honors prefers-reduced-motion below.
   */
  .sidebar-channel-section-chevron {
    font-size: 8px;
    line-height: 1;
    width: 8px;
    display: inline-block;
    transform: rotate(0deg);
    transform-origin: center;
    transition: transform 150ms ease;
    flex-shrink: 0;
  }

  .sidebar-channel-section-chevron.expanded {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar-channel-section-chevron {
      transition: none;
    }
  }

  .sidebar-channel-section-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .sidebar-channel-section-label {
    flex: 0 0 auto;
  }

  .sidebar-channel-section-count {
    margin-left: auto;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    flex-shrink: 0;
  }

  .sidebar-channel-section-body {
    display: flex;
    flex-direction: column;
    padding: 2px 0 4px;
  }

  /*
   * Row wrapper. Hosts the per-row Svelte transitions (channelFlyIn /
   * channelFlyOut / channelSlide composed from channelMove.svelte.js).
   * Visually transparent — it must NOT add padding or margin or the row's
   * own active-state ember rail (`.channel-row.active::before`, drawn at
   * `left: 0`) would shift away from the sidebar edge. The wrapper does
   * own `overflow: hidden` so the slide(height) transition crops cleanly
   * during the gap-collapse / gap-grow phases.
   */
  .sidebar-channel-section-row-wrap {
    display: block;
    overflow: hidden;
  }

  /*
   * Reduced motion: belt-and-suspenders. The transition functions in
   * channelMove.svelte.js already short-circuit to duration 0 when the
   * user prefers reduced motion, but a stale matchMedia cache (some
   * browsers debounce media-query callbacks under heavy load) could let
   * an animation slip through. This rule kills any remaining CSS-driven
   * transform/opacity transitions on the wrapper itself.
   */
  @media (prefers-reduced-motion: reduce) {
    .sidebar-channel-section-row-wrap {
      transition: none !important;
    }
  }

  /*
   * Inline empty-state placeholder. Muted italic line that holds the body's
   * vertical rhythm even when no rows are present, so collapsing/expanding
   * an empty section behaves the same as a populated one (M-FIX parity).
   */
  .sidebar-channel-section-empty {
    padding: 6px 16px 10px;
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }
</style>
