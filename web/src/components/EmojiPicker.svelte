<script>
  let { onSelect, onClose } = $props();

  let searchQuery = $state('');
  let activeCategory = $state('frequent');
  let previewEmoji = $state({ emoji: '\uD83D\uDC4D', name: 'Thumbs Up', code: ':thumbsup:' });

  const categories = [
    { id: 'frequent', icon: '\uD83D\uDD53', label: 'Frequently used' },
    { id: 'smileys', icon: '\uD83D\uDE00', label: 'Smileys' },
    { id: 'people', icon: '\uD83D\uDC4B', label: 'People' },
    { id: 'nature', icon: '\uD83C\uDF31', label: 'Nature' },
    { id: 'food', icon: '\uD83C\uDF55', label: 'Food' },
    { id: 'activities', icon: '\u26BD', label: 'Activities' },
    { id: 'objects', icon: '\uD83D\uDCA1', label: 'Objects' },
    { id: 'symbols', icon: '\u2764\uFE0F', label: 'Symbols' },
  ];

  const frequentEmojis = [
    { emoji: '\uD83D\uDC4D', name: 'Thumbs Up', code: ':thumbsup:' },
    { emoji: '\uD83D\uDC4E', name: 'Thumbs Down', code: ':thumbsdown:' },
    { emoji: '\u2764\uFE0F', name: 'Red Heart', code: ':heart:' },
    { emoji: '\uD83D\uDE02', name: 'Joy', code: ':joy:' },
    { emoji: '\uD83D\uDC40', name: 'Eyes', code: ':eyes:' },
    { emoji: '\u26A1', name: 'Zap', code: ':zap:' },
    { emoji: '\uD83C\uDF89', name: 'Party', code: ':tada:' },
    { emoji: '\uD83D\uDE80', name: 'Rocket', code: ':rocket:' },
    { emoji: '\uD83D\uDD25', name: 'Fire', code: ':fire:' },
    { emoji: '\u2B50', name: 'Star', code: ':star:' },
    { emoji: '\uD83D\uDCAF', name: '100', code: ':100:' },
    { emoji: '\u2705', name: 'Check', code: ':white_check_mark:' },
    { emoji: '\uD83D\uDE4F', name: 'Pray', code: ':pray:' },
    { emoji: '\uD83E\uDD14', name: 'Thinking', code: ':thinking:' },
    { emoji: '\uD83D\uDE4C', name: 'Raised Hands', code: ':raised_hands:' },
    { emoji: '\uD83D\uDC4C', name: 'OK Hand', code: ':ok_hand:' },
  ];

  function selectEmoji(emojiData) {
    onSelect(emojiData);
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="emoji-backdrop" onclick={handleBackdropClick}>
  <div class="emoji-picker" data-testid="emoji-picker">
    <div class="emoji-picker-header">
      <input
        class="emoji-search"
        type="text"
        placeholder="Search emoji..."
        bind:value={searchQuery}
        data-testid="emoji-search"
      >
    </div>
    <div class="emoji-categories">
      {#each categories as cat}
        <button
          class="emoji-cat"
          class:active={activeCategory === cat.id}
          title={cat.label}
          onclick={() => activeCategory = cat.id}
          data-testid="emoji-category-{cat.id}"
        >{cat.icon}</button>
      {/each}
    </div>
    <div class="emoji-grid-label">Frequently Used</div>
    <div class="emoji-grid">
      {#each frequentEmojis as emojiData}
        <button
          class="emoji-item"
          onclick={() => selectEmoji(emojiData)}
          onmouseenter={() => previewEmoji = emojiData}
          data-testid="emoji-item"
        >{emojiData.emoji}</button>
      {/each}
    </div>
    <div class="emoji-picker-footer">
      <span class="emoji-preview-icon">{previewEmoji.emoji}</span>
      <div class="emoji-preview-info">
        <div class="emoji-preview-name">{previewEmoji.name}</div>
        <div class="emoji-preview-code">{previewEmoji.code}</div>
      </div>
    </div>
  </div>
</div>

<style>
  .emoji-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .emoji-picker {
    position: fixed;
    bottom: 120px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    width: 340px;
    background: rgba(37, 37, 40, 0.95);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02);
    overflow: hidden;
    animation: pickerSlide 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .emoji-picker-header {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }

  .emoji-search {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 12.5px;
    outline: none;
    transition: var(--transition-med);
    font-family: inherit;
  }

  .emoji-search:focus { border-color: var(--ember-700); }
  .emoji-search::placeholder { color: var(--text-faint); }

  .emoji-categories {
    display: flex;
    gap: 2px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
  }

  .emoji-cat {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    color: var(--text-muted);
  }

  .emoji-cat:hover { background: var(--bg-surface); }
  .emoji-cat.active { background: var(--bg-surface); color: var(--text-primary); }

  .emoji-grid-label {
    padding: 8px 14px 4px;
    font-size: 10px;
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }

  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 2px;
    padding: 4px 10px 10px;
    max-height: 200px;
    overflow-y: auto;
  }

  .emoji-item {
    width: 34px;
    height: 34px;
    border-radius: 6px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .emoji-item:hover {
    background: var(--bg-surface);
    transform: scale(1.2);
  }

  .emoji-picker-footer {
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .emoji-preview-icon { font-size: 28px; }
  .emoji-preview-info { flex: 1; }
  .emoji-preview-name { font-size: 11px; font-weight: 600; color: var(--text-secondary); }
  .emoji-preview-code { font-size: 10px; color: var(--text-faint); font-family: 'SF Mono', Consolas, monospace; }
</style>
