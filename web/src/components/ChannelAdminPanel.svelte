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
      - Transfer -> { severity: 'danger'  } (typed-name required) +
        new-owner picker (v0.4.2 Wave C, [VERIFY-3.6b-4]): click Transfer
        opens a dropdown listing the channel's other members; user picks
        the new owner; confirmDestructive runs with the channel name as
        the typed-name gate; on confirm, `store.transferOwnership(id,
        pickedKey)` fires the 2-arg path (the 1-arg fallback documented
        on the store accessor is now unreachable from the panel UI).

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
  import { isReservedChannel } from '../lib/channels.js';

  let {
    channel,
    currentChannelRole,
    store,
    onConfirmDestructive,
    onClose,
    // Optional. ``onRequestToast(text)`` surfaces a transient System toast
    // so a server-refused archive/delete reports its reason instead of a
    // silent no-op.
    onRequestToast,
  } = $props();

  // ── Per-role action visibility (Q6 lock-in) ──────────────────────────
  // Derived booleans keep the markup readable. Owner sees all 6 actions;
  // admin sees 4 (no Transfer, no Delete); member sees the empty state.
  // `null` (hydrating) renders the skeleton placeholder.
  let isOwner = $derived(currentChannelRole === 'owner');
  let isAdmin = $derived(currentChannelRole === 'admin');
  let isMember = $derived(currentChannelRole === 'member');
  let isHydrating = $derived(currentChannelRole == null);

  // Reserved channels (#general / #system) can never be archived/deleted;
  // suppress those affordances client-side to match the backend guard.
  let isReserved = $derived(isReservedChannel(channel?.id));

  let canRename = $derived(isOwner || isAdmin);
  let canToggleVisibility = $derived(isOwner || isAdmin);
  let canToggleMode = $derived(isOwner || isAdmin);
  let canTransfer = $derived(isOwner);
  // Unify Delete with Archive on owner OR admin (was owner-only), matching
  // the sidebar context menu and the broadened backend authorization.
  let canArchive = $derived((isOwner || isAdmin) && !isReserved);
  let canDelete = $derived((isOwner || isAdmin) && !isReserved);

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
    // Same double-fire shape as commitEditTopic (see BUG-PHASE2A-2):
    // Enter sets editingName=false → input unmounts → onblur re-fires.
    // Short-circuit when no longer editing so the blur-after-Enter
    // path is a no-op.
    if (!editingName) return;
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
    // BUG-PHASE2A-2 fix (v0.4.3): the topic input wires BOTH
    // `onkeydown=Enter -> commitEditTopic` AND `onblur -> commitEditTopic`.
    // Pressing Enter sets `editingTopic = false`, which unmounts the
    // input ({#if editingTopic} block), which fires onblur on the
    // unmounting element, which re-enters commitEditTopic with an
    // already-empty topicDraft and clobbers the topic with ''. Guard
    // by short-circuiting when we are no longer in editing mode.
    if (!editingTopic) return;
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
  // Owner-only. Two-step UX (v0.4.2 Wave C, [VERIFY-3.6b-4]):
  //   1. Click "Transfer ownership" → opens a dropdown of channel
  //      members excluding the caller (computed from the store's
  //      `channelMembers[channel.id]` + `participants` map). If the
  //      picker is empty (channel has no other members), the dropdown
  //      shows an inline "No eligible members" hint and the Confirm
  //      button stays disabled.
  //   2. Pick a member → confirmDestructive opens with severity:'danger'
  //      and the channel name as the typed-name gate.
  //   3. On confirm, fires `store.transferOwnership(channel.id,
  //      pickedKey)` — the 2-arg path the store accessor has been
  //      waiting on. On cancel / dismiss, the picker collapses without
  //      firing the wire call.
  //
  // The picker uses a native `<select>` rather than a custom typeahead
  // for two reasons: (a) participant counts are typically small (< 50)
  // so a search field doesn't add value, and (b) `<select>` carries
  // full a11y semantics (keyboard navigation, ARIA listbox role,
  // screen-reader pronunciation of options) without bespoke wiring.
  let transferPending = $state(false);
  let pickerOpen = $state(false);
  let pickedKey = $state('');

  // Eligible new-owner candidates: channel members minus the caller.
  // Sorted alphabetically by display name for stable picker ordering.
  // Falls back to participant key when name is missing (legacy rows).
  let transferCandidates = $derived.by(() => {
    const channelId = channel?.id;
    if (!channelId) return [];
    const memberMap = store?.channelMembers?.[channelId];
    if (!memberMap) return [];
    const participants = store?.participants ?? {};
    const selfKey = store?.userProfile?.key;
    const memberKeys = Object.keys(memberMap);
    const out = [];
    for (const key of memberKeys) {
      if (key === selfKey) continue;
      const p = participants[key];
      out.push({
        key,
        name: (p && typeof p.name === 'string' && p.name) ? p.name : key,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  });

  function openTransferPicker() {
    if (!canTransfer || transferPending) return;
    pickerOpen = true;
    pickedKey = '';
  }

  function cancelTransferPicker() {
    pickerOpen = false;
    pickedKey = '';
  }

  async function confirmTransferPicker() {
    if (!canTransfer || transferPending) return;
    if (!pickedKey) return;
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
      if (!ok) {
        // User declined the confirm dialog. Leave the picker open so
        // they can either pick a different member or click Cancel to
        // back out entirely.
        return;
      }
      if (typeof store?.transferOwnership === 'function') {
        await store.transferOwnership(channel.id, pickedKey);
      }
      // Collapse the picker on a successful (or store-stub-no-op)
      // transfer. onClose intentionally NOT called: a successful
      // transfer demotes the caller; the modal stays open so they
      // can review the post-transfer state.
      pickerOpen = false;
      pickedKey = '';
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
        const handle = store.archiveChannel(channel.id);
        // Surface a server refusal (e.g. not-authorized / reserved) instead
        // of a silent no-op. The undoable envelope resolves ``done`` to the
        // committed MCP result; a cancelled undo is not an error.
        if (handle && handle.done && typeof handle.done.then === 'function') {
          handle.done
            .then((res) => {
              if (res && res.success === false && !res.cancelled) {
                onRequestToast?.(res.error || `Could not archive #${channel.name}.`);
              }
            })
            .catch(() => {});
        }
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
        const res = await store.deleteChannel(channel.id);
        if (res && res.success === false) {
          onRequestToast?.(res.error || `Could not delete #${channel.name}.`);
        }
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
          onclick={pickerOpen ? cancelTransferPicker : openTransferPicker}
          disabled={transferPending}
          data-testid="channel-admin-action-transfer"
        >
          <UserPlus size={14} strokeWidth={2} aria-hidden="true" />
          {pickerOpen ? 'Cancel transfer' : 'Transfer ownership'}
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

    {#if canTransfer && pickerOpen}
      <div class="admin-transfer-picker" data-testid="channel-admin-transfer-picker">
        <label class="admin-transfer-label" for="channel-admin-transfer-select">
          New owner
        </label>
        {#if transferCandidates.length === 0}
          <p class="admin-transfer-empty" data-testid="channel-admin-transfer-picker-empty">
            No eligible members in this channel. Invite someone first, then
            transfer ownership.
          </p>
        {:else}
          <select
            id="channel-admin-transfer-select"
            class="admin-transfer-select"
            bind:value={pickedKey}
            data-testid="channel-admin-transfer-select"
          >
            <option value="" disabled>Select a new owner...</option>
            {#each transferCandidates as candidate (candidate.key)}
              <option value={candidate.key} data-testid="channel-admin-transfer-option-{candidate.key}">
                {candidate.name}
              </option>
            {/each}
          </select>
        {/if}
        <div class="admin-transfer-actions">
          <button
            type="button"
            class="admin-btn"
            onclick={cancelTransferPicker}
            data-testid="channel-admin-transfer-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="admin-btn danger"
            onclick={confirmTransferPicker}
            disabled={transferPending || !pickedKey}
            data-testid="channel-admin-transfer-confirm"
          >
            <UserPlus size={14} strokeWidth={2} aria-hidden="true" />
            Confirm transfer
          </button>
        </div>
      </div>
    {/if}
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

  .admin-transfer-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    background: var(--bg-surface);
    border: 1px solid rgba(248, 113, 113, 0.3);
    border-radius: var(--radius-sm);
  }

  .admin-transfer-label {
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .admin-transfer-select {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }

  .admin-transfer-select:focus {
    border-color: var(--ember-500, #f97316);
  }

  .admin-transfer-empty {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .admin-transfer-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
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
