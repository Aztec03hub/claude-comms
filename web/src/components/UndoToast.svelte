<!--
  @component UndoToast
  @description Lower-right corner toast that gives the user a short window
    (default 15 seconds) to undo a destructive but reversible action — leaving
    or archiving a channel. The caller (Sidebar) receives a `{ done, cancel }`
    envelope from the store's leaveChannel / archiveChannel method and feeds
    the cancel hook into onUndo. Calling onExpire signals the caller that the
    action has committed (the user did not undo within the window, or actively
    dismissed the toast).

    Visual style is intentionally NEUTRAL (not red): this is an informational
    affordance, not a warning. A thin progress bar at the bottom drains from
    100 percent to 0 percent over timeoutMs. With prefers-reduced-motion, the
    bar snaps rather than animating, but the countdown timer still fires.

    Behavior contract (Agent-P-Wire in Batch 2 consumes — do NOT rename props):
      - Mount starts the countdown.
      - Undo click within window: onUndo, then dismiss (cleanup timers).
      - Timeout reaches zero: onExpire, then dismiss.
      - X dismiss: behaves like expire (onExpire) — design rationale is that
        dismissing without clicking Undo means the user accepted the action.

  @prop {string} message - Toast message (e.g. "Left #general" or "Archived #design").
  @prop {string} [undoLabel] - Label on the undo button. Defaults to "Undo".
  @prop {number} [timeoutMs] - Total countdown duration in ms. Defaults to 15000
    (15s) to match the store's `{ done, cancel }` envelope window.
  @prop {Function} [onUndo] - Invoked when the user clicks Undo within the window.
  @prop {Function} [onExpire] - Invoked when the countdown expires OR the user
    dismisses without undoing — caller treats both as "action committed."
-->
<script>
  let {
    message,
    undoLabel = 'Undo',
    timeoutMs = 15000,
    onUndo,
    onExpire,
  } = $props();

  // Internal lifecycle state. `exiting` triggers the CSS exit animation;
  // `dismissed` prevents double-fire of onUndo / onExpire if the user clicks
  // Undo and X in rapid succession (or the timer fires during the exit
  // animation).
  let exiting = $state(false);
  let dismissed = $state(false);

  // The countdown timer + the visual progress percentage (100 → 0).
  // We keep them as plain (non-rune) module-level vars where possible to
  // avoid unnecessary reactivity, but `reduceMotion` and `progress` need to
  // be reactive for the inline-style binding.
  let expireTimer = null;

  // Detect prefers-reduced-motion. The CSS keyframe handles the smooth case;
  // when the user prefers reduced motion we snap the bar to its current
  // value via inline style and skip the CSS animation. Mirrors the
  // accessibility patterns used elsewhere in the codebase. Read once at
  // module-init (top-level) so the value is already correct on first render
  // — avoids a transient "animated then snapped" flash in $effect.
  let reduceMotion = $state(detectReduceMotion());

  function detectReduceMotion() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function clearTimers() {
    if (expireTimer !== null) {
      clearTimeout(expireTimer);
      expireTimer = null;
    }
  }

  function finalize(callback) {
    // Idempotent — called by undo / expire / X-dismiss handlers. Guarded so
    // a late timer firing during the exit animation cannot double-invoke.
    if (dismissed) return;
    dismissed = true;
    clearTimers();
    exiting = true;
    // Fire the callback synchronously so the caller can react immediately
    // (e.g. close the action, restore the channel, etc). The visual exit
    // animation runs in parallel; the parent owns unmount.
    callback?.();
  }

  function handleUndo() {
    finalize(onUndo);
  }

  function handleDismiss(e) {
    // Stop propagation so a future wrapping click handler cannot also fire.
    // (Mirrors the NotificationToast close-X pattern.)
    e?.stopPropagation?.();
    // Dismiss without undoing means the user accepted the action — caller
    // treats this identically to a natural expire so the action commits.
    finalize(onExpire);
  }

  $effect(() => {
    // Schedule the expiration. We use a single setTimeout rather than a
    // requestAnimationFrame loop because we only need to know WHEN to fire
    // onExpire. The visual countdown is handled by a pure CSS animation
    // bound to timeoutMs (no per-frame JS work). This effect intentionally
    // performs a side effect (timer registration) that cannot be derived;
    // the autofixer's "$effect should be $derived" suggestion does not apply.
    expireTimer = setTimeout(() => {
      finalize(onExpire);
    }, timeoutMs);

    return () => {
      clearTimers();
    };
  });
</script>

<div
  class="undo-toast"
  class:exiting
  data-testid="undo-toast"
  role="status"
  aria-live="polite"
>
  <span class="undo-message" data-testid="undo-toast-message">{message}</span>

  <button
    type="button"
    class="undo-action"
    data-testid="undo-toast-undo"
    onclick={handleUndo}
  >
    {undoLabel}
  </button>

  <button
    type="button"
    class="undo-dismiss"
    data-testid="undo-toast-dismiss"
    title="Dismiss"
    aria-label="Dismiss"
    onclick={handleDismiss}
  >&times;</button>

  <span
    class="undo-progress"
    class:reduced={reduceMotion}
    data-testid="undo-toast-progress"
    aria-hidden="true"
    style="--undo-duration: {timeoutMs}ms"
  ></span>
</div>

<style>
  .undo-toast {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px 14px 16px;
    /* Neutral surface — informational, not destructive. The
       NotificationToast uses an ember accent for new messages; here we keep
       the border subtle so the undo affordance reads as a passive prompt. */
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03);
    min-width: 280px;
    max-width: 420px;
    animation: undoToastIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
    backdrop-filter: blur(12px);
    color: var(--text-primary);
    font: inherit;
    overflow: hidden;
  }

  .undo-toast.exiting {
    animation: undoToastOut 0.25s ease both;
  }

  .undo-message {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text-primary);
    line-height: 1.4;
    /* Allow long channel names to wrap rather than overflow the toast. */
    overflow-wrap: anywhere;
  }

  .undo-action {
    flex-shrink: 0;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-surface);
    color: var(--ember-300);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
  }

  .undo-action:hover {
    background: var(--bg-base);
    color: var(--ember-200);
    border-color: var(--ember-400);
  }

  .undo-action:focus-visible {
    outline: 2px solid var(--ember-400);
    outline-offset: 2px;
  }

  .undo-dismiss {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    transition: var(--transition-fast);
  }

  .undo-dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  .undo-dismiss:focus-visible {
    outline: 2px solid var(--ember-400);
    outline-offset: 1px;
  }

  .undo-progress {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 2px;
    width: 100%;
    background: linear-gradient(90deg, var(--ember-400), var(--ember-500));
    opacity: 0.6;
    transform-origin: left center;
    /* Use transform: scaleX rather than width so the GPU compositor can
       handle the animation without per-frame layout cost. */
    animation: undoToastProgress var(--undo-duration) linear both;
  }

  /* prefers-reduced-motion path: snap the bar to its fixed display value
     and skip the animation. We honor the user's setting at the OS level
     while keeping the countdown timer logic intact (handled in JS). */
  .undo-progress.reduced {
    animation: none;
    transform: scaleX(1);
    opacity: 0.4;
  }

  @media (prefers-reduced-motion: reduce) {
    .undo-toast {
      animation: none;
    }

    .undo-toast.exiting {
      animation: none;
    }

    .undo-progress {
      animation: none;
      transform: scaleX(1);
      opacity: 0.4;
    }
  }

  @keyframes undoToastIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes undoToastOut {
    from {
      opacity: 1;
      transform: translateY(0);
    }
    to {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  @keyframes undoToastProgress {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }
</style>
