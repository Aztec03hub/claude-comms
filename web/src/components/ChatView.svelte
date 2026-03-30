<script>
  import MessageBubble from './MessageBubble.svelte';
  import MessageGroup from './MessageGroup.svelte';
  import DateSeparator from './DateSeparator.svelte';
  import ScrollToBottom from './ScrollToBottom.svelte';
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
>
  {#if messages.length === 0}
    <div class="empty-state">
      <div class="empty-icon">#</div>
      <div class="empty-title">No messages yet</div>
      <div class="empty-subtitle">Start the conversation by sending a message below.</div>
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
    gap: 8px;
    opacity: 0.5;
  }

  .empty-icon {
    width: 48px;
    height: 48px;
    border-radius: 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    color: var(--text-faint);
    margin-bottom: 4px;
  }

  .empty-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-secondary);
  }

  .empty-subtitle {
    font-size: 12.5px;
    color: var(--text-faint);
  }
</style>
