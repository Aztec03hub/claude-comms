<script>
  import { getParticipantColor, getInitials } from '../lib/utils.js';

  let { id, sender, channel, text, onDismiss } = $props();

  let color = $derived(getParticipantColor(sender.key));
  let exiting = $state(false);

  function dismiss() {
    exiting = true;
    setTimeout(onDismiss, 300);
  }
</script>

<div class="toast" class:exiting data-testid="toast" role="alert" aria-live="polite">
  <div class="toast-avatar" style="background: {color.gradient}">{getInitials(sender.name)}</div>
  <div class="toast-content">
    <div class="toast-header">
      <span class="toast-sender">{sender.name}</span>
      <span class="toast-channel">in #{channel}</span>
    </div>
    <div class="toast-text">{text}</div>
  </div>
  <button class="toast-close" onclick={dismiss} data-testid="toast-close" title="Dismiss" aria-label="Dismiss notification">&times;</button>
</div>

<style>
  .toast {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 100;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-left: 3px solid var(--ember-400);
    border-radius: var(--radius);
    box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03);
    min-width: 320px;
    max-width: 400px;
    animation: toastIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
    backdrop-filter: blur(12px);
  }

  .toast.exiting { animation: toastOut 0.3s ease both; }

  .toast-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    color: #0a0a0c;
  }

  .toast-content { flex: 1; min-width: 0; }
  .toast-header { display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px; }
  .toast-sender { font-size: 12px; font-weight: 700; color: var(--ember-300); }
  .toast-channel { font-size: 11px; color: var(--text-faint); }

  .toast-text {
    font-size: 12.5px;
    color: var(--text-secondary);
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .toast-close {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    flex-shrink: 0;
    font-size: 14px;
  }

  .toast-close:hover { color: var(--text-primary); background: var(--bg-surface); }
</style>
