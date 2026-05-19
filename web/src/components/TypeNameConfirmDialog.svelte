<!--
  @component TypeNameConfirmDialog
  @description Confirmation modal for destructive actions that require the
    user to TYPE the resource name exactly before the Confirm button
    enables. Pattern used by GitHub / Linear / etc for "destructive action
    requires typing the name to confirm." Replaces the v0.4.0
    `window.confirm` / `window.prompt` placeholders in
    ChannelDirectoryModal's Admin tab and Sidebar's context-menu Delete
    action.

    A11y (mirrors LeaveChannelDialog Step 2.11):
    - role="dialog" + aria-modal="true" + aria-labelledby pointing at the title
    - aria-describedby pointing at the body
    - Focus trap (Tab / Shift+Tab cycle Cancel → input → Confirm and wrap)
    - Default focus is Cancel (destructive action requires explicit pick)
    - Escape = onCancel
    - Enter on the Confirm button (when enabled) = onConfirm; Enter on
      the input does NOT submit (would let typers Enter-through by reflex)
    - Outside click on overlay = onCancel
    - Focus is restored to the previously-focused element on unmount

    Disabling rule: Confirm stays `disabled` until
    `inputValue === requireTypedName` (exact, case-sensitive). The
    disabled state is also surfaced via `aria-disabled` for AT users.

  @prop {string} resourceName - Human-readable name of the resource being acted on (e.g. "channel #general").
  @prop {string} requireTypedName - Exact string the user must type to enable the Confirm button (e.g. "general" or "#general").
  @prop {string} [title] - Title text. Default: "Confirm destructive action".
  @prop {string} body - Body text explaining what will happen (e.g. "This will delete the channel and all its history.").
  @prop {string} [confirmLabel] - Label for the confirm button. Default: "Confirm".
  @prop {'danger' | 'warning' | 'primary'} [severity] - Drives button color. Default: 'danger'.
    When `'warning'`, the typed-name input is hidden and Confirm is enabled
    by default (used by Archive flows per Phil's Archive UX lock-in).
  @prop {Function} onConfirm - Called when the user types the correct string + clicks Confirm.
  @prop {Function} onCancel - Called on Cancel, Escape, or outside-click.
-->
<script>
  let {
    resourceName,
    requireTypedName,
    title = 'Confirm destructive action',
    body,
    confirmLabel = 'Confirm',
    severity = 'danger',
    onConfirm,
    onCancel,
  } = $props();

  // Stable ids so aria-labelledby / aria-describedby have something to
  // bind to. Suffix with a run-time random tag in case the dialog ever
  // mounts twice in the same document (e.g. unmount / remount in a test).
  const idSuffix = Math.random().toString(36).slice(2, 9);
  const titleId = `type-name-confirm-title-${idSuffix}`;
  const descId = `type-name-confirm-desc-${idSuffix}`;
  const promptId = `type-name-confirm-prompt-${idSuffix}`;

  let inputValue = $state('');

  // Exact, case-sensitive match. Empty `requireTypedName` would make the
  // gate trivially passable, so guard against that defensively (callers
  // SHOULD always pass a non-empty string).
  let canConfirm = $derived(
    severity === 'warning' ||
      (typeof requireTypedName === 'string' &&
        requireTypedName.length > 0 &&
        inputValue === requireTypedName)
  );

  /** @type {HTMLButtonElement | undefined} */
  let cancelBtn = $state();
  /** @type {HTMLDivElement | undefined} */
  let dialogEl = $state();

  // Capture the element that had focus BEFORE the dialog mounted so we
  // can restore focus to it when the dialog tears down.
  /** @type {HTMLElement | null} */
  let previouslyFocused = null;

  $effect(() => {
    previouslyFocused = /** @type {HTMLElement | null} */ (
      typeof document !== 'undefined' ? document.activeElement : null
    );
    // Default focus on Cancel (destructive default-focus pattern).
    // queueMicrotask defers past Svelte's mount so the binding is live.
    queueMicrotask(() => {
      cancelBtn?.focus();
    });
    return () => {
      // Restore focus on unmount, but only if the document still owns it.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  });

  /**
   * Focus trap implementation. Three focusable elements (Cancel, input,
   * Confirm) when Confirm is enabled; two when Confirm is disabled. We
   * compute the focusable set live each Tab press so disabled changes
   * don't strand focus.
   * @param {KeyboardEvent} e
   */
  function handleDialogKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
      return;
    }
    if (e.key !== 'Tab') return;
    if (!dialogEl) return;
    const focusables = /** @type {HTMLElement[]} */ (
      Array.from(
        dialogEl.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      )
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    if (e.shiftKey) {
      if (active === first || !dialogEl.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !dialogEl.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  /**
   * Local Enter handler on the Confirm button only. Global Enter is
   * deliberately NOT bound. Enter on the input does NOT submit (a typer
   * could press Enter by reflex after finishing the resource name).
   * @param {KeyboardEvent} e
   */
  function handleConfirmKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (canConfirm) onConfirm?.();
    }
  }

  /**
   * Suppress Enter on the input field. Typing the resource name and
   * hitting Enter should NOT auto-confirm. The user must tab to (or
   * click) the Confirm button to actually fire the destructive action.
   * @param {KeyboardEvent} e
   */
  function handleInputKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
    }
  }

  function handleConfirmClick() {
    if (canConfirm) onConfirm?.();
  }

  function handleOverlayClick() {
    onCancel?.();
  }

  function handleContentClick(e) {
    // Prevent overlay click from firing when the user clicks inside the
    // dialog content area.
    e.stopPropagation();
  }
</script>

<!--
  Overlay is a sibling of dialog; clicking it cancels. Plain DOM (no
  portal) so tests can mount and observe focus state without a portal
  escape hatch.
-->
<div
  class="type-name-overlay"
  data-testid="type-name-confirm-overlay"
  onclick={handleOverlayClick}
  onkeydown={handleDialogKeydown}
  role="presentation"
>
  <div
    bind:this={dialogEl}
    class="type-name-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={descId}
    data-testid="type-name-confirm-dialog"
    onclick={handleContentClick}
    onkeydown={handleDialogKeydown}
    tabindex="-1"
  >
    <div class="type-name-header">
      <h2 id={titleId} class="type-name-title" data-testid="type-name-confirm-title">
        {title}
      </h2>
    </div>

    <div id={descId} class="type-name-body" data-testid="type-name-confirm-body">
      {#if body}
        <p class="type-name-line">{body}</p>
      {/if}
      {#if resourceName}
        <p class="type-name-line type-name-resource" data-testid="type-name-confirm-resource">
          Resource: <span class="type-name-resource-value">{resourceName}</span>
        </p>
      {/if}
      {#if severity !== 'warning'}
        <label class="type-name-prompt" for={promptId} id={`${promptId}-label`}>
          Type <span class="type-name-required" data-testid="type-name-confirm-required">"{requireTypedName}"</span> to confirm:
        </label>
        <input
          id={promptId}
          type="text"
          class="type-name-input"
          data-testid="type-name-confirm-input"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          bind:value={inputValue}
          onkeydown={handleInputKeydown}
        />
      {/if}
    </div>

    <div class="type-name-footer">
      <button
        bind:this={cancelBtn}
        type="button"
        class="type-name-btn secondary"
        onclick={() => onCancel?.()}
        data-testid="type-name-confirm-cancel"
      >Cancel</button>
      <button
        type="button"
        class="type-name-btn {severity}"
        disabled={!canConfirm}
        aria-disabled={!canConfirm}
        onclick={handleConfirmClick}
        onkeydown={handleConfirmKeydown}
        data-testid="type-name-confirm-confirm"
      >{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .type-name-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: overlayIn 0.2s ease both;
  }

  .type-name-modal {
    width: 460px;
    max-width: calc(100vw - 32px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04);
    animation: modalIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    overflow: hidden;
    outline: none;
  }

  .type-name-header {
    padding: 20px 24px 12px;
  }

  .type-name-title {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.3px;
    margin: 0;
    color: var(--text-primary);
  }

  .type-name-body {
    padding: 0 24px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .type-name-line {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  .type-name-resource {
    color: var(--text-secondary);
  }

  .type-name-resource-value {
    color: var(--text-primary);
    font-weight: 600;
  }

  .type-name-prompt {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin-top: 4px;
  }

  .type-name-required {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
    color: var(--text-primary);
    font-weight: 600;
  }

  .type-name-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
    outline: none;
    transition: var(--transition-fast);
  }

  .type-name-input:focus {
    border-color: var(--accent, #60a5fa);
    box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.2);
  }

  .type-name-footer {
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .type-name-btn {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
    border: none;
    font-family: inherit;
  }

  .type-name-btn.secondary {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .type-name-btn.secondary:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .type-name-btn.danger {
    background: linear-gradient(135deg, #dc2626, #ef4444);
    color: white;
    box-shadow: 0 2px 8px rgba(239, 68, 68, 0.3);
  }

  .type-name-btn.danger:hover:not(:disabled) {
    filter: brightness(1.1);
    box-shadow: 0 2px 12px rgba(239, 68, 68, 0.4);
  }

  .type-name-btn.warning {
    background: linear-gradient(135deg, #d97706, #f59e0b);
    color: white;
    box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);
  }

  .type-name-btn.warning:hover:not(:disabled) {
    filter: brightness(1.1);
    box-shadow: 0 2px 12px rgba(245, 158, 11, 0.4);
  }

  .type-name-btn.primary {
    background: linear-gradient(135deg, #2563eb, #3b82f6);
    color: white;
    box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
  }

  .type-name-btn.primary:hover:not(:disabled) {
    filter: brightness(1.1);
    box-shadow: 0 2px 12px rgba(59, 130, 246, 0.4);
  }

  .type-name-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
    filter: grayscale(0.4);
  }

  @keyframes overlayIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes modalIn {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>
