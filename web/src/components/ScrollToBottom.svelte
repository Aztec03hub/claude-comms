<!--
  @component ScrollToBottom
  @description Floating circular button that appears when the user scrolls up in the chat view. Shows a chevron-down icon and an optional unread message count badge. Clicking it smooth-scrolls to the bottom of the message list.
  @prop {number} count - Number of unread messages below the current scroll position (default: 0).
  @prop {Function} onClick - Callback invoked when the button is clicked to scroll down.
-->
<script>
  import { ChevronDown } from 'lucide-svelte';

  let { count = 0, onClick } = $props();
</script>

<button class="scroll-bottom" title="Scroll to bottom" aria-label="Scroll to bottom{count > 0 ? `, ${count} unread messages` : ''}" onclick={onClick} data-testid="scroll-to-bottom">
  <span class="scroll-icon">
    <ChevronDown size={16} strokeWidth={2.5} />
  </span>
  {#if count > 0}
    <span class="badge">{count}</span>
  {/if}
</button>

<style>
  .scroll-bottom {
    position: absolute;
    bottom: 90px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.03);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    color: var(--text-muted);
    animation: scrollBtnIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .scroll-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease;
  }

  .scroll-bottom:hover {
    background: var(--bg-surface);
    border-color: var(--ember-700);
    color: var(--ember-300);
    box-shadow: 0 6px 24px rgba(0,0,0,0.5), 0 0 12px rgba(245,158,11,0.12);
    transform: translateX(-50%) translateY(-3px);
  }

  .scroll-bottom:hover .scroll-icon {
    transform: translateY(1px);
  }

  .scroll-bottom:active {
    transform: translateX(-50%) translateY(0);
    transition-duration: 0.08s;
  }

  .badge {
    position: absolute;
    top: -7px;
    right: -7px;
    font-size: 9px;
    font-weight: 700;
    color: #0a0a0c;
    background: linear-gradient(135deg, var(--ember-500), var(--ember-400));
    border-radius: 10px;
    padding: 1px 6px;
    min-width: 16px;
    text-align: center;
    box-shadow: 0 0 8px rgba(245,158,11,0.3);
    animation: badgeBounce 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @keyframes scrollBtnIn {
    from { opacity: 0; transform: translateX(-50%) translateY(12px) scale(0.8); }
    to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
  }
</style>
