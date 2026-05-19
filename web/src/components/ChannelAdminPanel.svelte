<!--
  @component ChannelAdminPanel
  @description Per-channel admin actions surface, rendered inside the
    ChannelDirectoryModal's Admin tab. Action visibility is gated by
    `currentChannelRole` per Q6 lock-in (2026-05-13):
      - 'owner'  -> Rename, Transfer, Visibility, Mode, Archive, Delete
      - 'admin'  -> Rename, Visibility, Mode, Archive (no Transfer, no Delete)
      - 'member' -> empty state: "You don't have admin rights in this channel."
      - null     -> skeleton placeholder while the role table is hydrating

    Destructive actions route through the shared `onConfirmDestructive`
    helper prop-drilled from App.svelte:
      - Archive  -> { severity: 'warning' } (skips typed-name gate)
      - Delete   -> { severity: 'danger'  } (typed-name required)
      - Transfer -> { severity: 'danger'  } (typed-name required for the
        new-owner key; ownership transfer is irreversible from the
        previous owner's side)

    [VERIFY] Store accessor punt — the panel reads `currentChannelRole`
    as a prop. A Wave B serial-chain step should land
    `store.getChannelRole(channelId)` so the modal can populate this
    prop reactively. Until then the modal threads `null` for non-owned
    rows (member) and 'owner' for owned rows (the only role the
    existing createdBy-based projection can synthesize).

    [VERIFY] Store methods punt — the action wiring optimistically calls
    `store.renameChannel`, `store.setVisibility`, `store.setMode`, and
    `store.transferOwnership`. These do NOT exist in mqtt-store yet
    (verified against HEAD 260334b); the panel guards each call with a
    typeof === 'function' check so the buttons are wired but no-op
    cleanly until Wave B lands the methods. The Archive + Delete paths
    DO have backing methods (`archiveChannel`, `deleteChannel`) and
    are fully reachable today.

  @prop {Object} channel - Channel row object from store.channelsById[id].
    Carries id, name, topic, mode, visibility, createdBy, archived, etc.
    Required.
  @prop {'owner'|'admin'|'member'|null} currentChannelRole - Caller's
    role on this channel per Q6. `null` while the role table is still
    hydrating; the panel renders a skeleton placeholder in that case.
  @prop {Object} store - MqttChatStore instance (for the action wiring:
    setTopic, archiveChannel, deleteChannel, plus the [VERIFY] methods
    above). Required.
  @prop {Function} onConfirmDestructive - Promise-based confirm helper
    from App.svelte. Signature: (opts) => Promise<boolean>. Opts shape:
    { resourceName, requireTypedName, title, body, confirmLabel,
      severity: 'danger' | 'warning' }. Required for Archive + Delete
    + Transfer actions to be reachable.
  @prop {Function} [onClose] - Optional. Called after a destructive
    action commits so the parent modal can close itself.
-->
<script>
  import { Hash, Lock, Globe, Pencil, UserPlus, Archive, Trash2 } from 'lucide-svelte';

  let {
    channel,
    currentChannelRole,
    store,
    onConfirmDestructive,
    onClose,
  } = $props();

  // ── Per-role action visibility (Q6 lock-in) ──────────────────────────
  // Derived booleans keep the markup readable. Owner sees all 6 actions;
  // admin sees 4 (no Transfer, no Delete); member sees the empty state.
  // `null` (hydrating) renders the skeleton placeholder.
  let isOwner = $derived(currentChannelRole === 'owner');
  let isAdmin = $derived(currentChannelRole === 'admin');
  let isMember = $derived(currentChannelRole === 'member');
  let isHydrating = $derived(currentChannelRole == null);

  let canRename = $derived(isOwner || isAdmin);
  let canToggleVisibility = $derived(isOwner || isAdmin);
  let canToggleMode = $derived(isOwner || isAdmin);
  let canTransfer = $derived(isOwner);
  let canArchive = $derived(isOwner || isAdmin);
  let canDelete = $derived(isOwner);

  // ── Inline rename state ──────────────────────────────────────────────
  let editingName = $state(false);
  let nameDraft = $state('');

  function startRename() {
    if (!canRename) return;
    editingName = true;
    nameDraft = channel?.name ?? '';
  }

  function cancelRename() {
    editingName = false;
    nameDraft = '';
  }

  async function commitRename() {
    const next = nameDraft.trim();
    editingName = false;
    nameDraft = '';
    if (!next || next === channel?.name) return;
    if (typeof store?.renameChannel === 'function') {
      await store.renameChannel(channel.id, next);
    }
    // [VERIFY] no-op until Wave B lands renameChannel.
  }

  function handleRenameKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelRename();
    }
  }

  // ── Inline topic edit (existing Polish wave behavior) ────────────────
  let editingTopic = $state(false);
  let topicDraft = $state('');

  function startEditTopic() {
    if (!canRename) return;
    editingTopic = true;
    topicDraft = channel?.topic ?? '';
  }

  function cancelEditTopic() {
    editingTopic = false;
    topicDraft = '';
  }

  async function commitEditTopic() {
    const next = topicDraft;
    editingTopic = false;
    topicDraft = '';
    if (next === (channel?.topic ?? '')) return;
    if (typeof store?.setTopic === 'function') {
      await store.setTopic(channel.id, next);
    }
  }

  function handleTopicKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEditTopic();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEditTopic();
    }
  }

  // ── Visibility + Mode toggles ────────────────────────────────────────
  // Visibility: 'public' (discoverable in directory) vs 'private' (hidden
  // from non-members). Mode: 'open' (anyone with the id can join) vs
  // 'invite' (must be added by admin). These are independent dimensions.
  let visibility = $derived(channel?.visibility ?? 'public');
  let mode = $derived(channel?.mode ?? 'open');

  async function toggleVisibility() {
    if (!canToggleVisibility) return;
    const next = visibility === 'public' ? 'private' : 'public';
    if (typeof store?.setVisibility === 'function') {
      await store.setVisibility(channel.id, next);
    }
    // [VERIFY] no-op until Wave B lands setVisibility.
  }

  async function toggleMode() {
    if (!canToggleMode) return;
    const next = mode === 'open' ? 'invite' : 'open';
    if (typeof store?.setMode === 'function') {
      await store.setMode(channel.id, next);
    }
    // [VERIFY] no-op until Wave B lands setMode.
  }

  // ── Transfer ownership ───────────────────────────────────────────────
  // Owner-only. The TypeNameConfirmDialog with severity:'danger' makes
  // the user type the channel name to confirm; a follow-up step (Wave B)
  // will collect the new-owner key via a separate selector. For 3.1 we
  // surface the gated confirm flow + call signature; the actual key
  // selector is documented as the [VERIFY] follow-up.
  let transferPending = $state(false);

  async function startTransfer() {
    if (!canTransfer || transferPending) return;
    if (typeof onConfirmDestructive !== 'function') return;
    transferPending = true;
    try {
      const ok = await onConfirmDestructive({
        resourceName: `channel #${channel.name}`,
        requireTypedName: channel.name,
        title: 'Transfer ownership?',
        body: `Transfer ownership of #${channel.name}. The new owner will gain Delete + Transfer rights and you will be demoted to admin. This cannot be undone from your side.`,
        confirmLabel: 'Transfer ownership',
        severity: 'danger',
      });
      if (!ok) return;
      if (typeof store?.transferOwnership === 'function') {
        await store.transferOwnership(channel.id);
      }
      // [VERIFY] no-op until Wave B lands transferOwnership + the
      // new-owner key picker. onClose intentionally NOT called here:
      // transfer is silent (no modal close) until the new-owner flow
      // is finalized in Wave B.
    } finally {
      transferPending = false;
    }
  }

  // ── Archive (warning severity, no typed-name gate) ───────────────────
  let archivePending = $state(false);

  async function startArchive() {
    if (!canArchive || archivePending) return;
    if (typeof onConfirmDestructive !== 'function') return;
    archivePending = true;
    try {
      const ok = await onConfirmDestructive({
        resourceName: `channel #${channel.name}`,
        requireTypedName: channel.name,
        title: 'Archive channel?',
        body: `This will archive #${channel.name} and remove all members from the live channel list. You can still find it under the directory's Archived view.`,
        confirmLabel: 'Archive channel',
        severity: 'warning',
      });
      if (!ok) return;
      if (typeof store?.archiveChannel === 'function') {
        store.archiveChannel(channel.id);
      }
      onClose?.();
    } finally {
      archivePending = false;
    }
  }

  // ── Delete (danger severity, typed-name required) ────────────────────
  let deletePending = $state(false);

  async function startDelete() {
    if (!canDelete || deletePending) return;
    if (typeof onConfirmDestructive !== 'function') return;
    deletePending = true;
    try {
      const ok = await onConfirmDestructive({
        resourceName: `channel #${channel.name}`,
        requireTypedName: channel.name,
        title: 'Delete channel?',
        body: `This will permanently delete #${channel.name} and all its history. This cannot be undone.`,
        confirmLabel: 'Delete channel',
        severity: 'danger',
      });
      if (!ok) return;
      if (typeof store?.deleteChannel === 'function') {
        await store.deleteChannel(channel.id);
      }
      onClose?.();
    } finally {
      deletePending = false;
    }
  }
</script>

<section
  class="admin-panel"
  data-testid="channel-admin-panel"
  data-role={currentChannelRole ?? 'hydrating'}
>
  {#if isHydrating}
    <div class="admin-skeleton" data-testid="channel-admin-skeleton">
      <p class="admin-skeleton-line">Loading admin actions…</p>
    </div>
  {:else if isMember}
    <div class="admin-empty" data-testid="channel-admin-empty-member">
      <p class="admin-empty-title">No admin actions available</p>
      <p class="admin-empty-body">
        You don't have admin rights in this channel. Ask the owner or an
        admin to grant access if you need to make changes.
      </p>
    </div>
  {:else}
    <header class="admin-header">
      <div class="admin-header-name">
        {#if mode === 'invite'}
          <Lock size={16} strokeWidth={2} aria-hidden="true" />
        {:else}
          <Hash size={16} strokeWidth={2} aria-hidden="true" />
        {/if}
        {#if editingName}
          <input
            class="admin-name-input"
            type="text"
            bind:value={nameDraft}
            onkeydown={handleRenameKeydown}
            onblur={commitRename}
            placeholder="Channel name"
            aria-label="Channel name"
            data-testid="channel-admin-name-input"
          />
        {:else}
          <span class="admin-name" data-testid="channel-admin-name">{channel?.name ?? ''}</span>
        {/if}
      </div>
      <p class="admin-role-badge" data-testid="channel-admin-role-badge">
        Your role: <strong>{currentChannelRole}</strong>
      </p>
    </header>

    <div class="admin-topic-row">
      {#if editingTopic}
        <input
          class="admin-topic-input"
          type="text"
          bind:value={topicDraft}
          onkeydown={handleTopicKeydown}
          onblur={commitEditTopic}
          placeholder="Channel topic"
          aria-label="Channel topic"
          data-testid="channel-admin-topic-input"
        />
      {:else}
        <p class="admin-topic" data-testid="channel-admin-topic">
          {channel?.topic || 'No topic set'}
        </p>
      {/if}
    </div>

    <div class="admin-actions" data-testid="channel-admin-actions">
      {#if canRename}
        <button
          type="button"
          class="admin-btn"
          onclick={editingName ? cancelRename : startRename}
          data-testid="channel-admin-action-rename"
        >
          <Pencil size={14} strokeWidth={2} aria-hidden="true" />
          {editingName ? 'Cancel rename' : 'Rename'}
        </button>
        <button
          type="button"
          class="admin-btn"
          onclick={editingTopic ? cancelEditTopic : startEditTopic}
          data-testid="channel-admin-action-edit-topic"
        >
          <Pencil size={14} strokeWidth={2} aria-hidden="true" />
          {editingTopic ? 'Cancel edit topic' : 'Edit topic'}
        </button>
      {/if}

      {#if canToggleVisibility}
        <button
          type="button"
          class="admin-btn"
          onclick={toggleVisibility}
          data-testid="channel-admin-action-visibility"
          aria-pressed={visibility === 'private'}
        >
          {#if visibility === 'private'}
            <Lock size={14} strokeWidth={2} aria-hidden="true" />
            Make public
          {:else}
            <Globe size={14} strokeWidth={2} aria-hidden="true" />
            Make private
          {/if}
        </button>
      {/if}

      {#if canToggleMode}
        <button
          type="button"
          class="admin-btn"
          onclick={toggleMode}
          data-testid="channel-admin-action-mode"
          aria-pressed={mode === 'invite'}
        >
          {#if mode === 'invite'}
            <Hash size={14} strokeWidth={2} aria-hidden="true" />
            Switch to open
          {:else}
            <Lock size={14} strokeWidth={2} aria-hidden="true" />
            Switch to invite-only
          {/if}
        </button>
      {/if}

      {#if canTransfer}
        <button
          type="button"
          class="admin-btn"
          onclick={startTransfer}
          disabled={transferPending}
          data-testid="channel-admin-action-transfer"
        >
          <UserPlus size={14} strokeWidth={2} aria-hidden="true" />
          Transfer ownership
        </button>
      {/if}

      {#if canArchive}
        <button
          type="button"
          class="admin-btn warning"
          onclick={startArchive}
          disabled={archivePending}
          data-testid="channel-admin-action-archive"
        >
          <Archive size={14} strokeWidth={2} aria-hidden="true" />
          Archive
        </button>
      {/if}

      {#if canDelete}
        <button
          type="button"
          class="admin-btn danger"
          onclick={startDelete}
          disabled={deletePending}
          data-testid="channel-admin-action-delete"
        >
          <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
          Delete
        </button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .admin-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 4px;
  }

  .admin-skeleton,
  .admin-empty {
    padding: 24px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: center;
  }

  .admin-skeleton-line {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    font-style: italic;
  }

  .admin-empty-title {
    margin: 0 0 6px;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 600;
  }

  .admin-empty-body {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .admin-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .admin-header-name {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-primary);
    font-size: 15px;
    font-weight: 700;
    flex: 1;
    min-width: 0;
  }

  .admin-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .admin-name-input {
    flex: 1;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .admin-name-input:focus {
    border-color: var(--ember-500, #f97316);
  }

  .admin-role-badge {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .admin-role-badge strong {
    color: var(--text-secondary);
    font-weight: 700;
  }

  .admin-topic-row {
    padding: 0 4px;
  }

  .admin-topic {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .admin-topic-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }

  .admin-topic-input:focus {
    border-color: var(--ember-500, #f97316);
  }

  .admin-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .admin-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
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

  .admin-btn:hover:not(:disabled) {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .admin-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .admin-btn.warning {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.3);
  }

  .admin-btn.warning:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.1);
    color: #d97706;
  }

  .admin-btn.danger {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.3);
  }

  .admin-btn.danger:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.1);
    color: #ef4444;
  }
</style>
