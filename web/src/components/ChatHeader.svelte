<!--
  @component ChatHeader
  @description Channel header rendered at the top of ChatView. Displays the
  channel name, topic, member count, and (when the current user has owner or
  admin role) an inline-edit affordance for the topic. v0.4.2 Step 3.2.

  Inline-edit interaction:
    - Click the topic text (or the "Edit topic" pencil button) to enter edit
      mode. The text swaps for an <input> that auto-focuses and selects.
    - Enter commits via `store.setTopic(channel.id, newTopic)`. Esc cancels.
      Blur also commits (matches ChannelDirectoryModal Admin tab pattern).
    - The store handles optimistic update + rollback on failure; we do not
      duplicate that here.
    - If the new value equals the current topic, we skip the store call.

  Role gating:
    - Edit affordance is rendered ONLY when
      `currentUserRole === 'owner' || currentUserRole === 'admin'`.
    - Members see the topic as static text with no pencil button.
    - `currentUserRole === null` (unknown) also hides the affordance.

  Test seam:
    - Every interactive element carries a stable `data-testid`. The topic
      block toggles between `chat-header-topic-static` and
      `chat-header-topic-input`.

  PUBLIC CONTRACT (do not rename):
    @prop {object} channel - Channel object from `store.channelsById`. Must
      carry `{ id, name, topic, memberCount }`. Defensive defaults applied.
    @prop {'owner'|'admin'|'member'|null} currentUserRole - Caller's role
      in this channel. Drives edit-affordance visibility.
    @prop {object} store - MqttChatStore instance. We call `store.setTopic`.
    @prop {Function} [onEditTopicError] - Optional callback invoked with the
      error string when `store.setTopic` returns `{ success: false, error }`.
-->
<script>
  import { tick } from 'svelte';
  import { Pencil, Users, Hash } from 'lucide-svelte';

  let {
    channel,
    currentUserRole = null,
    store,
    onEditTopicError,
  } = $props();

  // Defensive accessors so a missing channel does not crash the header.
  let channelId = $derived(channel?.id ?? '');
  let channelName = $derived(channel?.name ?? channelId);
  let channelTopic = $derived(channel?.topic ?? '');
  let memberCount = $derived(
    typeof channel?.memberCount === 'number' ? channel.memberCount : 0,
  );

  let canEditTopic = $derived(
    currentUserRole === 'owner' || currentUserRole === 'admin',
  );

  // Inline-edit state. `editingTopic` is the boolean toggle; `topicDraft`
  // is the live <input> value. Resetting `topicDraft` happens on every
  // edit start so a previous canceled draft does not bleed into a new
  // edit session.
  let editingTopic = $state(false);
  let topicDraft = $state('');

  /** @type {HTMLInputElement | undefined} */
  let topicInputEl = $state();

  async function startEditTopic() {
    if (!canEditTopic) return;
    topicDraft = channelTopic;
    editingTopic = true;
    // Wait for the input to mount, then focus + select-all.
    await tick();
    if (topicInputEl) {
      topicInputEl.focus();
      topicInputEl.select();
    }
  }

  function cancelEditTopic() {
    editingTopic = false;
    topicDraft = '';
  }

  async function commitEditTopic() {
    // Snapshot then clear edit state first so a re-render does not
    // re-trigger blur → commit during the await.
    const nextTopic = topicDraft;
    editingTopic = false;
    topicDraft = '';

    if (!channelId) return;
    if (nextTopic === channelTopic) return;
    if (typeof store?.setTopic !== 'function') return;

    const result = await store.setTopic(channelId, nextTopic);
    if (result && result.success === false && typeof onEditTopicError === 'function') {
      onEditTopicError(result.error || 'Failed to update topic.');
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

  function handleTopicBlur() {
    // If the input was closed via Escape, editingTopic is already false
    // and there's nothing to commit. Otherwise treat blur as commit
    // (matches ChannelDirectoryModal Admin tab).
    if (editingTopic) {
      commitEditTopic();
    }
  }
</script>

<header class="chat-header" data-testid="chat-header-new">
  <div class="header-icon" aria-hidden="true">
    <Hash size={14} strokeWidth={2} />
  </div>
  <span class="header-name" data-testid="chat-header-name">{channelName}</span>
  <span class="header-sep" aria-hidden="true"></span>

  {#if editingTopic}
    <input
      bind:this={topicInputEl}
      bind:value={topicDraft}
      class="header-topic-input"
      type="text"
      placeholder="Channel topic"
      aria-label="Edit channel topic"
      data-testid="chat-header-topic-input"
      onkeydown={handleTopicKeydown}
      onblur={handleTopicBlur}
    />
  {:else}
    <button
      type="button"
      class="header-topic-static"
      class:editable={canEditTopic}
      class:empty={!channelTopic}
      data-testid="chat-header-topic-static"
      onclick={startEditTopic}
      disabled={!canEditTopic}
      title={canEditTopic ? 'Click to edit topic' : channelTopic || 'No topic set'}
    >
      {channelTopic || (canEditTopic ? 'Add a topic' : 'No topic set')}
    </button>
    {#if canEditTopic}
      <button
        type="button"
        class="header-topic-edit-btn"
        data-testid="chat-header-topic-edit-btn"
        aria-label="Edit channel topic"
        onclick={startEditTopic}
      >
        <Pencil size={12} strokeWidth={2} />
      </button>
    {/if}
  {/if}

  <span class="header-members" data-testid="chat-header-members-count">
    <Users size={12} strokeWidth={2} aria-hidden="true" />
    {memberCount}
  </span>
</header>

<style>
  .chat-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-surface);
    flex-shrink: 0;
  }

  .header-icon {
    display: flex;
    align-items: center;
    color: var(--text-secondary);
    opacity: 0.8;
  }

  .header-name {
    font-weight: 700;
    font-size: 14px;
    color: var(--text-primary);
    letter-spacing: -0.2px;
  }

  .header-sep {
    width: 1px;
    height: 14px;
    background: var(--border);
    margin: 0 4px;
  }

  .header-topic-static {
    background: none;
    border: none;
    padding: 2px 6px;
    margin: 0;
    font: inherit;
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
    cursor: default;
    text-align: left;
    border-radius: 4px;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-topic-static.editable {
    cursor: text;
  }

  .header-topic-static.editable:hover {
    background: var(--bg-elevated);
    color: var(--text-secondary);
  }

  .header-topic-static.empty {
    font-style: italic;
    opacity: 0.7;
  }

  .header-topic-input {
    flex: 1;
    min-width: 0;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 6px;
    font: inherit;
    font-size: 12px;
    color: var(--text-primary);
    outline: none;
  }

  .header-topic-input:focus {
    border-color: var(--ember-400, #f59e0b);
  }

  .header-topic-edit-btn {
    background: none;
    border: none;
    padding: 4px;
    margin: 0;
    color: var(--text-faint);
    cursor: pointer;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .header-topic-edit-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-elevated);
  }

  .header-members {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-elevated);
    flex-shrink: 0;
  }
</style>
