<!--
  @component NotificationToast
  @description Fixed-position toast notification that slides in from the top-right, showing a sender avatar, name, channel, and message preview. Auto-dismisses via a progress bar animation, can be manually closed, and the entire card surface is a button (UX G-13): clicking routes to the source channel via the parent's onActivate callback. A "pill" variant (UX G-14) renders a compact "+N new in #channel" when many toasts coalesce.
  @prop {string} id - Unique identifier for this toast notification.
  @prop {object} sender - Sender object with name and key fields.
  @prop {string} channel - The channel name where the message was sent.
  @prop {string} text - The message body text to preview.
  @prop {string} [messageId] - Optional source message id; when present, onActivate may scroll to it.
  @prop {boolean} [pill] - Render the compact "+N new in #channel" pill variant instead of the full card.
  @prop {Function} [onActivate] - Callback invoked when the user clicks the card surface (UX G-13). Receives `{ channel, messageId }`.
  @prop {Function} onDismiss - Callback invoked when the toast is dismissed.
-->
<script>
  import { getParticipantColor, getInitials } from '../lib/utils.js';

  let { id, sender, channel, text, messageId, pill = false, onActivate, onDismiss } = $props();

  let color = $derived(getParticipantColor(sender?.key ?? channel));
  let exiting = $state(false);

  function dismiss(e) {
    // Stop the click from bubbling to the card surface — otherwise the
    // close-X would also trigger the card's onActivate routing handler.
    e?.stopPropagation?.();
    exiting = true;
    setTimeout(onDismiss, 300);
  }

  function activate() {
    // Card-wide click handler (UX G-13). The parent decides what
    // "activate" means — typically switchChannel + (optionally)
    // goToMessage. We pass both fields so the parent stays declarative.
    onActivate?.({ channel, messageId });
  }
</script>

{#if pill}
  <!--
    Coalesced pill variant (UX G-14): rendered when 5+ toasts from the
    same channel collapse to a single line. Same button-shell semantics
    as the full card so clicking still routes to the channel.
  -->
  <button
    type="button"
    class="toast toast-pill"
    class:exiting
    data-testid="toast"
    data-pill="true"
    data-channel={channel}
    onclick={activate}
    aria-label={`${text} — open #${channel}`}
  >
    <span class="pill-hash">#</span>
    <span class="pill-text">{text}</span>
    <span
      role="button"
      tabindex="0"
      class="toast-close pill-close"
      data-testid="toast-close"
      title="Dismiss"
      aria-label="Dismiss notification"
      onclick={dismiss}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dismiss(e);
        }
      }}
    >&times;</span>
    <span class="toast-progress" aria-hidden="true"></span>
  </button>
{:else}
  <button
    type="button"
    class="toast"
    class:exiting
    data-testid="toast"
    data-channel={channel}
    onclick={activate}
    aria-label={`Message from ${sender?.name ?? 'unknown'} in #${channel} — open channel`}
  >
    <span class="toast-avatar" style="background: {color.gradient}">{getInitials(sender?.name ?? '?')}</span>
    <span class="toast-content">
      <span class="toast-header">
        <span class="toast-sender">{sender?.name ?? 'unknown'}</span>
        <span class="toast-channel">in #{channel}</span>
      </span>
      <span class="toast-text">{text}</span>
    </span>
    <!--
      The close-X is a nested interactive control. Native HTML forbids
      <button> inside <button>, so we render it as a role="button" span
      with an explicit Enter/Space handler. stopPropagation prevents the
      outer card's onclick from firing when the user dismisses.
    -->
    <span
      role="button"
      tabindex="0"
      class="toast-close"
      data-testid="toast-close"
      title="Dismiss"
      aria-label="Dismiss notification"
      onclick={dismiss}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dismiss(e);
        }
      }}
    >&times;</span>
    <span class="toast-progress" aria-hidden="true"></span>
  </button>
{/if}

<style>
  .toast {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: var(--z-toast);
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
    /* UX G-13: full-card click target */
    cursor: pointer;
    color: inherit;
    font: inherit;
    text-align: left;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .toast:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05);
  }

  .toast:focus-visible {
    outline: 2px solid var(--ember-400);
    outline-offset: 2px;
  }

  .toast.exiting { animation: toastOut 0.3s ease both; }

  /* Coalesced pill variant — same shell, slimmer body. */
  .toast.toast-pill {
    min-width: 220px;
    max-width: 320px;
    padding: 10px 14px;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-secondary);
  }

  .pill-hash {
    font-size: 13px;
    color: var(--text-faint);
    font-weight: 700;
    flex-shrink: 0;
  }

  .pill-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-primary);
    font-weight: 600;
  }

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

  .toast-content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
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
    display: block;
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
  .toast-close:focus-visible { outline: 2px solid var(--ember-400); outline-offset: 1px; }

  .toast-progress {
    position: absolute;
    bottom: 0;
    left: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--ember-400), var(--ember-500));
    border-radius: 0 0 0 var(--radius);
    animation: toastProgress 5s linear both;
    opacity: 0.6;
  }

  @keyframes toastProgress {
    from { width: 100%; }
    to { width: 0%; }
  }
</style>
