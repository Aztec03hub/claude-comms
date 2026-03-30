<script>
  import Avatar from './Avatar.svelte';
  import MessageActions from './MessageActions.svelte';
  import ReactionBar from './ReactionBar.svelte';
  import ReadReceipt from './ReadReceipt.svelte';
  import { formatTime, parseMentions, getParticipantColor } from '../lib/utils.js';

  let { message, consecutive = false, currentUser, participants, onOpenThread, onContextMenu, onShowProfile } = $props();

  let isHuman = $derived(message.sender.type === 'human');
  let isMine = $derived(message.sender.key === currentUser?.key);
  let senderColor = $derived(getParticipantColor(message.sender.key));
  let bodySegments = $derived(parseMentions(message.body));
  let hasCode = $derived(message.body.includes('```'));

  function handleContext(e) {
    e.preventDefault();
    onContextMenu({ x: e.clientX, y: e.clientY, message });
  }

  function handleAvatarClick() {
    const p = participants[message.sender.key] || message.sender;
    onShowProfile(p);
  }
</script>

<div
  class="msg-row"
  class:claude={!isHuman}
  class:human={isHuman}
  class:consecutive
  class:has-code={hasCode}
  oncontextmenu={handleContext}
>
  {#if !consecutive}
    <Avatar
      name={message.sender.name}
      gradient={senderColor.gradient}
      onClick={handleAvatarClick}
    />
  {:else}
    <div class="avatar-spacer"></div>
  {/if}

  <div class="bubble-wrap">
    {#if !consecutive}
      <div class="sender-line">
        <span
          class="sender-name"
          style="color: {senderColor.textColor}"
          onclick={handleAvatarClick}
          role="button"
          tabindex="0"
        >{message.sender.name}</span>
        <span class="msg-time">{formatTime(message.ts)}</span>
      </div>
    {/if}

    <div class="bubble">
      {#each bodySegments as seg}
        {#if seg.type === 'mention'}
          <span class="mention">{seg.value}</span>
        {:else}
          {seg.value}
        {/if}
      {/each}
    </div>

    {#if message.reactions?.length}
      <ReactionBar reactions={message.reactions} />
    {/if}

    {#if message.thread_count}
      <div class="thread-indicator" onclick={() => onOpenThread(message)} role="button" tabindex="0">
        <span class="thread-count">{message.thread_count} replies</span>
      </div>
    {/if}

    {#if isMine && message.read_by}
      <ReadReceipt count={message.read_by} />
    {/if}
  </div>

  <MessageActions
    {message}
    onReply={() => onOpenThread(message)}
  />

  {#if consecutive}
    <span class="hover-time">{formatTime(message.ts, 'short')}</span>
  {/if}
</div>

<style>
  .msg-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    max-width: 72%;
    width: fit-content;
    transition: background var(--transition-fast);
    padding: 5px 10px;
    border-radius: var(--radius);
    position: relative;
    animation: msgAppear 0.3s ease-out both;
  }

  .msg-row:hover { background: rgba(245,158,11,0.025); }
  .msg-row.human { align-self: flex-end; flex-direction: row-reverse; }
  .msg-row.has-code { max-width: 80%; }

  .msg-row + :global(.msg-row:not(.consecutive)) { margin-top: 14px; }

  .msg-row.consecutive.claude { padding-left: 52px; }
  .msg-row.consecutive.human { padding-right: 52px; }

  .msg-row.claude:hover::after {
    content: '';
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 2px;
    background: linear-gradient(180deg, transparent, rgba(52,211,153,0.3), transparent);
    animation: accentFade 0.3s ease;
  }

  .msg-row.human:hover::after {
    content: '';
    position: absolute;
    right: 0;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 2px;
    background: linear-gradient(180deg, transparent, rgba(245,158,11,0.3), transparent);
    animation: accentFade 0.3s ease;
  }

  .avatar-spacer {
    width: 34px;
    flex-shrink: 0;
    visibility: hidden;
  }

  .bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .msg-row.human .bubble-wrap { align-items: flex-end; }

  .sender-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 4px;
  }

  .sender-name {
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: var(--transition-fast);
    letter-spacing: -0.15px;
    text-shadow: 0 0 20px currentColor;
  }

  .sender-name:hover { filter: brightness(1.2); }

  .msg-time {
    font-size: 10.5px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .bubble {
    padding: 11px 16px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.65;
    word-wrap: break-word;
    position: relative;
  }

  .msg-row.claude .bubble {
    background: var(--bg-bubble-claude);
    border: 1px solid var(--border);
    border-radius: 4px 14px 14px 14px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.08);
  }

  .msg-row.human .bubble {
    background: var(--bg-bubble-human);
    border: 1px solid rgba(180,83,9,0.2);
    border-radius: 14px 4px 14px 14px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.08), inset 0 0 24px rgba(245,158,11,0.015);
  }

  .mention {
    background: rgba(245,158,11,0.12);
    color: var(--ember-400);
    padding: 1px 7px;
    border-radius: 6px;
    font-weight: 600;
    font-size: 13px;
    box-shadow: 0 0 8px rgba(245,158,11,0.06);
    cursor: pointer;
    transition: var(--transition-fast);
    text-decoration: none;
  }

  .mention:hover {
    background: rgba(245,158,11,0.22);
    box-shadow: 0 0 12px rgba(245,158,11,0.12);
  }

  .thread-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-muted);
    cursor: pointer;
    transition: var(--transition-fast);
    border-radius: 6px;
  }

  .thread-indicator:hover {
    background: var(--bg-surface);
    color: var(--ember-400);
  }

  .thread-count {
    font-weight: 600;
    color: var(--ember-400);
  }

  .hover-time {
    position: absolute;
    left: -60px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 10px;
    color: var(--text-faint);
    opacity: 0;
    transition: opacity var(--transition-fast);
    white-space: nowrap;
  }

  .msg-row.human .hover-time { left: auto; right: -60px; }
  .msg-row:hover .hover-time { opacity: 1; }
</style>
