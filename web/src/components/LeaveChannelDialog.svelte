<!--
  @component LeaveChannelDialog
  @description Confirmation modal for leaving a channel where the user has
    enough invested (>50 messages, pinned authorship, or starred) that an
    accidental leave would be painful. Per Design Spec §4.1 + v0.4.0 plan
    Step 2.11. The parent (Sidebar) decides whether to mount this dialog;
    if none of the trigger conditions hold, leave proceeds silently.

    A11y:
    - role="dialog" + aria-modal="true" + aria-labelledby pointing at the title
    - Focus trap (Tab / Shift+Tab cycle between Cancel and Leave)
    - Default focus is Cancel (destructive primary requires explicit pick)
    - Escape = onCancel
    - Enter on the Leave button = onConfirm (NOT a global Enter — prevents
      accidental confirm when Cancel has focus)
    - Focus is restored to the previously-focused element on unmount

  @prop {{ id: string, name: string }} channel - The channel being left.
  @prop {number} messageCount - Messages the user has sent in this channel.
  @prop {boolean} isStarred - Whether the channel is currently starred.
  @prop {boolean} hasPinnedMessages - Whether the user has pinned authorship here.
  @prop {Function} onConfirm - Called when the user confirms the leave.
  @prop {Function} onCancel - Called when the user dismisses the dialog.
-->
<script>
  let {
    channel,
    messageCount = 0,
    isStarred = false,
    hasPinnedMessages = false,
    onConfirm,
    onCancel,
  } = $props();

  // Stable ids so aria-labelledby has something to bind to. Suffix with a
  // run-time random tag in case the dialog ever mounts twice in the same
  // document (e.g. unmount/remount during a test).
  const idSuffix = Math.random().toString(36).slice(2, 9);
  const titleId = `leave-channel-title-${idSuffix}`;
  const descId = `leave-channel-desc-${idSuffix}`;

  /** @type {HTMLButtonElement | undefined} */
  let cancelBtn = $state();
  /** @type {HTMLDivElement | undefined} */
  let dialogEl = $state();

  // Capture the element that had focus BEFORE the dialog mounted so we
  // can restore focus to it when the dialog tears down. We grab it
  // synchronously in an $effect so SSR is unaffected and the value is
  // captured on the FIRST client-side run, before our own auto-focus has
  // shifted document.activeElement.
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
      // Restore focus on unmount, but only if the document still owns it
      // (don't yank focus from whatever the user clicked into).
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  });

  /**
   * Focus trap implementation. We have exactly two focusable elements
   * (Cancel + Leave) so cycling is trivial: Tab on Leave goes to Cancel,
   * Shift+Tab on Cancel goes to Leave.
   *
   * Implemented at the dialog root via onkeydown so we don't need to
   * attach per-button handlers and stay robust if a third focusable is
   * added later (it falls back to default Tab order between them).
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
   * Local Enter handler on the Leave button only. Global Enter is
   * deliberately NOT bound — landing on Cancel and pressing Enter should
   * cancel (the button's default activation handles that), not confirm.
   * @param {KeyboardEvent} e
   */
  function handleConfirmKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm?.();
    }
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
  Overlay is a sibling of dialog; clicking it cancels. We render plain DOM
  rather than bits-ui Dialog.Portal so tests can mount and observe focus
  state without a portal escape hatch.
-->
<div
  class="leave-overlay"
  data-testid="leave-channel-overlay"
  onclick={handleOverlayClick}
  onkeydown={handleDialogKeydown}
  role="presentation"
>
  <div
    bind:this={dialogEl}
    class="leave-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={descId}
    data-testid="leave-channel-dialog"
    onclick={handleContentClick}
    onkeydown={handleDialogKeydown}
    tabindex="-1"
  >
    <div class="leave-header">
      <h2 id={titleId} class="leave-title" data-testid="leave-channel-title">
        Leave #{channel?.name ?? ''}?
      </h2>
    </div>

    <div id={descId} class="leave-body" data-testid="leave-channel-body">
      <p class="leave-line">
        You've sent {messageCount} message{messageCount === 1 ? '' : 's'} in this channel.
      </p>

      {#if isStarred}
        <p class="leave-line leave-line-warn" data-testid="leave-channel-starred-warning">
          Leaving will remove this channel from your starred list.
        </p>
      {/if}

      {#if hasPinnedMessages}
        <p class="leave-line leave-line-warn" data-testid="leave-channel-pinned-warning">
          You have pinned messages here that will remain accessible to other members.
        </p>
      {/if}
    </div>

    <div class="leave-footer">
      <button
        bind:this={cancelBtn}
        type="button"
        class="leave-btn secondary"
        onclick={() => onCancel?.()}
        data-testid="leave-channel-cancel"
      >Cancel</button>
      <button
        type="button"
        class="leave-btn danger"
        onclick={() => onConfirm?.()}
        onkeydown={handleConfirmKeydown}
        data-testid="leave-channel-confirm"
      >Leave channel</button>
    </div>
  </div>
</div>

<style>
  .leave-overlay {
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

  .leave-modal {
    width: 420px;
    max-width: calc(100vw - 32px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.04);
    animation: modalIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    overflow: hidden;
    outline: none;
  }

  .leave-header {
    padding: 20px 24px 12px;
  }

  .leave-title {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.3px;
    margin: 0;
    color: var(--text-primary);
  }

  .leave-body {
    padding: 0 24px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .leave-line {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  .leave-line-warn {
    color: var(--text-secondary);
  }

  .leave-footer {
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .leave-btn {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
    border: none;
    font-family: inherit;
  }

  .leave-btn.secondary {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .leave-btn.secondary:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .leave-btn.danger {
    background: linear-gradient(135deg, #dc2626, #ef4444);
    color: white;
    box-shadow: 0 2px 8px rgba(239, 68, 68, 0.3);
  }

  .leave-btn.danger:hover {
    filter: brightness(1.1);
    box-shadow: 0 2px 12px rgba(239, 68, 68, 0.4);
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
