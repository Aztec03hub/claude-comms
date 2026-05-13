<!--
  @component ConversationBrowser
  @description Browse-channels surface. v0.4.0 Step 2.14 dual-mode refactor:
    - Standalone mode (default, back-compat): slide-out panel that displays
      ALL conversations on the server, with its own filter input + close
      button + outer panel chrome.
    - Embedded mode (`embedded={true}`): renders ONLY the body content as the
      Browse-tab of `ChannelDirectoryModal.svelte` (Step 2.13). The parent
      provides the modal chrome + filter input + sort dropdown; this
      component consumes those via `filterValue` / `sortKey` / `onChannelClick`.

    Both modes render the Spec §4.4 sub-section headers:
      - "Public listed"
      - "Public unlisted (accessible)"
      - "Archived"
      - "My private channels"

    Sort is LOCKED to alphabetical per Phil's SORT-LOCK invariant (architecture
    spec §III.4 preamble). The `sortKey` prop is accepted only so the parent
    can flow its dropdown state through; non-'alphabetical' values are
    refused with a console.warn + fallback.

  @prop {object} store - The ChatStore instance (uses store.channelsById +
    its $derived projections).
  @prop {Function} [onClose] - Callback invoked to close the panel (standalone
    mode only).
  @prop {Function} [onJoinChannel] - (channelName) => void. Standalone-mode
    join callback. Preserved for back-compat with App.svelte's current call
    site.
  @prop {string} [filterValue] - Parent-controlled filter string. When
    undefined, the component uses its own internal filter input. When
    provided, the internal input is HIDDEN and this drives row filtering.
  @prop {string} [sortKey] - Parent-controlled sort key. Locked to
    'alphabetical' per Phil's SORT-LOCK; any other value falls back to
    alphabetical with a console.warn.
  @prop {boolean} [embedded] - When true, strip the outer panel chrome
    (header bar, close button, slide-in container). Defaults to false.
  @prop {Function} [onChannelClick] - (channelId) => void. Parent overrides
    the default row-click behavior. In modal context: clicking a row should
    close the modal + invoke this. Used instead of `onJoinChannel` when
    provided.
-->
<script>
  /**
   * v0.4.0 Step 2.14 refactor (Wave 0 contract per §I.17): when used as the
   * Browse tab body of ChannelDirectoryModal, this component receives the
   * filter + sort state from the parent. Standalone usage (today) still
   * works — props default to controlling-internal-state behavior.
   *
   * NEW PROPS (Step 2.14 implementation agent must add these and respect
   * the names exactly):
   *
   * @prop {string} [filterValue] — Parent-controlled filter. When undefined,
   *   ConversationBrowser uses its own internal filter input as today.
   *   When provided, the internal input is HIDDEN and the parent's value drives row filtering.
   *
   * @prop {string} [sortKey] — Parent-controlled sort key. Locked to
   *   'alphabetical' per Phil's SORT-LOCK invariant. The parent's
   *   ChannelDirectoryModal renders a disabled dropdown showing
   *   "Alphabetical (locked)"; this component just consumes the value.
   *
   * @prop {boolean} [embedded] — When true, strip the outer panel chrome
   *   (the parent ChannelDirectoryModal provides it). When false / undefined,
   *   render standalone (back-compat for any non-modal call sites).
   *
   * @prop {Function} [onChannelClick] — (channelId) => void. Parent overrides
   *   the default row-click behavior (which is currently store.switchChannel).
   *   In modal context: clicking a row should close the modal + call this.
   *
   * Step 2.14's implementation agent ALSO adds the Spec-§4.4 sub-section
   * headers ("Public listed" / "Public unlisted (accessible)" / "Archived"
   * / "My private") — these come from the store's $derived projections
   * available on `store` (already exposed since Step 2.6).
   */
  import { Compass, X, Users, Clock, Hash, Lock, Search, LogIn } from 'lucide-svelte';
  import { formatTime } from '../lib/utils.js';

  let {
    store,
    onClose,
    onJoinChannel,
    filterValue,
    sortKey,
    embedded = false,
    onChannelClick,
  } = $props();

  // ── Internal filter state (used only in standalone mode when the parent
  //    hasn't provided `filterValue`). The component's own filter input
  //    writes here; the parent's input (in embedded mode) writes to its
  //    own state and passes the result in via `filterValue`. ───────────
  let internalFilter = $state('');

  // The effective filter string — parent-controlled when `filterValue` is
  // a string (including empty); otherwise the internal $state. We treat
  // `undefined` (not provided) as the signal to use internal state, so the
  // parent can intentionally pass an empty string for "no filter, but I'm
  // controlling it".
  let effectiveFilter = $derived(
    typeof filterValue === 'string' ? filterValue : internalFilter,
  );

  // SORT-LOCK invariant. The component only knows one sort: alphabetical.
  // If a parent passes anything else, we warn (so a future contributor
  // sees the violation in the console) and fall back to alpha. The
  // $effect fires on every change to `sortKey`; a non-alpha value
  // surfaces a console.warn so the violation is loud in dev.
  $effect(() => {
    if (typeof sortKey === 'string' && sortKey !== 'alphabetical') {
      // eslint-disable-next-line no-console
      console.warn(
        `[ConversationBrowser] sortKey="${sortKey}" ignored — SORT-LOCK invariant requires 'alphabetical'.`,
      );
    }
  });

  // ── Sub-section derivations (Spec §4.4) ──────────────────────────────
  // Source from store.channelsById so we get the live $state-tracked
  // projection without depending on the order of insertion. Each section
  // is alpha-sorted via localeCompare per SORT-LOCK.
  function alphaSort(list) {
    return [...list].sort((a, b) =>
      (a.name || a.id || '').localeCompare(b.name || b.id || ''),
    );
  }

  let allChannels = $derived(Object.values(store?.channelsById ?? {}));

  // "Public listed" — joinable strangers (the classic Available section).
  let publicListed = $derived(
    alphaSort(
      allChannels.filter(
        (c) =>
          c?.mode === 'public' &&
          c?.visibility === 'listed' &&
          !c?.member &&
          !c?.archived,
      ),
    ),
  );

  // "Public unlisted (accessible)" — user IS a member, channel is unlisted.
  // Surfaced here because the user has access (so it's discoverable from
  // their own browse view) but it's not in the joinable public listing.
  let publicUnlistedAccessible = $derived(
    alphaSort(
      allChannels.filter(
        (c) =>
          c?.mode === 'public' &&
          c?.visibility === 'unlisted' &&
          c?.member === true &&
          !c?.archived,
      ),
    ),
  );

  // "Archived" — regardless of mode/visibility.
  let archived = $derived(alphaSort(allChannels.filter((c) => c?.archived === true)));

  // "My private channels" — user IS a member, channel mode is private.
  let privateChannels = $derived(
    alphaSort(
      allChannels.filter(
        (c) => c?.mode === 'private' && c?.member === true && !c?.archived,
      ),
    ),
  );

  // ── Filter application ──────────────────────────────────────────────
  // Live-filter each sub-section on name + topic, case-insensitive.
  function applyFilter(list, q) {
    if (!q) return list;
    const needle = q.toLowerCase();
    return list.filter((c) => {
      const name = (c?.name || c?.id || '').toLowerCase();
      const topic = (c?.topic || '').toLowerCase();
      return name.includes(needle) || topic.includes(needle);
    });
  }

  let filteredPublicListed = $derived(applyFilter(publicListed, effectiveFilter));
  let filteredPublicUnlisted = $derived(
    applyFilter(publicUnlistedAccessible, effectiveFilter),
  );
  let filteredArchived = $derived(applyFilter(archived, effectiveFilter));
  let filteredPrivate = $derived(applyFilter(privateChannels, effectiveFilter));

  // Total row count across all sub-sections (drives the empty state).
  let totalRows = $derived(
    filteredPublicListed.length +
      filteredPublicUnlisted.length +
      filteredArchived.length +
      filteredPrivate.length,
  );

  // Header badge count (standalone-mode chrome). Counts all rows (the
  // pre-filter union) so the badge doesn't flicker as the user types.
  let unfilteredTotalRows = $derived(
    publicListed.length +
      publicUnlistedAccessible.length +
      archived.length +
      privateChannels.length,
  );

  // ── Row click dispatch ──────────────────────────────────────────────
  // Two-tier dispatch:
  //   1. If `onChannelClick` is provided (embedded mode), call it. The
  //      parent decides whether to switch / join / close-modal.
  //   2. Else fall back to the standalone-mode behavior: invoke the
  //      original `onJoinChannel` callback with the channel name (matches
  //      App.svelte's current call site which does `switchChannel(name)`
  //      + close).
  function handleRowClick(channel) {
    if (typeof onChannelClick === 'function') {
      onChannelClick(channel.id);
      return;
    }
    if (typeof onJoinChannel === 'function') {
      onJoinChannel(channel.name ?? channel.id);
    }
  }

  function handleJoinButtonClick(event, channel) {
    // Explicit Join button in standalone mode preserves prior UX (clicking
    // Join on a non-member row calls onJoinChannel with the name).
    event.stopPropagation();
    if (typeof onJoinChannel === 'function') {
      onJoinChannel(channel.name ?? channel.id);
    } else if (typeof onChannelClick === 'function') {
      onChannelClick(channel.id);
    }
  }
</script>

{#snippet sectionHeader(label, count)}
  <div class="browser-section-header" data-testid="browser-section-header-{label}">
    <span class="browser-section-label">{label}</span>
    <span class="browser-section-count" aria-label="{count} channels">{count}</span>
  </div>
{/snippet}

{#snippet channelRow(channel, joinable)}
  {@const isPrivate = channel?.mode === 'private'}
  {@const memberCount = typeof channel?.memberCount === 'number' ? channel.memberCount : 0}
  <div
    class="browser-item"
    class:joined={channel?.member}
    role="button"
    tabindex="0"
    data-testid="browser-item-{channel.id}"
    onclick={() => handleRowClick(channel)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleRowClick(channel);
      }
    }}
  >
    <div class="browser-item-top">
      <div class="browser-item-icon">
        {#if isPrivate}
          <Lock size={14} strokeWidth={2} />
        {:else}
          <Hash size={14} strokeWidth={2} />
        {/if}
      </div>
      <span class="browser-item-name">{channel.name || channel.id}</span>
      {#if joinable && !channel?.member}
        <button
          type="button"
          class="browser-join-btn"
          onclick={(e) => handleJoinButtonClick(e, channel)}
          data-testid="browser-join-{channel.id}"
          title="Join this conversation"
        >
          <LogIn size={12} strokeWidth={2} />
          Join
        </button>
      {:else if channel?.member}
        <span class="browser-joined-badge" aria-label="You are a member">
          Joined
        </span>
      {/if}
    </div>
    {#if channel?.topic}
      <div class="browser-item-topic">{channel.topic}</div>
    {/if}
    <div class="browser-item-meta">
      {#if memberCount > 0}
        <span class="browser-meta-item">
          <Users size={11} strokeWidth={2} />
          {memberCount}
        </span>
      {/if}
      {#if channel?.lastActivity}
        <span class="browser-meta-item">
          <Clock size={11} strokeWidth={2} />
          {formatTime(channel.lastActivity, 'relative')}
        </span>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet bodyContent()}
  {#if !embedded}
    <!-- Standalone-mode internal filter input. Hidden when embedded —
         the parent ChannelDirectoryModal renders its own. -->
    <div class="browser-filter-row" data-testid="browser-filter-row">
      <Search size={14} strokeWidth={2} />
      <input
        type="text"
        class="browser-filter-input"
        placeholder="Filter channels…"
        bind:value={internalFilter}
        data-testid="browser-filter-input"
        aria-label="Filter channels"
      />
    </div>
  {/if}

  <div class="browser-list" data-testid="browser-list">
    {#if totalRows === 0}
      <div class="browser-empty">
        <div class="browser-empty-icon muted">
          <Compass size={24} strokeWidth={1.5} />
        </div>
        <div class="browser-empty-title">
          {effectiveFilter ? `No channels match "${effectiveFilter}"` : 'No channels yet'}
        </div>
        {#if !effectiveFilter}
          <div class="browser-empty-hint">There are no conversations on the server yet.</div>
        {/if}
      </div>
    {:else}
      {#if filteredPublicListed.length > 0}
        {@render sectionHeader('Public listed', filteredPublicListed.length)}
        {#each filteredPublicListed as channel (channel.id)}
          {@render channelRow(channel, true)}
        {/each}
      {/if}

      {#if filteredPublicUnlisted.length > 0}
        {@render sectionHeader('Public unlisted (accessible)', filteredPublicUnlisted.length)}
        {#each filteredPublicUnlisted as channel (channel.id)}
          {@render channelRow(channel, false)}
        {/each}
      {/if}

      {#if filteredPrivate.length > 0}
        {@render sectionHeader('My private channels', filteredPrivate.length)}
        {#each filteredPrivate as channel (channel.id)}
          {@render channelRow(channel, false)}
        {/each}
      {/if}

      {#if filteredArchived.length > 0}
        {@render sectionHeader('Archived', filteredArchived.length)}
        {#each filteredArchived as channel (channel.id)}
          {@render channelRow(channel, false)}
        {/each}
      {/if}
    {/if}
  </div>
{/snippet}

{#if embedded}
  <!-- Embedded mode: render the body content only; parent provides chrome. -->
  <div
    class="conversation-browser embedded"
    data-testid="conversation-browser"
    data-embedded="true"
  >
    {@render bodyContent()}
  </div>
{:else}
  <!-- Standalone mode: full slide-out panel with header, filter input,
       close button — the v0.3.x behavior preserved verbatim. -->
  <div
    class="conversation-browser"
    data-testid="conversation-browser"
    data-embedded="false"
    role="complementary"
    aria-label="Browse conversations"
  >
    <div class="browser-header">
      <div class="browser-header-top">
        <Compass size={16} strokeWidth={2} />
        <span class="browser-header-title">Browse Conversations</span>
        {#if unfilteredTotalRows > 0}
          <span class="browser-count-badge">{unfilteredTotalRows}</span>
        {/if}
        <button
          class="browser-close-btn"
          onclick={() => onClose?.()}
          data-testid="conversation-browser-close"
          title="Close"
          aria-label="Close conversation browser"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
    {@render bodyContent()}
  </div>
{/if}

<style>
  .conversation-browser {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    z-index: 104;
    background: rgba(20, 20, 22, 0.96);
    backdrop-filter: blur(16px);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 32px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    animation: searchSlide 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  /* Embedded mode: the parent ChannelDirectoryModal provides the chrome.
     Reset the standalone slide-out positioning + background so we render
     as a plain flex column inside the modal's tab body. */
  .conversation-browser.embedded {
    position: static;
    width: 100%;
    height: 100%;
    background: transparent;
    backdrop-filter: none;
    border-left: none;
    box-shadow: none;
    animation: none;
  }

  .browser-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .browser-header-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .browser-header-top > :global(svg) {
    color: var(--ember-400);
    flex-shrink: 0;
  }

  .browser-header-title {
    font-size: 14px;
    font-weight: 700;
    flex: 1;
  }

  .browser-count-badge {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-faint);
    background: var(--bg-surface);
    padding: 1px 7px;
    border-radius: 8px;
  }

  .browser-close-btn {
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
    flex-shrink: 0;
    margin-left: auto;
  }

  .browser-close-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  /* ── Internal filter row (standalone mode only) ── */
  .browser-filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-deepest);
  }

  .browser-filter-row > :global(svg) {
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .browser-filter-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 12.5px;
    font-family: inherit;
    outline: none;
  }

  .browser-filter-input::placeholder {
    color: var(--text-faint);
  }

  /* ── List ── */
  .browser-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  /* ── Sub-section headers (Spec §4.4) ── */
  .browser-section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 8px 4px 8px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    font-weight: 700;
  }

  .browser-section-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-faint);
    background: var(--bg-surface);
    padding: 0 6px;
    border-radius: 8px;
    line-height: 1.6;
  }

  .browser-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    margin-bottom: 6px;
    transition: var(--transition-fast);
    cursor: pointer;
    text-align: left;
  }

  .browser-item:last-child {
    margin-bottom: 0;
  }

  .browser-item:hover {
    border-color: var(--ember-700);
    background: var(--bg-elevated);
  }

  .browser-item:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3);
  }

  .browser-item-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .browser-item-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: var(--bg-deepest);
    border: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .browser-item-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .browser-item-topic {
    font-size: 11.5px;
    color: var(--text-muted);
    padding-left: 32px;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .browser-item-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-left: 32px;
  }

  .browser-meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--text-faint);
  }

  .browser-meta-item :global(svg) {
    color: var(--text-faint);
    opacity: 0.7;
  }

  /* ── Join Button ── */
  .browser-join-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 6px;
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    border: none;
    color: #0a0a0c;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
    flex-shrink: 0;
    font-family: inherit;
  }

  .browser-join-btn:hover {
    filter: brightness(1.1);
    box-shadow: 0 2px 8px rgba(245, 158, 11, 0.25);
  }

  /* ── Joined Badge ── */
  .browser-joined-badge {
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.15);
    color: var(--ember-400);
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    font-family: inherit;
  }

  /* ── Empty State ── */
  .browser-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    gap: 8px;
    animation: emptyFadeIn 0.4s ease both;
  }

  .browser-empty-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(245, 158, 11, 0.06);
    border: 1px solid rgba(245, 158, 11, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ember-400);
    opacity: 0.7;
    margin-bottom: 4px;
  }

  .browser-empty-icon.muted {
    background: var(--bg-surface);
    border-color: var(--border);
    color: var(--text-faint);
  }

  .browser-empty-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .browser-empty-hint {
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
    line-height: 1.5;
  }

  @keyframes emptyFadeIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes searchSlide {
    from {
      transform: translateX(20px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
</style>
