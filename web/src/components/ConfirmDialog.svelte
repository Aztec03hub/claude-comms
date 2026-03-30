<!--
  @component ConfirmDialog
  @description A reusable confirmation dialog with customizable title, message, and confirm/cancel actions. Supports a danger variant for destructive operations.
  @prop {string} title - Dialog heading text (default: 'Confirm').
  @prop {string} message - Body text describing the action to confirm (default: 'Are you sure?').
  @prop {string} confirmLabel - Label for the confirm button (default: 'Confirm').
  @prop {boolean} confirmDanger - When true, styles the confirm button as a red destructive action.
  @prop {Function} onConfirm - Callback invoked when the user clicks the confirm button.
  @prop {Function} onCancel - Callback invoked when the user cancels or dismisses the dialog.
-->
<script>
  import { Dialog } from "bits-ui";

  let { title = 'Confirm', message = 'Are you sure?', confirmLabel = 'Confirm', confirmDanger = false, onConfirm, onCancel } = $props();

  function handleOpenChange(open) {
    if (!open) onCancel();
  }
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="confirm-overlay" data-testid="confirm-dialog" />
    <Dialog.Content class="confirm-modal">
      <div class="confirm-header">
        <Dialog.Title class="confirm-title">{title}</Dialog.Title>
      </div>
      <div class="confirm-body">
        <p class="confirm-message">{message}</p>
      </div>
      <div class="confirm-footer">
        <button class="confirm-btn secondary" onclick={onCancel} data-testid="confirm-dialog-cancel">Cancel</button>
        <button
          class="confirm-btn"
          class:danger={confirmDanger}
          class:primary={!confirmDanger}
          onclick={onConfirm}
          data-testid="confirm-dialog-confirm"
        >{confirmLabel}</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global([data-dialog-overlay].confirm-overlay) {
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

  :global([data-dialog-content].confirm-modal) {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 201;
    width: 380px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
    animation: modalIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    overflow: hidden;
  }

  .confirm-header {
    padding: 20px 24px 12px;
  }

  :global(.confirm-title) {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }

  .confirm-body {
    padding: 0 24px 16px;
  }

  .confirm-message {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  .confirm-footer {
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-btn {
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition-fast);
    border: none;
    font-family: inherit;
  }

  .confirm-btn.secondary {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .confirm-btn.secondary:hover { background: var(--bg-elevated); color: var(--text-primary); }

  .confirm-btn.primary {
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    color: #0a0a0c;
    box-shadow: 0 2px 8px rgba(245,158,11,0.2);
  }

  .confirm-btn.primary:hover { filter: brightness(1.1); box-shadow: 0 2px 12px rgba(245,158,11,0.3); }

  .confirm-btn.danger {
    background: linear-gradient(135deg, #dc2626, #ef4444);
    color: white;
    box-shadow: 0 2px 8px rgba(239,68,68,0.3);
  }

  .confirm-btn.danger:hover { filter: brightness(1.1); box-shadow: 0 2px 12px rgba(239,68,68,0.4); }
</style>
