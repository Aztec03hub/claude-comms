<!--
  @component RemoteUpdateBanner
  @description Banner shown when a remote collaborator updates an artifact the
    current user is editing, per plan §1 "Real-time panel refresh" and
    R4-8 / R5-4 (focus + state preservation).

  Visual spec:
    - 48px tall strip, absolutely positioned at top of the panel detail area,
      full width. Background `var(--bg-elevated)`, `border-left: 3px solid
      var(--ember-500)`.
    - Contents (left → right):
        [AlertCircle] "{senderName} updated this artifact to v{N}"
        [View changes] [Keep editing (theirs will be overwritten)]
        [Discard my edit]  ... [X]
    - Slide-in from top, 200ms ease-out; disabled under
      `@media (prefers-reduced-motion: reduce)`.
    - 30s auto-dismiss timer; manual X dismiss fires the same `onDismiss` path.

  Tab order (the outer <section> is focusable via tabindex=-1 so the orchestrator
  can programmatically move focus into the banner after capturing
  `preBannerState`):
    banner → View changes → Keep editing → Discard → X → (back to textarea).

  @prop {boolean}  visible       - Whether the banner should be shown.
  @prop {string}   senderName    - Name of the collaborator who pushed the update.
  @prop {number}   newVersion    - New version number available on the server.
  @prop {Function} [onViewChanges]  - Called when "View changes" is clicked.
  @prop {Function} [onKeepEditing]  - Called when "Keep editing" is clicked.
  @prop {Function} [onDiscardEdit]  - Called when "Discard my edit" is clicked.
  @prop {Function} [onDismiss]      - Called when the banner is dismissed
                                       (X click or 30s auto-dismiss).
-->
<script>
  import { AlertCircle, X } from 'lucide-svelte';

  let {
    visible = false,
    senderName = '',
    newVersion = 0,
    onViewChanges,
    onKeepEditing,
    onDiscardEdit,
    onDismiss,
  } = $props();

  // Auto-dismiss after 30s when visible transitions to true. The effect's
  // cleanup clears the timer on hide / unmount, so rapid visible-toggle
  // sequences can't leave orphan timers behind.
  $effect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      onDismiss?.();
    }, 30_000);
    return () => clearTimeout(timer);
  });

  /**
   * Esc on any focused control inside the banner dismisses it.
   * `stopPropagation()` so the App-global Esc handler does not also fire
   * (plan §4 R4-3 precedence). The outer <section> is `role="status"` — a
   * non-interactive role — so the handler is attached to the interactive
   * buttons (which are the only tab-stops) rather than the section itself.
   * @param {KeyboardEvent} e
   */
  function handleInteractiveKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onDismiss?.();
    }
  }
</script>

{#if visible}
  <section
    class="remote-update-banner"
    role="status"
    aria-live="assertive"
    tabindex="-1"
    data-testid="remote-update-banner"
  >
    <span class="banner-icon" aria-hidden="true">
      <AlertCircle size={18} strokeWidth={2} />
    </span>
    <span class="banner-text">
      {senderName} updated this artifact to v{newVersion}
    </span>

    <div class="banner-actions">
      <button
        type="button"
        class="banner-btn primary"
        data-testid="remote-banner-view-changes"
        onclick={() => onViewChanges?.()}
        onkeydown={handleInteractiveKeydown}
      >
        View changes
      </button>
      <button
        type="button"
        class="banner-btn secondary"
        data-testid="remote-banner-keep-editing"
        onclick={() => onKeepEditing?.()}
        onkeydown={handleInteractiveKeydown}
      >
        Keep editing (theirs will be overwritten)
      </button>
      <button
        type="button"
        class="banner-btn destructive"
        data-testid="remote-banner-discard"
        onclick={() => onDiscardEdit?.()}
        onkeydown={handleInteractiveKeydown}
      >
        Discard my edit
      </button>
    </div>

    <button
      type="button"
      class="banner-close-btn"
      data-testid="remote-banner-dismiss"
      aria-label="Dismiss remote-update notice"
      onclick={() => onDismiss?.()}
      onkeydown={handleInteractiveKeydown}
    >
      <X size={16} strokeWidth={2} />
    </button>
  </section>
{/if}

<style>
  .remote-update-banner {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 48px;
    padding: 0 12px 0 13px; /* 13px left so icon aligns past the 3px border */
    background: var(--bg-elevated);
    border-left: 3px solid var(--ember-500);
    border-bottom: 1px solid var(--border);
    animation: banner-slide-in 200ms ease-out both;
    z-index: 15;
  }

  .remote-update-banner:focus {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--ember-500);
  }

  @keyframes banner-slide-in {
    from {
      transform: translateY(-100%);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .remote-update-banner {
      animation: none;
    }
  }

  .banner-icon {
    flex-shrink: 0;
    color: var(--ember-400);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .banner-text {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex-shrink: 1;
  }

  .banner-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .banner-btn {
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 6px 10px;
    border-radius: var(--radius-xs);
    cursor: pointer;
    transition: var(--transition-fast);
    white-space: nowrap;
  }

  .banner-btn.primary {
    background: var(--ember-500);
    color: #0c0a09;
    border: 1px solid var(--ember-500);
  }

  .banner-btn.primary:hover {
    background: var(--ember-400);
    border-color: var(--ember-400);
  }

  .banner-btn.secondary {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .banner-btn.secondary:hover {
    border-color: var(--ember-700);
    color: var(--text-primary);
  }

  .banner-btn.destructive {
    background: rgba(248, 81, 73, 0.08);
    color: #f87171;
    border: 1px solid rgba(248, 81, 73, 0.4);
  }

  .banner-btn.destructive:hover {
    background: rgba(248, 81, 73, 0.18);
    color: #fca5a5;
  }

  .banner-btn:focus-visible {
    outline: 2px solid var(--ember-500);
    outline-offset: 2px;
  }

  .banner-close-btn {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    flex-shrink: 0;
  }

  .banner-close-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .banner-close-btn:focus-visible {
    outline: 2px solid var(--ember-500);
    outline-offset: 2px;
  }
</style>
