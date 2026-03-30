<script>
  import MessageBubble from './MessageBubble.svelte';
  import MessageGroup from './MessageGroup.svelte';
  import DateSeparator from './DateSeparator.svelte';
  import ScrollToBottom from './ScrollToBottom.svelte';
  import { MessageSquare } from 'lucide-svelte';
  import { isSameDay } from '../lib/utils.js';

  let { messages = [], currentUser, participants, onOpenThread, onContextMenu, onShowProfile, onReact } = $props();

  let messagesEl = $state(null);
  let showScrollBtn = $state(false);
  let unreadBelow = $state(0);
  let isAtBottom = $state(true);

  // Group consecutive messages from the same sender
  let groupedMessages = $derived.by(() => {
    const groups = [];
    let currentGroup = null;

    for (const msg of messages) {
      const needDateSep = groups.length === 0 ||
        (currentGroup && !isSameDay(currentGroup.messages[0].ts, msg.ts));

      if (needDateSep) {
        groups.push({ type: 'date', ts: msg.ts });
      }

      if (currentGroup &&
          currentGroup.type === 'messages' &&
          currentGroup.sender === msg.sender.key &&
          !needDateSep) {
        currentGroup.messages.push(msg);
      } else {
        currentGroup = { type: 'messages', sender: msg.sender.key, messages: [msg] };
        groups.push(currentGroup);
      }
    }
    return groups;
  });

  // Auto-scroll to bottom on new messages
  $effect(() => {
    if (messages.length && isAtBottom && messagesEl) {
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
  });

  function handleScroll() {
    if (!messagesEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    isAtBottom = scrollHeight - scrollTop - clientHeight < 60;
    showScrollBtn = !isAtBottom;
    if (isAtBottom) unreadBelow = 0;
  }

  function scrollToBottom() {
    if (messagesEl) {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      unreadBelow = 0;
    }
  }

  function handleMessageContextMenu(e) {
    onContextMenu(e);
  }
</script>

<div
  class="messages"
  bind:this={messagesEl}
  onscroll={handleScroll}
  data-testid="chat-view"
  role="log"
  aria-label="Chat messages"
  aria-live="polite"
>
  {#if messages.length === 0}
    <div class="empty-state">
      <div class="empty-icon-ring">
        <div class="empty-icon-inner">
          <MessageSquare size={28} strokeWidth={1.5} />
        </div>
      </div>
      <div class="empty-title">No messages yet</div>
      <div class="empty-subtitle">This is the very beginning of the conversation.</div>
      <div class="empty-hint">Type a message below to get things started.</div>
    </div>
  {:else}
    {#each groupedMessages as group, i}
      {#if group.type === 'date'}
        <DateSeparator ts={group.ts} />
      {:else}
        <MessageGroup
          messages={group.messages}
          {currentUser}
          {participants}
          {onOpenThread}
          onContextMenu={handleMessageContextMenu}
          {onShowProfile}
          {onReact}
        />
      {/if}
    {/each}
  {/if}
</div>

{#if showScrollBtn}
  <ScrollToBottom count={unreadBelow} onClick={scrollToBottom} />
{/if}

<style>
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px 32px 36px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
    z-index: 1;
    scroll-behavior: smooth;
    mask-image: linear-gradient(transparent, black 8px, black calc(100% - 8px), transparent);
    -webkit-mask-image: linear-gradient(transparent, black 8px, black calc(100% - 8px), transparent);
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    animation: emptyFadeIn 0.6s ease both;
  }

  .empty-icon-ring {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(245,158,11,0.06), rgba(245,158,11,0.02));
    border: 1px solid rgba(245,158,11,0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 8px;
    animation: emptyPulse 4s ease-in-out infinite;
  }

  .empty-icon-inner {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ember-400);
    opacity: 0.7;
  }

  .empty-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-secondary);
    letter-spacing: -0.2px;
  }

  .empty-subtitle {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .empty-hint {
    font-size: 12px;
    color: var(--text-faint);
    margin-top: 4px;
  }

  @keyframes emptyFadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes emptyPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.04); opacity: 0.85; }
  }
</style>
