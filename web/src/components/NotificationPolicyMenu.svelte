<!--
  @component NotificationPolicyMenu
  @description Floating popover for v0.4.2 Step 3.9 (Wave G): per-channel
    notification policy + Q7 highlight-words editor. Three mutually
    exclusive radio buttons (``All`` / ``Mentions`` / ``Off``), a
    comma-separated text input for highlight words, and Save / Cancel
    buttons. Pure UI — does NOT call the store directly; the parent
    (App.svelte) owns the ``onSave({policy, highlightWords})`` callback
    so this component stays test-mountable without store wiring.

    Q7 (highlight words): label is
      "Highlight when these words appear (comma-separated)"
    The text input round-trips through the parent. Words are lowercased
    + trimmed at the store layer (``setNotificationPolicy``) so this
    component can pass the raw comma-split tokens through without
    pre-normalizing.

    Q8 quickview compatibility: the same store accessor backs both this
    full popover and the kebab quickview 1-click cycle. This component
    is the "Configure notifications..." entry point — discoverable, full
    expressive surface; the quickview is the power-user 1-click cycle.

  @prop {string} channelId - Channel id (consumed by parent's onSave;
    NotificationPolicyMenu does not call the store directly).
  @prop {'All' | 'Mentions' | 'Off'} currentPolicy - The radio initial
    selection.
  @prop {string[]} currentHighlightWords - The text input initial value
    (joined with ", " for display).
  @prop {(payload: {policy: 'All' | 'Mentions' | 'Off', highlightWords: string[]}) => void} onSave -
    Invoked on Save click with the picked policy + parsed words array
    (comma-split, trimmed, empty-filtered; lowercasing happens at the
    store layer).
  @prop {() => void} onCancel - Invoked on Cancel click or Escape.
-->
<script>
  import { tick, untrack } from 'svelte';

  let {
    channelId,
    currentPolicy = 'All',
    currentHighlightWords = [],
    onSave,
    onCancel,
  } = $props();

  // Local form state. Initialized from props ONCE on mount via untrack
  // so the form state doesn't snap back to ``currentPolicy`` /
  // ``currentHighlightWords`` mid-edit if the parent re-renders the
  // dialog with the same channel (e.g. a sibling store re-derive
  // tick). Save flushes through onSave, Cancel discards. Wrapping in
  // ``untrack`` is the Svelte-5-idiomatic way to silence the
  // ``state_referenced_locally`` warning while keeping the
  // initialize-from-props semantics that match every other modal in
  // the app.
  let policy = $state(untrack(() => currentPolicy));
  let wordsText = $state(
    untrack(() =>
      Array.isArray(currentHighlightWords) ? currentHighlightWords.join(', ') : '',
    ),
  );

  // Focus the first radio on mount for keyboard-only users.
  let rootEl = $state(/** @type {HTMLElement | null} */ (null));
  let positioned = false;
  $effect(() => {
    if (!rootEl || positioned) return;
    positioned = true;
    tick().then(() => {
      const first = rootEl?.querySelector('input[type="radio"]');
      if (first instanceof HTMLElement) first.focus();
    });
  });

  function parseWords(text) {
    if (typeof text !== 'string') return [];
    return text
      .split(',')
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
  }

  function handleSave() {
    onSave?.({
      policy,
      highlightWords: parseWords(wordsText),
    });
  }

  function handleCancel() {
    onCancel?.();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handleCancel();
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }}
/>

<div
  bind:this={rootEl}
  class="notif-policy-menu"
  role="dialog"
  tabindex="-1"
  aria-label="Notification policy for {channelId}"
  data-testid="notification-policy-menu"
  data-channel-id={channelId}
  onkeydown={handleKeydown}
>
  <div class="menu-title">Notifications</div>

  <fieldset class="policy-group">
    <legend class="visually-hidden">Notification policy</legend>

    <label class="radio-row">
      <input
        type="radio"
        name="notif-policy-{channelId}"
        value="All"
        checked={policy === 'All'}
        onchange={() => (policy = 'All')}
        data-testid="notif-policy-radio-All"
      />
      <span class="radio-label">
        <span class="radio-title">All messages</span>
        <span class="radio-sub">Toast on every message in this channel.</span>
      </span>
    </label>

    <label class="radio-row">
      <input
        type="radio"
        name="notif-policy-{channelId}"
        value="Mentions"
        checked={policy === 'Mentions'}
        onchange={() => (policy = 'Mentions')}
        data-testid="notif-policy-radio-Mentions"
      />
      <span class="radio-label">
        <span class="radio-title">Only mentions</span>
        <span class="radio-sub">Toast on @mentions and highlight-word hits.</span>
      </span>
    </label>

    <label class="radio-row">
      <input
        type="radio"
        name="notif-policy-{channelId}"
        value="Off"
        checked={policy === 'Off'}
        onchange={() => (policy = 'Off')}
        data-testid="notif-policy-radio-Off"
      />
      <span class="radio-label">
        <span class="radio-title">Off</span>
        <span class="radio-sub">No toasts. Unread count still tracked.</span>
      </span>
    </label>
  </fieldset>

  <label class="highlight-row">
    <span class="highlight-label">
      Highlight when these words appear (comma-separated)
    </span>
    <input
      type="text"
      class="highlight-input"
      bind:value={wordsText}
      placeholder="release, bug, deploy"
      data-testid="notif-policy-highlight-words"
      autocomplete="off"
      spellcheck="false"
    />
  </label>

  <div class="button-row">
    <button
      type="button"
      class="btn btn-cancel"
      onclick={handleCancel}
      data-testid="notif-policy-cancel"
    >
      Cancel
    </button>
    <button
      type="button"
      class="btn btn-save"
      onclick={handleSave}
      data-testid="notif-policy-save"
    >
      Save
    </button>
  </div>
</div>

<style>
  .notif-policy-menu {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 260;
    min-width: 320px;
    max-width: 400px;
    background: rgba(37, 37, 40, 0.96);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm, 10px);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(255, 255, 255, 0.02);
    padding: 16px 16px 14px;
    animation: menuIn 0.14s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes menuIn {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-50% - 4px));
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%);
    }
  }

  .menu-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #f1f1f3);
    margin-bottom: 10px;
  }

  .policy-group {
    border: none;
    padding: 0;
    margin: 0 0 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .visually-hidden {
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

  .radio-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 7px 8px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-secondary, #c8c8cf);
    transition: background 80ms ease, color 80ms ease;
  }

  .radio-row:hover,
  .radio-row:focus-within {
    background: var(--bg-surface, rgba(255, 255, 255, 0.04));
    color: var(--text-primary, #f1f1f3);
  }

  .radio-row input[type='radio'] {
    margin-top: 3px;
    accent-color: var(--ember-500, #f59e0b);
  }

  .radio-label {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
  }

  .radio-title {
    font-size: 13px;
    font-weight: 500;
  }

  .radio-sub {
    font-size: 11px;
    color: var(--text-faint, #6b6b6b);
  }

  .highlight-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }

  .highlight-label {
    font-size: 11px;
    color: var(--text-muted, var(--text-faint, #6b6b6b));
  }

  .highlight-input {
    width: 100%;
    padding: 7px 10px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: var(--bg-elevated, rgba(255, 255, 255, 0.03));
    color: var(--text-primary, #f1f1f3);
    font: inherit;
    font-size: 13px;
    outline: none;
    transition: border-color 0.12s ease, background 0.12s ease;
  }

  .highlight-input:focus-visible {
    border-color: rgba(245, 158, 11, 0.5);
    background: var(--bg-elevated, rgba(255, 255, 255, 0.05));
  }

  .button-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    transition: background 0.12s ease, color 0.12s ease,
      border-color 0.12s ease;
  }

  .btn-cancel {
    background: transparent;
    color: var(--text-secondary, #c8c8cf);
    border-color: rgba(255, 255, 255, 0.06);
  }
  .btn-cancel:hover {
    background: var(--bg-surface, rgba(255, 255, 255, 0.04));
    color: var(--text-primary, #f1f1f3);
  }

  .btn-save {
    background: linear-gradient(
      135deg,
      var(--ember-500, #f59e0b),
      var(--ember-400, #fbbf24)
    );
    color: #0a0a0c;
    font-weight: 600;
  }
  .btn-save:hover {
    background: linear-gradient(
      135deg,
      var(--ember-400, #fbbf24),
      var(--ember-300, #fcd34d)
    );
  }

  .btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.4);
  }
</style>
