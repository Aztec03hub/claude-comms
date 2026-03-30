<script>
  import Avatar from './Avatar.svelte';
  import { MessageSquare, Send, X } from 'lucide-svelte';
  import { formatTime, getParticipantColor } from '../lib/utils.js';

  let { parentMessage, messages = [], participants, currentUser, onClose, onSendReply } = $props();

  let replyText = $state('');
  let parentColor = $derived(getParticipantColor(parentMessage.sender.key));

  function handleSend() {
    if (!replyText.trim()) return;
    onSendReply(replyText);
    replyText = '';
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }
</script>

<div class="thread-panel" data-testid="thread-panel" role="complementary" aria-label="Thread replies">
  <div class="thread-header">
    <div class="thread-title">
      <MessageSquare size={16} strokeWidth={2} />
      Thread
    </div>
    <span class="thread-reply-count">{messages.length} replies</span>
    <button class="thread-close" onclick={onClose} data-testid="thread-panel-close" aria-label="Close thread panel"><X size={16} strokeWidth={2} /></button>
  </div>

  <div class="thread-parent">
    <div class="thread-parent-header">
      <div class="thread-parent-avatar" style="background: {parentColor.gradient}">
        {parentMessage.sender.name.slice(0, 2).toUpperCase()}
      </div>
      <span class="thread-parent-name" style="color: {parentColor.textColor}">{parentMessage.sender.name}</span>
      <span class="thread-parent-time">{formatTime(parentMessage.ts, 'short')}</span>
    </div>
    <div class="thread-parent-text">{parentMessage.body}</div>
  </div>

  <div class="thread-replies">
    {#each messages as reply (reply.id)}
      {@const replyColor = getParticipantColor(reply.sender.key)}
      <div class="thread-reply">
        <div class="thread-reply-avatar" style="background: {replyColor.gradient}">
          {reply.sender.name.slice(0, 2).toUpperCase()}
        </div>
        <div class="thread-reply-content">
          <div class="thread-reply-header">
            <span class="thread-reply-name" style="color: {replyColor.textColor}">{reply.sender.name}</span>
            <span class="thread-reply-time">{formatTime(reply.ts, 'short')}</span>
          </div>
          <div class="thread-reply-text">{reply.body}</div>
        </div>
      </div>
    {/each}
  </div>

  <div class="thread-input">
    <div class="thread-input-wrap">
      <label for="thread-reply-input-field" class="sr-only">Reply in thread</label>
      <input
        id="thread-reply-input-field"
        type="text"
        placeholder="Reply in thread..."
        bind:value={replyText}
        onkeydown={handleKeydown}
        data-testid="thread-reply-input"
      >
      <button class="thread-send" onclick={handleSend} aria-label="Send reply" data-testid="thread-send">
        <Send size={12} strokeWidth={2} />
      </button>
    </div>
  </div>
</div>

<style>
  .thread-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 360px;
    z-index: 45;
    background: rgba(17, 17, 19, 0.97);
    backdrop-filter: blur(24px) saturate(1.3);
    border-left: 1px solid var(--border);
    box-shadow: -12px 0 40px rgba(0,0,0,0.35);
    display: flex;
    flex-direction: column;
    animation: threadSlide 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .thread-header {
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .thread-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
  }

  .thread-title :global(svg) { color: var(--ember-400); opacity: 0.8; }

  .thread-reply-count {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
  }

  .thread-close {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    font-size: 16px;
  }

  .thread-close:hover { background: var(--bg-surface); color: var(--text-primary); }

  .thread-parent {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
    background: rgba(255, 255, 255, 0.01);
  }

  .thread-parent-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .thread-parent-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: #0a0a0c;
  }

  .thread-parent-name { font-size: 12px; font-weight: 700; }
  .thread-parent-time { font-size: 10px; color: var(--text-faint); margin-left: auto; }
  .thread-parent-text { font-size: 13px; color: var(--text-secondary); line-height: 1.55; }

  .thread-replies {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .thread-reply {
    display: flex;
    gap: 8px;
    animation: msgAppear 0.3s ease-out both;
  }

  .thread-reply-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: #0a0a0c;
    margin-top: 2px;
  }

  .thread-reply-content { flex: 1; min-width: 0; }

  .thread-reply-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 2px;
  }

  .thread-reply-name { font-size: 12px; font-weight: 700; }
  .thread-reply-time { font-size: 10px; color: var(--text-faint); }
  .thread-reply-text { font-size: 13px; color: var(--text-secondary); line-height: 1.55; }

  .thread-input {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    background: linear-gradient(180deg, transparent, rgba(0,0,0,0.1));
  }

  .thread-input-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 6px 3px 12px;
    transition: var(--transition-med);
  }

  .thread-input-wrap:focus-within {
    border-color: rgba(245,158,11,0.2);
    box-shadow: 0 0 0 2px var(--border-glow);
  }

  .thread-input-wrap input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 13px;
    padding: 7px 0;
    font-family: inherit;
  }

  .thread-input-wrap input::placeholder { color: var(--text-faint); }

  .thread-send {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: none;
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    color: #0a0a0c;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .thread-send:hover { filter: brightness(1.1); }
</style>
