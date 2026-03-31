<!--
  @component ConversationBrowser
  @description Slide-out panel that displays ALL conversations on the server, allowing users to discover and join conversations they haven't joined yet. Shows conversation name, topic, member count, last activity, and join status.
  @prop {object} store - The ChatStore instance (uses store.channels for joined status).
  @prop {Function} onClose - Callback invoked to close the panel.
  @prop {Function} onJoinChannel - Callback invoked with a channel name to join/switch to it.
-->
<script>
  import { Compass, X, Users, Clock, Hash, LogIn } from 'lucide-svelte';
  import { formatTime } from '../lib/utils.js';

  let { store, onClose, onJoinChannel } = $props();

  let conversations = $state([]);
  let loading = $state(false);
  let error = $state(null);

  // Set of joined channel IDs for quick lookup
  let joinedSet = $derived(new Set(store.channels.map(c => c.id)));

  async function fetchConversations() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/conversations?all=true');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Sort by last_activity descending (most recent first)
      const list = data.conversations || [];
      list.sort((a, b) => {
        const ta = a.last_activity ? new Date(a.last_activity).getTime() : 0;
        const tb = b.last_activity ? new Date(b.last_activity).getTime() : 0;
        return tb - ta;
      });
      conversations = list;
    } catch (e) {
      error = e.message;
      conversations = [];
    } finally {
      loading = false;
    }
  }

  function handleJoin(name) {
    onJoinChannel(name);
  }

  // Fetch on mount
  $effect(() => {
    fetchConversations();
  });
</script>

<div class="conversation-browser" data-testid="conversation-browser" role="complementary" aria-label="Browse conversations">
  <div class="browser-header">
    <div class="browser-header-top">
      <Compass size={16} strokeWidth={2} />
      <span class="browser-header-title">Browse Conversations</span>
      {#if conversations.length > 0}
        <span class="browser-count-badge">{conversations.length}</span>
      {/if}
      <button class="browser-close-btn" onclick={onClose} data-testid="conversation-browser-close" title="Close" aria-label="Close conversation browser">
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  </div>

  <div class="browser-list">
    {#if loading}
      <div class="browser-empty">
        <div class="browser-empty-icon muted">
          <Clock size={24} strokeWidth={1.5} />
        </div>
        <div class="browser-empty-title">Loading...</div>
      </div>
    {:else if error}
      <div class="browser-empty">
        <div class="browser-empty-icon">
          <Compass size={24} strokeWidth={1.5} />
        </div>
        <div class="browser-empty-title">Error loading conversations</div>
        <div class="browser-empty-hint">{error}</div>
      </div>
    {:else if conversations.length === 0}
      <div class="browser-empty">
        <div class="browser-empty-icon muted">
          <Compass size={24} strokeWidth={1.5} />
        </div>
        <div class="browser-empty-title">No conversations found</div>
        <div class="browser-empty-hint">There are no conversations on the server yet.</div>
      </div>
    {:else}
      {#each conversations as convo (convo.name)}
        {@const isJoined = joinedSet.has(convo.name)}
        <div class="browser-item" class:joined={isJoined} data-testid="browser-item-{convo.name}">
          <div class="browser-item-top">
            <div class="browser-item-icon">
              <Hash size={14} strokeWidth={2} />
            </div>
            <span class="browser-item-name">{convo.name}</span>
            {#if isJoined}
              <button class="browser-joined-badge" onclick={() => handleJoin(convo.name)} title="Switch to this channel">
                Joined
              </button>
            {:else}
              <button class="browser-join-btn" onclick={() => handleJoin(convo.name)} data-testid="browser-join-{convo.name}" title="Join this conversation">
                <LogIn size={12} strokeWidth={2} />
                Join
              </button>
            {/if}
          </div>
          {#if convo.topic}
            <div class="browser-item-topic">{convo.topic}</div>
          {/if}
          <div class="browser-item-meta">
            {#if convo.member_count != null}
              <span class="browser-meta-item">
                <Users size={11} strokeWidth={2} />
                {convo.member_count}
              </span>
            {/if}
            {#if convo.last_activity}
              <span class="browser-meta-item">
                <Clock size={11} strokeWidth={2} />
                {formatTime(convo.last_activity, 'relative')}
              </span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

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

  /* ── List ── */
  .browser-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
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
  }

  .browser-item:last-child { margin-bottom: 0; }

  .browser-item:hover {
    border-color: var(--ember-700);
    background: var(--bg-elevated);
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
    box-shadow: 0 2px 8px rgba(245,158,11,0.25);
  }

  /* ── Joined Badge ── */
  .browser-joined-badge {
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.15);
    color: var(--ember-400);
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }

  .browser-joined-badge:hover {
    background: rgba(245,158,11,0.14);
    border-color: var(--ember-700);
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
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
