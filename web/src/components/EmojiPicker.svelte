<script>
  let { onSelect, onClose } = $props();

  let searchQuery = $state('');
  let activeCategory = $state('frequent');
  let previewEmoji = $state({ emoji: '👍', name: 'Thumbs Up', code: ':thumbsup:' });
  let searchInput = $state(null);

  const categories = [
    { id: 'frequent', icon: '🕓', label: 'Frequently used' },
    { id: 'smileys', icon: '😀', label: 'Smileys' },
    { id: 'people', icon: '👋', label: 'People' },
    { id: 'nature', icon: '🌱', label: 'Nature' },
    { id: 'food', icon: '🍕', label: 'Food' },
    { id: 'activities', icon: '⚽', label: 'Activities' },
    { id: 'objects', icon: '💡', label: 'Objects' },
    { id: 'symbols', icon: '❤️', label: 'Symbols' },
  ];

  const frequentEmojis = [
    { emoji: '👍', name: 'Thumbs Up', code: ':thumbsup:' },
    { emoji: '👎', name: 'Thumbs Down', code: ':thumbsdown:' },
    { emoji: '❤️', name: 'Red Heart', code: ':heart:' },
    { emoji: '😂', name: 'Joy', code: ':joy:' },
    { emoji: '👀', name: 'Eyes', code: ':eyes:' },
    { emoji: '⚡', name: 'Zap', code: ':zap:' },
    { emoji: '🎉', name: 'Party', code: ':tada:' },
    { emoji: '🚀', name: 'Rocket', code: ':rocket:' },
    { emoji: '🔥', name: 'Fire', code: ':fire:' },
    { emoji: '⭐', name: 'Star', code: ':star:' },
    { emoji: '💯', name: '100', code: ':100:' },
    { emoji: '✅', name: 'Check', code: ':white_check_mark:' },
    { emoji: '🙏', name: 'Pray', code: ':pray:' },
    { emoji: '🤔', name: 'Thinking', code: ':thinking:' },
    { emoji: '🙌', name: 'Raised Hands', code: ':raised_hands:' },
    { emoji: '👌', name: 'OK Hand', code: ':ok_hand:' },
  ];

  function selectEmoji(emojiData) {
    onSelect(emojiData);
  }

  import { onMount } from 'svelte';

  onMount(() => { searchInput?.focus(); });
</script>

<div class="emoji-backdrop" onclick={onClose} onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} role="presentation">
  <div
    class="emoji-picker"
    data-testid="emoji-picker"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}
    role="dialog"
    aria-label="Emoji picker"
    aria-modal="true"
  >
    <div class="emoji-picker-header">
      <label for="emoji-search-input" class="sr-only">Search emoji</label>
      <input
        id="emoji-search-input"
        class="emoji-search"
        type="text"
        placeholder="Search emoji..."
        bind:value={searchQuery}
        bind:this={searchInput}
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
          aria-label={emojiData.name}
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
    width: 380px;
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
    max-height: 260px;
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
