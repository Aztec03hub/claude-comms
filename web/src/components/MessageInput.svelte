<!--
  @component MessageInput
  @description The main message composition area with a text input, formatting toolbar (bold/italic/code helpers), code snippet insertion, file attachment button, emoji picker trigger, @mention autocomplete, typing indicator display, character counter (warns at 9000, max 10000), and send button.
  @prop {object} store - The ChatStore instance for sending messages, typing notifications, and participant data.
  @prop {string} channelName - The current channel name shown in the input placeholder.
  @prop {Array} typingUsers - Array of user objects currently typing in this channel.
  @prop {Function} onOpenEmoji - Callback invoked to open the emoji picker.
-->
<script>
  import MentionDropdown from './MentionDropdown.svelte';
  import { Type, Code, Paperclip, Smile, SendHorizontal } from 'lucide-svelte';

  let { store, channelName, typingUsers = [], onOpenEmoji } = $props();

  const MAX_MESSAGE_LENGTH = 10000;
  const CHAR_WARN_THRESHOLD = 9000;

  let inputValue = $state('');
  let showMentionDropdown = $state(false);
  let showFormatHelp = $state(false);
  let attachNotice = $state('');
  let mentionQuery = $state('');
  let inputEl = $state(null);
  let fileInputEl = $state(null);

  let charCount = $derived(inputValue.length);
  let showCharCounter = $derived(charCount >= CHAR_WARN_THRESHOLD);
  let overLimit = $derived(charCount > MAX_MESSAGE_LENGTH);

  function handleInput(e) {
    inputValue = e.target.value;
    autoResize(e.target);
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
    // Shift+Enter inserts a newline (default textarea behavior, no preventDefault)
  }

  /** Auto-resize textarea to fit content, capped at 6 lines (~144px). */
  function autoResize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px';
  }

  function sendMessage() {
    if (!inputValue.trim()) return;
    if (inputValue.length > MAX_MESSAGE_LENGTH) return;
    store.sendMessage(inputValue);
    inputValue = '';
    showMentionDropdown = false;
    // Reset textarea height after clearing
    if (inputEl) {
      inputEl.style.height = 'auto';
    }
  }

  function handleAttachClick() {
    fileInputEl?.click();
  }

  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (file) {
      attachNotice = `File sharing coming soon`;
      setTimeout(() => { attachNotice = ''; }, 3000);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  }

  function toggleFormatHelp() {
    showFormatHelp = !showFormatHelp;
  }

  function insertSnippet() {
    const template = "```language\n// code here\n```";
    const cursorPos = inputEl?.selectionStart ?? inputValue.length;
    const before = inputValue.slice(0, cursorPos);
    const after = inputValue.slice(cursorPos);
    inputValue = before + template + after;
    showFormatHelp = false;
    // Focus and place cursor after insertion
    setTimeout(() => {
      inputEl?.focus();
      const newPos = cursorPos + template.length;
      inputEl?.setSelectionRange(newPos, newPos);
    }, 0);
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
    <div class="toolbar-btn-wrap">
      <button class="input-toolbar-btn" onclick={toggleFormatHelp} data-testid="input-format">
        <Type size={12} />
        Format
      </button>
      {#if showFormatHelp}
        <div class="format-help" data-testid="format-help">
          <code>**bold**</code>&nbsp;&nbsp;<code>*italic*</code>&nbsp;&nbsp;<code>`code`</code>&nbsp;&nbsp;<code>```code block```</code>
        </div>
      {/if}
    </div>
    <div class="input-toolbar-divider"></div>
    <button class="input-toolbar-btn" onclick={insertSnippet} data-testid="input-snippet">
      <Code size={12} />
      Snippet
    </button>
  </div>

  <div class="input-wrap">
    <textarea
      bind:this={inputEl}
      rows="1"
      placeholder="Message #{channelName}..."
      bind:value={inputValue}
      oninput={handleInput}
      onkeydown={handleKeydown}
      data-testid="message-input"
    ></textarea>
    <div class="input-actions">
      <input
        bind:this={fileInputEl}
        type="file"
        class="hidden-file-input"
        onchange={handleFileSelected}
        data-testid="input-file-hidden"
      />
      <button class="btn-icon" title="Attach file" onclick={handleAttachClick} data-testid="input-attach">
        <Paperclip size={18} />
      </button>
      <button class="btn-icon" title="Add emoji" onclick={onOpenEmoji} data-testid="input-emoji">
        <Smile size={18} />
      </button>
    </div>
    <button class="btn-send" title="Send message" onclick={sendMessage} data-testid="send-button">
      <SendHorizontal size={16} />
    </button>
  </div>

  {#if showCharCounter}
    <div class="char-counter" class:over-limit={overLimit} data-testid="char-counter">
      {charCount.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()}
      {#if overLimit}
        <span class="limit-warning">— message too long</span>
      {/if}
    </div>
  {/if}

  {#if attachNotice}
    <div class="attach-notice" data-testid="attach-notice">{attachNotice}</div>
  {/if}

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
    border-top: 1px solid var(--border);
    background: linear-gradient(180deg, var(--bg-base) 0%, #0e0e10 100%);
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

  .toolbar-btn-wrap {
    position: relative;
  }

  .format-help {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 6px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
    z-index: 20;
  }

  .format-help code {
    background: var(--bg-surface);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
    color: var(--ember-300);
  }

  .hidden-file-input {
    display: none;
  }

  .char-counter {
    font-size: 11px;
    color: var(--text-faint);
    text-align: right;
    padding: 3px 6px 0;
    font-variant-numeric: tabular-nums;
  }

  .char-counter.over-limit {
    color: #ef4444;
    font-weight: 600;
  }

  .limit-warning {
    font-weight: 400;
  }

  .attach-notice {
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 4px 4px 0;
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

  .input-wrap textarea {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 14px;
    padding: 10px 0;
    font-family: inherit;
    resize: none;
    overflow-y: auto;
    line-height: 1.5;
    max-height: 144px;
  }

  .input-wrap textarea::placeholder { color: var(--text-faint); }

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
    width: 36px;
    height: 36px;
    border-radius: 50%;
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

  @media (max-width: 480px) {
    .input-area {
      padding: 8px 10px 12px;
    }

    .input-toolbar {
      display: none;
    }

    .input-wrap {
      padding: 2px 4px 2px 10px;
    }
  }
</style>
