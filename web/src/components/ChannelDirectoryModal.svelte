<!--
  ChannelDirectoryModal.svelte — full-screen modal opened via Ctrl+L or
  "Browse channels…" link in the sidebar's Available section. Hosts two
  tabs: Browse (mounts ConversationBrowser) + Admin (per-channel admin
  for channels you created).

  Wave 0 stub per §I.17. Step 2.13 implementation filled in:
  - Tab state machine + body content
  - Filter input + locked sort dropdown (Phil's SORT-LOCK)
  - Modal a11y (focus trap, Escape closes, return focus to invoker)
  - Admin tab gating + content (Edit topic / Archive / Delete)

  PUBLIC CONTRACT (do not rename or restructure):
-->
<script>
  /**
   * @prop {Object} store — MqttChatStore instance (for channelsById, userProfile, joinChannel, etc.)
   * @prop {boolean} open — when true, modal renders. Two-way bindable.
   * @prop {string} initialTab — 'browse' | 'admin'. Default 'browse'.
   * @prop {string} initialFilter — pre-populates the filter input. Default ''.
   * @prop {Function} onClose — fired when modal should close (Escape, X button, outside click).
   * @prop {Function} onChannelClick — (channelId) => void. Fired when user clicks a row in Browse. Modal closes + invokes this.
   * @prop {Function} onChannelJoin — (channelId) => void. Fired when user clicks Join on a non-member row. Defaults to store.joinChannel.
   */
  import { untrack } from 'svelte';
  import { X, Search, Hash, Lock } from 'lucide-svelte';
  import ConversationBrowser from './ConversationBrowser.svelte';
  import { EMPTY_STATES } from '../lib/copy/emptyStates.js';

  let {
    store,
    open = $bindable(false),
    initialTab = 'browse',
    initialFilter = '',
    onClose,
    onChannelClick,
    onChannelJoin,
  } = $props();

  // Stable ids so aria-labelledby has something to bind to. Suffix with a
  // run-time random tag in case the modal ever mounts twice in the same
  // document (e.g. unmount/remount during a test).
  const idSuffix = Math.random().toString(36).slice(2, 9);
  const titleId = `channel-directory-title-${idSuffix}`;

  // Initialize tab + filter from the props, but wrap in `untrack` so the
  // state initializer doesn't bind reactively to the prop (the prop is
  // the *initial* value; subsequent re-opens are handled in the open
  // $effect below).
  /** @type {'browse' | 'admin'} */
  let activeTab = $state(untrack(() => (initialTab === 'admin' ? 'admin' : 'browse')));
  let filterText = $state(untrack(() => initialFilter));

  /** @type {HTMLDivElement | undefined} */
  let dialogEl = $state();
  /** @type {HTMLInputElement | undefined} */
  let filterInputEl = $state();
  /** @type {HTMLElement | null} */
  let previouslyFocused = null;

  // Owned channels — used by the Admin tab. The store's createdBy field
  // is the channel creator's identity key; userProfile.key is the local
  // identity. Filter out null createdBy entries (legacy rows from before
  // creator-tracking landed) and entries that don't match.
  let ownedChannels = $derived(
    Object.values(store?.channelsById ?? {}).filter(
      (ch) => ch && ch.createdBy && ch.createdBy === store?.userProfile?.key,
    ),
  );
  let hasOwnedChannels = $derived(ownedChannels.length > 0);

  // Inline edit state for the Admin tab's "Edit topic" affordance. Keyed
  // by channel id; only one edit can be active at a time, but we use a
  // map for symmetry with future per-row state.
  /** @type {string | null} */
  let editingTopicId = $state(null);
  let editingTopicValue = $state('');

  // Lifecycle effect: ONLY focus management. Capture
  // previously-focused element when modal opens; restore on close.
  // (Per Svelte 5 best practices, state mutations live outside $effect.)
  $effect(() => {
    if (!open) return;
    previouslyFocused = /** @type {HTMLElement | null} */ (
      typeof document !== 'undefined' ? document.activeElement : null
    );
    // Default focus into the dialog: filter input if Browse tab,
    // otherwise the first focusable element. queueMicrotask defers
    // past Svelte's mount so the bind:this references are live.
    queueMicrotask(() => {
      const activeNow = untrack(() => activeTab);
      if (activeNow === 'browse' && filterInputEl) {
        filterInputEl.focus();
      } else if (dialogEl) {
        const firstFocusable = /** @type {HTMLElement | null} */ (
          dialogEl.querySelector(
            'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
          )
        );
        firstFocusable?.focus();
      }
    });
    return () => {
      // Restore focus on close, but only if the previously-focused
      // element is still in the document and focusable.
      if (
        previouslyFocused &&
        typeof previouslyFocused.focus === 'function' &&
        document.body.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  });

  function close() {
    open = false;
    // Reset internal UI state so a subsequent reopen starts fresh from
    // the props (this is the "re-init on reopen" semantic, executed in
    // the close handler rather than $effect to keep the open-effect
    // side-effect-only).
    activeTab = initialTab === 'admin' ? 'admin' : 'browse';
    filterText = initialFilter;
    editingTopicId = null;
    editingTopicValue = '';
    onClose?.();
  }

  function handleRowClick(channelId) {
    onChannelClick?.(channelId);
    close();
  }

  function handleOverlayClick() {
    close();
  }

  function handleContentClick(e) {
    // Prevent overlay click from firing when clicking inside the dialog.
    e.stopPropagation();
  }

  /**
   * Focus trap + Escape handling at the dialog root.
   * @param {KeyboardEvent} e
   */
  function handleDialogKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      if (!dialogEl) return;
      const focusables = /** @type {HTMLElement[]} */ (
        Array.from(
          dialogEl.querySelectorAll(
            'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = /** @type {HTMLElement | null} */ (document.activeElement);
      if (e.shiftKey) {
        if (active === first || !dialogEl.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialogEl.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  /**
   * Arrow-key navigation on the tab bar. Right/Left moves between Browse
   * and Admin (when Admin is visible). Home/End jump to first/last tab.
   * @param {KeyboardEvent} e
   */
  function handleTabKeydown(e) {
    const tabs = hasOwnedChannels ? ['browse', 'admin'] : ['browse'];
    const idx = tabs.indexOf(activeTab);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      activeTab = /** @type {'browse' | 'admin'} */ (
        tabs[(idx + 1) % tabs.length]
      );
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      activeTab = /** @type {'browse' | 'admin'} */ (
        tabs[(idx - 1 + tabs.length) % tabs.length]
      );
    } else if (e.key === 'Home') {
      e.preventDefault();
      activeTab = /** @type {'browse' | 'admin'} */ (tabs[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      activeTab = /** @type {'browse' | 'admin'} */ (tabs[tabs.length - 1]);
    }
  }

  // ── Admin tab actions ──────────────────────────────────────────────
  // v0.4.0 MVP: window.confirm / window.prompt are placeholders. Proper
  // type-name confirm modals land in v0.4.1.

  function startEditTopic(channel) {
    editingTopicId = channel.id;
    editingTopicValue = channel.topic ?? '';
  }

  function cancelEditTopic() {
    editingTopicId = null;
    editingTopicValue = '';
  }

  async function commitEditTopic(channel) {
    const newTopic = editingTopicValue;
    editingTopicId = null;
    editingTopicValue = '';
    if (newTopic === channel.topic) return;
    if (typeof store?.setTopic === 'function') {
      await store.setTopic(channel.id, newTopic);
    }
  }

  function handleTopicInputKeydown(e, channel) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEditTopic(channel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditTopic();
    }
  }

  function archiveOwnedChannel(channel) {
    const ok =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`Archive #${channel.name}? Members will be kicked.`)
        : true;
    if (!ok) return;
    if (typeof store?.archiveChannel === 'function') {
      store.archiveChannel(channel.id);
    }
  }

  function deleteOwnedChannel(channel) {
    const typed =
      typeof window !== 'undefined' && typeof window.prompt === 'function'
        ? window.prompt(
            `Delete #${channel.name}? Type the channel name to confirm.`,
          )
        : channel.name;
    if (typed !== channel.name) return;
    if (typeof store?.deleteChannel === 'function') {
      store.deleteChannel(channel.id);
    }
  }
</script>

{#if open}
  <div
    class="directory-overlay"
    data-testid="channel-directory-overlay"
    onclick={handleOverlayClick}
    onkeydown={handleDialogKeydown}
    role="presentation"
  >
    <div
      bind:this={dialogEl}
      class="directory-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="channel-directory-modal"
      onclick={handleContentClick}
      onkeydown={handleDialogKeydown}
      tabindex="-1"
    >
      <header class="directory-header">
        <h2 id={titleId} class="directory-title" data-testid="channel-directory-title">
          Channel directory
        </h2>
        <button
          type="button"
          class="directory-close"
          onclick={close}
          aria-label="Close channel directory"
          data-testid="channel-directory-close"
        >
          <X size={18} strokeWidth={2} />
        </button>
      </header>

      <div
        class="directory-tabs"
        role="tablist"
        aria-label="Channel directory sections"
        onkeydown={handleTabKeydown}
        tabindex="-1"
      >
        <button
          type="button"
          role="tab"
          id={`${idSuffix}-browse-tab`}
          aria-selected={activeTab === 'browse'}
          aria-controls={`${idSuffix}-browse-panel`}
          tabindex={activeTab === 'browse' ? 0 : -1}
          class="directory-tab"
          class:active={activeTab === 'browse'}
          onclick={() => (activeTab = 'browse')}
          data-testid="channel-directory-tab-browse"
        >Browse</button>
        {#if hasOwnedChannels}
          <button
            type="button"
            role="tab"
            id={`${idSuffix}-admin-tab`}
            aria-selected={activeTab === 'admin'}
            aria-controls={`${idSuffix}-admin-panel`}
            tabindex={activeTab === 'admin' ? 0 : -1}
            class="directory-tab"
            class:active={activeTab === 'admin'}
            onclick={() => (activeTab = 'admin')}
            data-testid="channel-directory-tab-admin"
          >Admin</button>
        {/if}
      </div>

      {#if activeTab === 'browse'}
        <div
          class="directory-panel"
          role="tabpanel"
          tabindex="0"
          id={`${idSuffix}-browse-panel`}
          aria-labelledby={`${idSuffix}-browse-tab`}
          data-testid="channel-directory-browse-panel"
        >
          <div class="directory-controls">
            <label class="directory-filter">
              <Search size={14} strokeWidth={2} aria-hidden="true" />
              <input
                bind:this={filterInputEl}
                bind:value={filterText}
                type="text"
                placeholder="Filter channels…"
                aria-label="Filter channels"
                data-testid="channel-directory-filter-input"
              />
            </label>

            <label class="directory-sort">
              <span class="directory-sort-label">Sort</span>
              <select
                disabled
                aria-label="Sort order (locked to alphabetical)"
                data-testid="channel-directory-sort-select"
              >
                <option>Alphabetical (locked)</option>
              </select>
            </label>
          </div>

          <div class="directory-browse-body" data-testid="channel-directory-browse-body">
            <ConversationBrowser
              {store}
              filterValue={filterText}
              sortKey="alphabetical"
              embedded={true}
              onChannelClick={handleRowClick}
            />
          </div>
        </div>
      {:else if activeTab === 'admin' && hasOwnedChannels}
        <div
          class="directory-panel"
          role="tabpanel"
          tabindex="0"
          id={`${idSuffix}-admin-panel`}
          aria-labelledby={`${idSuffix}-admin-tab`}
          data-testid="channel-directory-admin-panel"
        >
          <p class="directory-admin-intro">
            Channels you created. Edit the topic, archive when done, or
            permanently delete.
          </p>
          <ul class="directory-admin-list" data-testid="channel-directory-admin-list">
            {#each ownedChannels as channel (channel.id)}
              <li class="directory-admin-row" data-testid={`channel-directory-admin-row-${channel.id}`}>
                <div class="directory-admin-row-main">
                  <div class="directory-admin-row-name">
                    {#if channel.mode === 'private'}
                      <Lock size={14} strokeWidth={2} aria-hidden="true" />
                    {:else}
                      <Hash size={14} strokeWidth={2} aria-hidden="true" />
                    {/if}
                    <span>{channel.name}</span>
                  </div>
                  {#if editingTopicId === channel.id}
                    <input
                      class="directory-admin-topic-input"
                      type="text"
                      bind:value={editingTopicValue}
                      onkeydown={(e) => handleTopicInputKeydown(e, channel)}
                      onblur={() => commitEditTopic(channel)}
                      placeholder="Channel topic"
                      aria-label={`Topic for ${channel.name}`}
                      data-testid={`channel-directory-admin-topic-input-${channel.id}`}
                    />
                  {:else}
                    <p class="directory-admin-topic" data-testid={`channel-directory-admin-topic-${channel.id}`}>
                      {channel.topic || EMPTY_STATES.noTopicSet}
                    </p>
                  {/if}
                </div>
                <div class="directory-admin-row-actions">
                  <button
                    type="button"
                    class="directory-admin-btn"
                    onclick={() => startEditTopic(channel)}
                    data-testid={`channel-directory-admin-edit-${channel.id}`}
                  >Edit topic</button>
                  <button
                    type="button"
                    class="directory-admin-btn"
                    onclick={() => archiveOwnedChannel(channel)}
                    data-testid={`channel-directory-admin-archive-${channel.id}`}
                  >Archive</button>
                  <button
                    type="button"
                    class="directory-admin-btn danger"
                    onclick={() => deleteOwnedChannel(channel)}
                    data-testid={`channel-directory-admin-delete-${channel.id}`}
                  >Delete</button>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .directory-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: overlayIn 0.2s ease both;
  }

  .directory-modal {
    width: 800px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 64px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04);
    animation: modalIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
  }

  .directory-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px 12px;
  }

  .directory-title {
    margin: 0;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.3px;
    color: var(--text-primary);
  }

  .directory-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    padding: 6px;
    display: flex;
    align-items: center;
    transition: var(--transition-fast);
  }

  .directory-close:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .directory-tabs {
    display: flex;
    gap: 4px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
  }

  .directory-tab {
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: var(--transition-fast);
  }

  .directory-tab:hover {
    color: var(--text-primary);
  }

  .directory-tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--ember-500, #f97316);
  }

  .directory-panel {
    flex: 1;
    overflow-y: auto;
    padding: 16px 24px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .directory-controls {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .directory-filter {
    flex: 1;
    min-width: 200px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
  }

  .directory-filter input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }

  .directory-sort {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .directory-sort-label {
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }

  .directory-sort select {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 13px;
    cursor: not-allowed;
    opacity: 0.7;
  }

  .directory-browse-body {
    flex: 1;
    min-height: 200px;
  }

  .directory-admin-intro {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .directory-admin-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .directory-admin-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .directory-admin-row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .directory-admin-row-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .directory-admin-topic {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .directory-admin-topic-input {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }

  .directory-admin-topic-input:focus {
    border-color: var(--ember-500, #f97316);
  }

  .directory-admin-row-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .directory-admin-btn {
    padding: 6px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
  }

  .directory-admin-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .directory-admin-btn.danger {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.3);
  }

  .directory-admin-btn.danger:hover {
    background: rgba(248, 113, 113, 0.1);
    color: #ef4444;
  }

  @keyframes overlayIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes modalIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>
