<!--
  KeyboardShortcutsHelp.svelte — v0.4.0 Step 2.17.

  Modal overlay listing every keyboard binding registered with the central
  keyboard registry. Triggered by the ``?`` key (when no input is focused)
  via the registry's binding in App.svelte. Closes on Escape, on a click
  outside the panel, or on the X button.

  Props (PUBLIC CONTRACT):
    @prop {boolean} open    — when true, modal renders. Two-way bindable.
    @prop {Array}   entries — array of { combo, label } rows to render.
                              App.svelte composes this from the registry's
                              ``descriptions`` map so the help reflects the
                              live registrations.
    @prop {Function} onClose — fired when the modal should close.
-->
<script>
  import { X, Keyboard } from 'lucide-svelte';
  import { topLayer } from '../lib/top-layer.svelte.js';

  let {
    open = $bindable(false),
    entries = [],
    onClose,
  } = $props();

  /** @type {HTMLDivElement | undefined} */
  let dialogEl = $state();
  /** @type {HTMLElement | null} */
  let previouslyFocused = null;

  // Stable ids so aria-labelledby has something to bind to. Suffix with a
  // random tag in case two help overlays ever live in the same document
  // during a mount/unmount cycle in tests.
  const idSuffix = Math.random().toString(36).slice(2, 9);
  const titleId = `keyboard-shortcuts-title-${idSuffix}`;
  const descId = `keyboard-shortcuts-desc-${idSuffix}`;

  // Lifecycle: capture previously-focused element on open, focus the
  // dialog, restore focus on close.
  $effect(() => {
    if (!open) return;
    previouslyFocused = /** @type {HTMLElement | null} */ (
      typeof document !== 'undefined' ? document.activeElement : null
    );
    queueMicrotask(() => {
      if (dialogEl) {
        const firstFocusable = /** @type {HTMLElement | null} */ (
          dialogEl.querySelector(
            'button:not([disabled]):not([tabindex="-1"]), [href]',
          )
        );
        (firstFocusable ?? dialogEl).focus();
      }
    });
    return () => {
      if (
        previouslyFocused &&
        typeof previouslyFocused.focus === 'function' &&
        document.body.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  });

  function close() {
    open = false;
    onClose?.();
  }

  function handleBackdropClick(event) {
    // Native <dialog> backdrop click (target === currentTarget); content
    // clicks land on inner nodes.
    if (event.target === event.currentTarget) {
      close();
    }
  }
</script>

{#if open}
  <!--
    Overlay overhaul, Phase 2: native <dialog> via use:topLayer (showModal,
    ::backdrop, inert) - no position:fixed, no z-index. Escape is owned by
    the action (onClose -> close); the component keeps initial-focus +
    restore management and the backdrop-click handler.
  -->
  <dialog
    class="kbd-help-backdrop"
    data-testid="kbd-help-backdrop"
    use:topLayer={{ modal: true, trapInitialFocus: false, restoreFocus: false, onClose: close }}
    onclick={handleBackdropClick}
  >
    <div
      bind:this={dialogEl}
      class="kbd-help-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabindex="-1"
      data-testid="kbd-help-dialog"
    >
      <header class="kbd-help-header">
        <span class="kbd-help-icon" aria-hidden="true">
          <Keyboard size={18} strokeWidth={2} />
        </span>
        <h2 id={titleId} class="kbd-help-title">Keyboard shortcuts</h2>
        <button
          type="button"
          class="kbd-help-close"
          aria-label="Close keyboard shortcuts"
          data-testid="kbd-help-close"
          onclick={close}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </header>

      <p id={descId} class="kbd-help-desc">
        Power-user keys for navigating channels and managing the workspace.
      </p>

      {#if entries.length === 0}
        <p class="kbd-help-empty" data-testid="kbd-help-empty">
          No shortcuts registered yet.
        </p>
      {:else}
        <ul class="kbd-help-list" data-testid="kbd-help-list">
          {#each entries as entry (entry.combo)}
            <li class="kbd-help-row" data-testid="kbd-help-row">
              <span class="kbd-help-label">{entry.label}</span>
              <kbd class="kbd-help-combo" data-testid="kbd-help-combo">{entry.combo}</kbd>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </dialog>
{/if}

<style>
  .kbd-help-backdrop {
    margin: auto;
    padding: 0;
    border: none;
    background: transparent;
    max-width: 100vw;
    max-height: 100vh;
    overflow: visible;
  }

  .kbd-help-backdrop::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }

  .kbd-help-dialog {
    background: var(--bg-elevated, var(--surface-elevated, #1f1c19));
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
    width: min(480px, 100%);
    max-height: 80vh;
    overflow-y: auto;
    padding: 20px;
    outline: none;
  }

  .kbd-help-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }

  .kbd-help-icon {
    color: var(--ember-300, #fbbf24);
    display: flex;
    align-items: center;
  }

  .kbd-help-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.2px;
    margin: 0;
    flex: 1;
    color: var(--text-primary, #f4f1ec);
  }

  .kbd-help-close {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .kbd-help-close:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .kbd-help-desc {
    font-size: 12.5px;
    color: var(--text-muted, #a8a098);
    margin: 0 0 14px;
    line-height: 1.5;
  }

  .kbd-help-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .kbd-help-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--text-secondary, #d3cfc7);
  }

  .kbd-help-row:nth-child(odd) {
    background: var(--bg-surface, rgba(255, 255, 255, 0.025));
  }

  .kbd-help-label {
    flex: 1;
    min-width: 0;
  }

  .kbd-help-combo {
    font-family: 'SF Mono', 'JetBrains Mono', Consolas, monospace;
    font-size: 11.5px;
    background: var(--bg-base, #14110f);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
    color: var(--ember-200, #fde68a);
    white-space: nowrap;
  }

  .kbd-help-empty {
    font-size: 12.5px;
    color: var(--text-faint);
    margin: 0;
    text-align: center;
    padding: 16px;
  }
</style>
