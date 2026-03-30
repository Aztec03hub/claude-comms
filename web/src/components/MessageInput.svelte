<script>
  import MentionDropdown from './MentionDropdown.svelte';

  let { store, channelName, typingUsers = [], onOpenEmoji } = $props();

  let inputValue = $state('');
  let showMentionDropdown = $state(false);
  let mentionQuery = $state('');
  let inputEl = $state(null);

  function handleInput(e) {
    inputValue = e.target.value;
    store.notifyTyping();

    // Check for @ mention trigger
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = inputValue.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@([\w-]*)$/);

    if (atMatch) {
      mentionQuery = atMatch[1];
      showMentionDropdown = true;
    } else {
      showMentionDropdown = false;
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function sendMessage() {
    if (!inputValue.trim()) return;
    store.sendMessage(inputValue);
    inputValue = '';
    showMentionDropdown = false;
  }

  function handleMentionSelect(name) {
    const cursorPos = inputEl?.selectionStart || inputValue.length;
    const textBeforeCursor = inputValue.slice(0, cursorPos);
    const textAfterCursor = inputValue.slice(cursorPos);
    const beforeAt = textBeforeCursor.replace(/@[\w-]*$/, '');
    inputValue = beforeAt + '@' + name + ' ' + textAfterCursor;
    showMentionDropdown = false;
    inputEl?.focus();
  }

  let participants = $derived(
    Object.values(store.participants)
  );
</script>

<div class="input-area">
  {#if typingUsers.length > 0}
    <div class="typing-indicator" data-testid="typing-indicator">
      <div class="typing-wave"><span></span><span></span><span></span><span></span><span></span></div>
      <span>
        {#if typingUsers.length === 1}
          {typingUsers[0].name} is typing...
        {:else if typingUsers.length === 2}
          {typingUsers[0].name} and {typingUsers[1].name} are typing...
        {:else}
          Several people are typing...
        {/if}
      </span>
    </div>
  {/if}

  <div class="input-toolbar">
    <button class="input-toolbar-btn">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 1h4l2 3H1z M7 1h4v5H7z M1 7h10v4H1z"/></svg>
      Format
    </button>
    <div class="input-toolbar-divider"></div>
    <button class="input-toolbar-btn">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6h8 M6 2v8"/></svg>
      Snippet
    </button>
  </div>

  <div class="input-wrap">
    <input
      bind:this={inputEl}
      type="text"
      placeholder="Message #{channelName}..."
      bind:value={inputValue}
      oninput={handleInput}
      onkeydown={handleKeydown}
      data-testid="message-input"
    >
    <div class="input-actions">
      <button class="btn-icon" title="Attach file" data-testid="input-attach">
        <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.5 10.5l-5.2 5.2a3.5 3.5 0 01-5-5l6.4-6.4a2.3 2.3 0 013.3 3.3l-6.3 6.3a1.2 1.2 0 01-1.7-1.7l5.2-5.1"/></svg>
      </button>
      <button class="btn-icon" title="Add emoji" onclick={onOpenEmoji} data-testid="input-emoji">
        <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="9" r="7.5"/><path d="M6 11s1 2 3 2 3-2 3-2"/><circle cx="6.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><circle cx="11.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/></svg>
      </button>
    </div>
    <button class="btn-send" title="Send message" onclick={sendMessage} data-testid="send-button">
      <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M1.7 1.1a.75.75 0 01.9-.2l12 6a.75.75 0 010 1.3l-12 6a.75.75 0 01-1.05-.9L3.6 8 1.55 2.8a.75.75 0 01.15-.7z"/></svg>
    </button>
  </div>

  {#if showMentionDropdown}
    <MentionDropdown
      query={mentionQuery}
      {participants}
      onSelect={handleMentionSelect}
      onClose={() => showMentionDropdown = false}
    />
  {/if}
</div>

<style>
  .input-area {
    padding: 12px 22px 18px;
    background: rgba(14,14,16,0.85);
    backdrop-filter: blur(16px) saturate(1.2);
    box-shadow: 0 -2px 12px rgba(0,0,0,0.15);
    position: relative;
    z-index: 2;
  }

  .typing-indicator {
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 0 4px 7px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .typing-wave {
    display: flex;
    align-items: end;
    gap: 2px;
    height: 14px;
  }

  .typing-wave span {
    width: 3px;
    border-radius: 2px;
    background: var(--ember-500);
    animation: waveBar 1.2s ease-in-out infinite;
  }

  .typing-wave span:nth-child(1) { height: 6px; animation-delay: 0s; }
  .typing-wave span:nth-child(2) { height: 10px; animation-delay: 0.1s; }
  .typing-wave span:nth-child(3) { height: 14px; animation-delay: 0.2s; }
  .typing-wave span:nth-child(4) { height: 8px; animation-delay: 0.3s; }
  .typing-wave span:nth-child(5) { height: 4px; animation-delay: 0.4s; }

  .input-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 6px;
  }

  .input-toolbar-btn {
    padding: 3px 8px;
    border-radius: var(--radius-xs);
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    transition: var(--transition-fast);
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: inherit;
  }

  .input-toolbar-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-surface);
  }

  .input-toolbar-divider {
    width: 1px;
    height: 14px;
    background: var(--border);
  }

  .input-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 6px 4px 16px;
    transition: var(--transition-med);
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }

  .input-wrap:focus-within {
    border-color: rgba(245,158,11,0.25);
    box-shadow: 0 0 0 3px var(--border-glow), 0 0 24px rgba(245,158,11,0.04), 0 2px 8px rgba(0,0,0,0.15);
  }

  .input-wrap input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 14px;
    padding: 10px 0;
    font-family: inherit;
  }

  .input-wrap input::placeholder { color: var(--text-faint); }

  .input-actions { display: flex; gap: 2px; }

  .btn-icon {
    width: 34px;
    height: 34px;
    border-radius: var(--radius-sm);
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: var(--transition-fast);
  }

  .btn-icon:hover {
    background: var(--bg-elevated);
    color: var(--text-secondary);
  }

  .btn-send {
    width: 38px;
    height: 38px;
    border-radius: var(--radius-sm);
    border: none;
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    color: #0a0a0c;
    cursor: pointer;
    font-size: 16px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-med);
    box-shadow: 0 2px 10px rgba(245,158,11,0.2), inset 0 1px 0 rgba(255,255,255,0.15);
    position: relative;
    overflow: hidden;
  }

  .btn-send:hover {
    filter: brightness(1.1);
    box-shadow: 0 2px 16px rgba(245,158,11,0.35), inset 0 1px 0 rgba(255,255,255,0.15);
    transform: translateY(-1px);
  }

  .btn-send::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.2) 50%, transparent 60%);
    transform: translateX(-100%);
    transition: none;
  }

  .btn-send:hover::after {
    animation: sendShine 0.6s ease;
  }
</style>
