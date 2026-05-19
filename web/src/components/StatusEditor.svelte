<!--
  @component StatusEditor (v0.4.2 Step 3.13, UX G-24)
  @description Popover for setting / clearing the local user's profile
  status. Renders an inline 8-emoji strip + free-text input for
  arbitrary glyphs (max 60 chars + live char counter), four expiry
  presets (Never / 1h / 4h / Until tomorrow), and Save / Clear / Cancel
  actions. The 5th "Custom" expiry option in the spec is deferred — UX
  feedback during Wave-E.1 dispatch flagged datetime pickers as
  out-of-scope for this step; the four presets cover the common cases.
  Document this trade-off in the worklog.

  Anchor: rendered inside Sidebar.svelte directly above the identity
  row. Positioned via fixed-bottom-left to avoid clipping by the
  sidebar's overflow:hidden.

  Reuse decision (vs the existing EmojiPicker.svelte): rolled inline.
  EmojiPicker is a full-screen modal (position:fixed; inset:0; backdrop)
  and would visually fight a nested popover. The 8 frequently-used
  glyphs cover the status use-case; the text input accepts any glyph
  the user pastes anyway.

  @prop {{emoji:string|null,text:string|null,expires_at:string|null}|null} currentStatus
  @prop {(emoji:string|null,text:string|null,expiresAt:string|null) => void|Promise<void>} onSave
  @prop {() => void|Promise<void>} onClear
  @prop {() => void} onCancel
-->
<script>
  /** @type {{ currentStatus: {emoji: string|null, text: string|null, expires_at: string|null} | null, onSave: (emoji: string|null, text: string|null, expiresAt: string|null) => void, onClear: () => void, onCancel: () => void }} */
  let { currentStatus, onSave, onClear, onCancel } = $props();

  const EMOJI_CHOICES = ['💬', '🍵', '🎧', '🧠', '🛌', '🏃', '🤒', '🌴'];
  const MAX_TEXT_LEN = 60;
  const EXPIRY_OPTIONS = [
    { id: 'never',     label: 'Never' },
    { id: '1h',        label: '1 hour' },
    { id: '4h',        label: '4 hours' },
    { id: 'tomorrow',  label: 'Until tomorrow' },
  ];

  // Initialize the editable form values from the ``currentStatus`` prop
  // EXACTLY ONCE at mount. The component is mounted/unmounted on each
  // open/close of the popover (controlled by Sidebar's
  // ``statusEditorOpen``), so capturing the initial value here is
  // correct — no need to react to live prop updates while the popover
  // is open. Wrap the read in a closure to keep the Svelte static
  // analyzer (``state_referenced_locally``) happy without firing a
  // tracker that would re-init on every prop change.
  const readInitial = () => ({
    emoji: currentStatus?.emoji ?? '',
    text: currentStatus?.text ?? '',
  });
  const seed = readInitial();
  let emoji = $state(seed.emoji);
  let text = $state(seed.text);
  let expiry = $state('never');

  let charCount = $derived(text.length);
  let charCountOverflow = $derived(charCount > MAX_TEXT_LEN);
  let canSave = $derived(
    (emoji.trim().length > 0 || text.trim().length > 0) && !charCountOverflow,
  );

  /**
   * Translate a preset id ("never" / "1h" / "4h" / "tomorrow") into an
   * ISO-8601 timestamp suitable for the ``expires_at`` MCP arg, or
   * ``null`` for "never expires".
   *
   * Uses Date.now() so spec coverage can lock the absolute deltas via
   * vi.useFakeTimers(). "Until tomorrow" is 24 hours from now (NOT
   * literal midnight) to keep the expiry boundary timezone-independent.
   *
   * @param {string} preset
   * @returns {string|null}
   */
  function computeExpiresAt(preset) {
    if (preset === 'never') return null;
    const now = Date.now();
    let deltaMs;
    if (preset === '1h')        deltaMs = 60 * 60 * 1000;
    else if (preset === '4h')   deltaMs = 4 * 60 * 60 * 1000;
    else if (preset === 'tomorrow') deltaMs = 24 * 60 * 60 * 1000;
    else                        return null;
    return new Date(now + deltaMs).toISOString();
  }

  function handleSave() {
    if (!canSave) return;
    const trimmedEmoji = emoji.trim();
    const trimmedText = text.trim();
    const expiresAt = computeExpiresAt(expiry);
    onSave(
      trimmedEmoji ? trimmedEmoji : null,
      trimmedText ? trimmedText : null,
      expiresAt,
    );
  }

  function handleClear() {
    onClear();
  }

  function handleCancel() {
    onCancel();
  }

  function pickEmoji(g) {
    emoji = g;
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }
</script>

<div
  class="status-backdrop"
  data-testid="status-editor-backdrop"
  onclick={handleCancel}
  onkeydown={handleKeydown}
  role="presentation"
>
  <div
    class="status-editor"
    data-testid="status-editor"
    onclick={(e) => e.stopPropagation()}
    onkeydown={handleKeydown}
    role="dialog"
    aria-label="Set status"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="se-header">
      <span class="se-title">Set a status</span>
    </div>

    <div class="se-row se-emoji-row">
      <div class="se-emoji-strip" data-testid="status-editor-emoji-strip">
        {#each EMOJI_CHOICES as glyph (glyph)}
          <button
            type="button"
            class="se-emoji-btn"
            class:active={emoji === glyph}
            onclick={() => pickEmoji(glyph)}
            data-testid="status-editor-emoji-{glyph}"
            aria-label={`Choose emoji ${glyph}`}
          >{glyph}</button>
        {/each}
      </div>
      <label class="se-emoji-custom-label" for="se-emoji-input">
        <span class="sr-only">Or type any emoji</span>
        <input
          id="se-emoji-input"
          class="se-emoji-input"
          type="text"
          placeholder="Any"
          bind:value={emoji}
          maxlength="8"
          data-testid="status-editor-emoji-input"
        />
      </label>
    </div>

    <div class="se-row">
      <label class="se-text-label" for="se-text-input">
        <span class="sr-only">Status text</span>
        <input
          id="se-text-input"
          class="se-text-input"
          type="text"
          placeholder="What's your status?"
          bind:value={text}
          maxlength={MAX_TEXT_LEN}
          data-testid="status-editor-text-input"
        />
      </label>
      <span
        class="se-char-count"
        class:overflow={charCountOverflow}
        data-testid="status-editor-char-count"
      >{charCount}/{MAX_TEXT_LEN}</span>
    </div>

    <div class="se-row se-expiry-row">
      <span class="se-expiry-label">Clear after:</span>
      <div class="se-expiry-options">
        {#each EXPIRY_OPTIONS as opt (opt.id)}
          <button
            type="button"
            class="se-expiry-btn"
            class:active={expiry === opt.id}
            onclick={() => expiry = opt.id}
            data-testid="status-editor-expiry-{opt.id}"
          >{opt.label}</button>
        {/each}
      </div>
    </div>

    <div class="se-actions">
      <button
        type="button"
        class="se-btn se-btn-clear"
        onclick={handleClear}
        data-testid="status-editor-clear"
      >Clear status</button>
      <div class="se-actions-right">
        <button
          type="button"
          class="se-btn se-btn-cancel"
          onclick={handleCancel}
          data-testid="status-editor-cancel"
        >Cancel</button>
        <button
          type="button"
          class="se-btn se-btn-save"
          onclick={handleSave}
          disabled={!canSave}
          data-testid="status-editor-save"
        >Save</button>
      </div>
    </div>
  </div>
</div>

<style>
  .status-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: transparent;
  }
  .status-editor {
    position: fixed;
    left: 14px;
    bottom: 76px;
    width: 312px;
    background: rgba(37, 37, 40, 0.97);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.02);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    z-index: 91;
  }
  .se-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .se-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-faint);
  }
  .se-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .se-emoji-row {
    flex-wrap: wrap;
  }
  .se-emoji-strip {
    display: flex;
    gap: 2px;
    flex: 1;
  }
  .se-emoji-btn {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    color: var(--text-primary);
  }
  .se-emoji-btn:hover {
    background: var(--bg-surface);
  }
  .se-emoji-btn.active {
    border-color: var(--ember-700);
    background: rgba(245, 158, 11, 0.08);
  }
  .se-emoji-custom-label {
    display: flex;
  }
  .se-emoji-input {
    width: 56px;
    padding: 6px 8px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
    transition: var(--transition-med);
    text-align: center;
  }
  .se-emoji-input:focus { border-color: var(--ember-700); }
  .se-text-label {
    flex: 1;
    display: flex;
  }
  .se-text-input {
    width: 100%;
    padding: 7px 10px;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 12.5px;
    outline: none;
    transition: var(--transition-med);
  }
  .se-text-input:focus { border-color: var(--ember-700); }
  .se-text-input::placeholder { color: var(--text-faint); }
  .se-char-count {
    font-size: 10px;
    color: var(--text-faint);
    font-family: 'SF Mono', Consolas, monospace;
    min-width: 38px;
    text-align: right;
  }
  .se-char-count.overflow { color: #f87171; }
  .se-expiry-row {
    flex-wrap: wrap;
  }
  .se-expiry-label {
    font-size: 11px;
    color: var(--text-faint);
    flex-basis: 100%;
    margin-bottom: 2px;
  }
  .se-expiry-options {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .se-expiry-btn {
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-base);
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }
  .se-expiry-btn:hover { border-color: var(--ember-700); color: var(--ember-400); }
  .se-expiry-btn.active {
    background: rgba(245, 158, 11, 0.08);
    border-color: var(--ember-700);
    color: var(--ember-400);
  }
  .se-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--border);
  }
  .se-actions-right {
    display: flex;
    gap: 6px;
  }
  .se-btn {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-base);
    color: var(--text-secondary);
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }
  .se-btn:hover:not(:disabled) {
    border-color: var(--ember-700);
    color: var(--text-primary);
  }
  .se-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .se-btn-clear {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.25);
  }
  .se-btn-clear:hover {
    background: rgba(248, 113, 113, 0.08);
    border-color: rgba(248, 113, 113, 0.5);
    color: #fca5a5;
  }
  .se-btn-save {
    background: linear-gradient(135deg, var(--ember-600), var(--ember-500));
    border-color: var(--ember-700);
    color: #0a0a0c;
  }
  .se-btn-save:hover:not(:disabled) {
    color: #0a0a0c;
    box-shadow: 0 2px 10px rgba(245, 158, 11, 0.25);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
