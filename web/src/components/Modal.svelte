<!--
  @component Modal (Overlay overhaul, Phase 1, design §C)
  @description Thin wrapper around the `topLayer` action for MODAL dialogs.
  Renders a real `<dialog>` driven by `showModal()`, which the browser
  promotes into the native top layer with a free native `::backdrop`, a
  built-in focus-trap, and an inert background - no portal, no manual
  z-index, no second focus-trap system. Esc fires the native `cancel`
  event which the action forwards to `onClose`.

  Phase 1 ships this wrapper but migrates only StatusEditor (a Popover);
  the manual-portal / raw modals (LeaveChannelDialog, ForwardPicker,
  KeyboardShortcutsHelp, ...) move onto `<Modal>` in Phase 2.

  Extra attributes (`class`, `data-testid`, `aria-label`, ...) are spread
  onto the `<dialog>`.

  @prop {string} [title]
  @prop {() => void} [onClose]
  @prop {import('svelte').Snippet} [children]
-->
<script>
  import { topLayer } from '../lib/top-layer.svelte.js';

  /**
   * @type {{
   *   title?: string,
   *   onClose?: () => void,
   *   children?: import('svelte').Snippet,
   *   [key: string]: unknown,
   * }}
   */
  let { title = '', onClose, children, ...rest } = $props();
</script>

<dialog class="tl-modal" use:topLayer={{ modal: true, onClose }} {...rest}>
  {#if title}
    <header class="tl-modal-header">
      <h2 class="tl-modal-title">{title}</h2>
      <button
        type="button"
        class="tl-modal-close"
        onclick={() => onClose?.()}
        aria-label="Close"
      >&times;</button>
    </header>
  {/if}
  <div class="tl-modal-body">
    {@render children?.()}
  </div>
</dialog>

<style>
  .tl-modal {
    margin: auto;
    max-width: min(92vw, 560px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  }
  .tl-modal::backdrop {
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
  }
  .tl-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .tl-modal-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .tl-modal-close {
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    border-radius: var(--radius-xs);
    transition: var(--transition-fast);
  }
  .tl-modal-close:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
  .tl-modal-body {
    padding: 16px;
  }
</style>
