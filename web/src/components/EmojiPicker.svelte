<!--
  @component EmojiPicker
  @description Floating emoji picker dialog with category tabs, search input, a grid of frequently-used emojis, and a live preview footer. Auto-focuses the search on mount.
  @prop {Function} onSelect - Callback invoked with the selected emoji data object ({ emoji, name, code }).
  @prop {Function} onClose - Callback invoked when the picker is dismissed (backdrop click or Escape).
-->
<script>
  import { onMount } from 'svelte';

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

  // Per-category datasets so the category tabs actually switch the grid.
  // Codes are unique within each list (the `{#each}` key); the cross-category
  // search dedups by code below.
  const emojisByCategory = {
    frequent: frequentEmojis,
    smileys: [
      { emoji: '😀', name: 'Grinning', code: ':grinning:' },
      { emoji: '😃', name: 'Smiley', code: ':smiley:' },
      { emoji: '😄', name: 'Smile', code: ':smile:' },
      { emoji: '😁', name: 'Grin', code: ':grin:' },
      { emoji: '😆', name: 'Laughing', code: ':laughing:' },
      { emoji: '😅', name: 'Sweat Smile', code: ':sweat_smile:' },
      { emoji: '🤣', name: 'Rolling On The Floor Laughing', code: ':rofl:' },
      { emoji: '🙂', name: 'Slightly Smiling', code: ':slightly_smiling:' },
      { emoji: '😉', name: 'Wink', code: ':wink:' },
      { emoji: '😍', name: 'Heart Eyes', code: ':heart_eyes:' },
      { emoji: '😘', name: 'Kissing Heart', code: ':kissing_heart:' },
      { emoji: '😎', name: 'Sunglasses', code: ':sunglasses:' },
      { emoji: '🤔', name: 'Thinking Face', code: ':thinking_face:' },
      { emoji: '🤩', name: 'Star Struck', code: ':star_struck:' },
      { emoji: '🥳', name: 'Partying Face', code: ':partying_face:' },
      { emoji: '😴', name: 'Sleeping', code: ':sleeping:' },
    ],
    people: [
      { emoji: '👋', name: 'Wave', code: ':wave:' },
      { emoji: '🙌', name: 'Raised Hands', code: ':raised_hands2:' },
      { emoji: '👏', name: 'Clap', code: ':clap:' },
      { emoji: '🙏', name: 'Pray', code: ':pray2:' },
      { emoji: '💪', name: 'Muscle', code: ':muscle:' },
      { emoji: '🤝', name: 'Handshake', code: ':handshake:' },
      { emoji: '👈', name: 'Point Left', code: ':point_left:' },
      { emoji: '👉', name: 'Point Right', code: ':point_right:' },
      { emoji: '👆', name: 'Point Up', code: ':point_up:' },
      { emoji: '👇', name: 'Point Down', code: ':point_down:' },
      { emoji: '✌️', name: 'Victory', code: ':v:' },
      { emoji: '🤞', name: 'Crossed Fingers', code: ':crossed_fingers:' },
      { emoji: '🤙', name: 'Call Me', code: ':call_me:' },
      { emoji: '👌', name: 'OK Hand', code: ':ok_hand2:' },
      { emoji: '🫶', name: 'Heart Hands', code: ':heart_hands:' },
      { emoji: '🧑', name: 'Person', code: ':person:' },
    ],
    nature: [
      { emoji: '🌱', name: 'Seedling', code: ':seedling:' },
      { emoji: '🌳', name: 'Tree', code: ':tree:' },
      { emoji: '🌲', name: 'Evergreen', code: ':evergreen:' },
      { emoji: '🌸', name: 'Cherry Blossom', code: ':cherry_blossom:' },
      { emoji: '🌻', name: 'Sunflower', code: ':sunflower:' },
      { emoji: '🌹', name: 'Rose', code: ':rose:' },
      { emoji: '🍀', name: 'Four Leaf Clover', code: ':four_leaf_clover:' },
      { emoji: '🌿', name: 'Herb', code: ':herb:' },
      { emoji: '🌍', name: 'Earth', code: ':earth:' },
      { emoji: '🌙', name: 'Crescent Moon', code: ':crescent_moon:' },
      { emoji: '⭐', name: 'Star', code: ':star2:' },
      { emoji: '🌈', name: 'Rainbow', code: ':rainbow:' },
      { emoji: '🔥', name: 'Fire', code: ':fire2:' },
      { emoji: '💧', name: 'Droplet', code: ':droplet:' },
      { emoji: '❄️', name: 'Snowflake', code: ':snowflake:' },
      { emoji: '⚡', name: 'Zap', code: ':zap2:' },
    ],
    food: [
      { emoji: '🍕', name: 'Pizza', code: ':pizza:' },
      { emoji: '🍔', name: 'Hamburger', code: ':hamburger:' },
      { emoji: '🍟', name: 'Fries', code: ':fries:' },
      { emoji: '🌮', name: 'Taco', code: ':taco:' },
      { emoji: '🍣', name: 'Sushi', code: ':sushi:' },
      { emoji: '🍜', name: 'Ramen', code: ':ramen:' },
      { emoji: '🍎', name: 'Apple', code: ':apple:' },
      { emoji: '🍌', name: 'Banana', code: ':banana:' },
      { emoji: '🍓', name: 'Strawberry', code: ':strawberry:' },
      { emoji: '🍩', name: 'Doughnut', code: ':doughnut:' },
      { emoji: '🍪', name: 'Cookie', code: ':cookie:' },
      { emoji: '🍰', name: 'Cake', code: ':cake:' },
      { emoji: '☕', name: 'Coffee', code: ':coffee:' },
      { emoji: '🍺', name: 'Beer', code: ':beer:' },
      { emoji: '🍷', name: 'Wine', code: ':wine:' },
      { emoji: '🥑', name: 'Avocado', code: ':avocado:' },
    ],
    activities: [
      { emoji: '⚽', name: 'Soccer', code: ':soccer:' },
      { emoji: '🏀', name: 'Basketball', code: ':basketball:' },
      { emoji: '🏈', name: 'Football', code: ':football:' },
      { emoji: '⚾', name: 'Baseball', code: ':baseball:' },
      { emoji: '🎾', name: 'Tennis', code: ':tennis:' },
      { emoji: '🏐', name: 'Volleyball', code: ':volleyball:' },
      { emoji: '🎱', name: '8 Ball', code: ':8ball:' },
      { emoji: '🏓', name: 'Ping Pong', code: ':ping_pong:' },
      { emoji: '🥇', name: 'First Place', code: ':first_place:' },
      { emoji: '🏆', name: 'Trophy', code: ':trophy:' },
      { emoji: '🎮', name: 'Video Game', code: ':video_game:' },
      { emoji: '🎲', name: 'Game Die', code: ':game_die:' },
      { emoji: '🎯', name: 'Dart', code: ':dart:' },
      { emoji: '🎸', name: 'Guitar', code: ':guitar:' },
      { emoji: '🎨', name: 'Art', code: ':art:' },
      { emoji: '🚴', name: 'Cyclist', code: ':cyclist:' },
    ],
    objects: [
      { emoji: '💡', name: 'Bulb', code: ':bulb:' },
      { emoji: '💻', name: 'Computer', code: ':computer:' },
      { emoji: '📱', name: 'Phone', code: ':phone:' },
      { emoji: '⌨️', name: 'Keyboard', code: ':keyboard:' },
      { emoji: '🖱️', name: 'Mouse', code: ':computer_mouse:' },
      { emoji: '📷', name: 'Camera', code: ':camera:' },
      { emoji: '🔋', name: 'Battery', code: ':battery:' },
      { emoji: '🔌', name: 'Plug', code: ':plug:' },
      { emoji: '💾', name: 'Floppy Disk', code: ':floppy:' },
      { emoji: '📦', name: 'Package', code: ':package:' },
      { emoji: '🔧', name: 'Wrench', code: ':wrench:' },
      { emoji: '🔨', name: 'Hammer', code: ':hammer:' },
      { emoji: '📌', name: 'Pushpin', code: ':pushpin:' },
      { emoji: '📎', name: 'Paperclip', code: ':paperclip:' },
      { emoji: '🔑', name: 'Key', code: ':key:' },
      { emoji: '🔒', name: 'Lock', code: ':lock:' },
    ],
    symbols: [
      { emoji: '❤️', name: 'Red Heart', code: ':heart2:' },
      { emoji: '🧡', name: 'Orange Heart', code: ':orange_heart:' },
      { emoji: '💛', name: 'Yellow Heart', code: ':yellow_heart:' },
      { emoji: '💚', name: 'Green Heart', code: ':green_heart:' },
      { emoji: '💙', name: 'Blue Heart', code: ':blue_heart:' },
      { emoji: '💜', name: 'Purple Heart', code: ':purple_heart:' },
      { emoji: '🖤', name: 'Black Heart', code: ':black_heart:' },
      { emoji: '✅', name: 'Check', code: ':check2:' },
      { emoji: '❌', name: 'Cross Mark', code: ':x:' },
      { emoji: '⭕', name: 'Circle', code: ':o:' },
      { emoji: '❗', name: 'Exclamation', code: ':exclamation:' },
      { emoji: '❓', name: 'Question', code: ':question:' },
      { emoji: '💯', name: 'Hundred', code: ':hundred2:' },
      { emoji: '♻️', name: 'Recycle', code: ':recycle:' },
      { emoji: '✨', name: 'Sparkles', code: ':sparkles:' },
      { emoji: '⚠️', name: 'Warning', code: ':warning:' },
    ],
  };

  // Flattened, code-deduped list for cross-category search.
  const allEmojis = (() => {
    const seen = new Set();
    const out = [];
    for (const list of Object.values(emojisByCategory)) {
      for (const e of list) {
        if (seen.has(e.code)) continue;
        seen.add(e.code);
        out.push(e);
      }
    }
    return out;
  })();

  // The grid is driven by these derivations so BOTH the category tabs and the
  // search box change what renders:
  //   - non-empty query  → matches across ALL categories (name / code / glyph)
  //   - empty query      → the active category's dataset
  let filteredEmojis = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return emojisByCategory[activeCategory] ?? frequentEmojis;
    const raw = searchQuery.trim();
    return allEmojis.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.code.toLowerCase().includes(q) ||
        e.emoji.includes(raw),
    );
  });

  let gridLabel = $derived(
    searchQuery.trim()
      ? 'Search results'
      : (categories.find((c) => c.id === activeCategory)?.label ?? 'Frequently used'),
  );

  function selectEmoji(emojiData) {
    onSelect(emojiData);
  }

  /**
   * Submit the raw search query as a free-text reaction.
   * Per v4 of the richer-expression plan, free-text is first-class:
   * any short token (unicode emoji, ":heart:" shortcode, or arbitrary
   * <= 32-char slug) is a valid reaction.
   */
  function submitFreeText() {
    const raw = searchQuery.trim();
    if (!raw) return;
    if (raw.length > 32) return; // server will also enforce
    // Treat the raw input as both the visible token and the code form.
    onSelect({ emoji: raw, name: raw, code: raw });
  }

  function onSearchKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitFreeText();
    }
  }

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
    tabindex="-1"
  >
    <div class="emoji-picker-header">
      <label for="emoji-search-input" class="sr-only">Search emoji</label>
      <input
        id="emoji-search-input"
        class="emoji-search"
        type="text"
        placeholder="Search or type a reaction... (Enter to submit)"
        bind:value={searchQuery}
        bind:this={searchInput}
        onkeydown={onSearchKeydown}
        data-testid="emoji-search"
        maxlength="32"
      >
    </div>
    <div class="emoji-categories">
      {#each categories as cat (cat.id)}
        <button
          class="emoji-cat"
          class:active={activeCategory === cat.id}
          title={cat.label}
          onclick={() => activeCategory = cat.id}
          data-testid="emoji-category-{cat.id}"
        >{cat.icon}</button>
      {/each}
    </div>
    <div class="emoji-grid-label" data-testid="emoji-grid-label">{gridLabel}</div>
    <div class="emoji-grid">
      {#each filteredEmojis as emojiData (emojiData.code)}
        <button
          class="emoji-item"
          onclick={() => selectEmoji(emojiData)}
          onmouseenter={() => previewEmoji = emojiData}
          data-testid="emoji-item"
          aria-label={emojiData.name}
        >{emojiData.emoji}</button>
      {:else}
        <div class="emoji-empty" data-testid="emoji-empty">
          No matches — press Enter to react with "{searchQuery.trim()}"
        </div>
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

  .emoji-empty {
    grid-column: 1 / -1;
    padding: 18px 8px;
    text-align: center;
    font-size: 11.5px;
    color: var(--text-faint);
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
