<script>
  import { RefreshCw, X } from 'lucide-svelte';

  let { connected = false, onlineCount = 0, error = null } = $props();
  let retryCount = $state(0);
  let retryTimer = $state(null);
  let retrySeconds = $state(0);
  let dismissed = $state(false);
  let autoHide = $state(false);
  let autoHideTimer = $state(null);
  let prevConnected = $state(undefined);

  // Reset dismissed state when connection status changes; auto-hide connected banner
  $effect(() => {
    const currentConnected = connected;
    const currentError = error;

    if (prevConnected !== undefined && currentConnected !== prevConnected) {
      dismissed = false;
      autoHide = false;
    }
    prevConnected = currentConnected;

    // Auto-hide connected banner after 3 seconds
    if (currentConnected && !currentError) {
      if (autoHideTimer) clearTimeout(autoHideTimer);
      autoHide = false;
      autoHideTimer = setTimeout(() => {
        autoHide = true;
        autoHideTimer = null;
      }, 3000);
    }
  });

  // Track reconnection attempts when in error state
  $effect(() => {
    if (error && !connected) {
      retryCount++;
      retrySeconds = 5;
      retryTimer = setInterval(() => {
        retrySeconds--;
        if (retrySeconds <= 0) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }, 1000);
    } else if (connected) {
      retryCount = 0;
      retrySeconds = 0;
      if (retryTimer) clearInterval(retryTimer);
    }
  });

  function dismiss() {
    dismissed = true;
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  }
</script>

{#if dismissed}
  <!-- Banner dismissed, show nothing -->
{:else if connected && !autoHide}
  <div class="connection-banner connected" data-testid="connection-status" role="status" aria-live="polite">
    <div class="connection-dot" aria-hidden="true"></div>
    Connected &mdash; {onlineCount} participant{onlineCount !== 1 ? 's' : ''} online
  </div>
{:else if !connected && error}
  <div class="connection-banner error" data-testid="connection-status" role="alert" aria-live="assertive">
    <div class="connection-dot error-dot" aria-hidden="true"></div>
    <span class="error-text">{error}</span>
    <span class="retry-info">
      {#if retrySeconds > 0}
        <RefreshCw size={10} strokeWidth={2} />
        Retrying in {retrySeconds}s
      {:else}
        <RefreshCw size={10} strokeWidth={2} class="retry-spin" />
        Reconnecting...
      {/if}
    </span>
    <button class="dismiss-btn" onclick={dismiss} aria-label="Dismiss">
      <X size={12} strokeWidth={2} />
    </button>
  </div>
{:else if !connected && !error}
  <div class="connection-banner connecting" data-testid="connection-status" role="status" aria-live="polite">
    <div class="connection-dot connecting-dot" aria-hidden="true"></div>
    <span class="connecting-text">Establishing secure connection</span>
    <span class="connecting-dots" aria-hidden="true">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </span>
    <button class="dismiss-btn" onclick={dismiss} aria-label="Dismiss">
      <X size={12} strokeWidth={2} />
    </button>
  </div>
{/if}

<style>
  .connection-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px 16px;
    font-size: 11.5px;
    font-weight: 500;
    position: relative;
    z-index: 2;
    transition: all 0.3s ease;
  }

  .connection-banner.connected {
    background: linear-gradient(90deg, rgba(5,150,105,0.06), rgba(5,150,105,0.03));
    border-bottom: 1px solid rgba(5,150,105,0.1);
    color: #34d399;
    padding: 4px 16px;
    font-size: 10.5px;
  }

  .connection-banner.error {
    background: linear-gradient(90deg, rgba(239,68,68,0.12), rgba(239,68,68,0.06));
    border-bottom: 1px solid rgba(239,68,68,0.2);
    color: #f87171;
    padding: 8px 16px;
  }

  .connection-banner.connecting {
    background: linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.08));
    border-bottom: 1px solid rgba(245,158,11,0.2);
    color: var(--ember-400);
    animation: connBannerPulse 2s ease-in-out infinite;
  }

  .connection-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #34d399;
    box-shadow: 0 0 6px rgba(52,211,153,0.4);
    animation: connPulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  .connection-dot.error-dot {
    background: #f87171;
    box-shadow: 0 0 6px rgba(248,113,113,0.4);
    animation: none;
  }

  .connection-dot.connecting-dot {
    background: var(--ember-400);
    box-shadow: 0 0 6px rgba(245,158,11,0.4);
    animation: connDotPulse 1.5s ease-in-out infinite;
  }

  .error-text {
    flex-shrink: 1;
    min-width: 0;
  }

  .retry-info {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    opacity: 0.7;
    margin-left: 4px;
    flex-shrink: 0;
  }

  .retry-info :global(.retry-spin) {
    animation: spin 1s linear infinite;
  }

  .connecting-text {
    opacity: 0.9;
  }

  .connecting-dots {
    display: inline-flex;
    gap: 3px;
    margin-left: 2px;
  }

  .connecting-dots .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--ember-400);
    animation: connDotBounce 1.4s ease-in-out infinite;
  }

  .connecting-dots .dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .connecting-dots .dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes connPulse {
    0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 6px rgba(52,211,153,0.4); }
    50% { transform: scale(1.2); opacity: 0.8; box-shadow: 0 0 10px rgba(52,211,153,0.5); }
  }

  @keyframes connBannerPulse {
    0%, 100% { background: linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.08)); }
    50% { background: linear-gradient(90deg, rgba(245,158,11,0.16), rgba(245,158,11,0.1)); }
  }

  @keyframes connDotPulse {
    0%, 100% { transform: scale(1); opacity: 0.7; box-shadow: 0 0 6px rgba(245,158,11,0.4); }
    50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 12px rgba(245,158,11,0.6); }
  }

  @keyframes connDotBounce {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.6); }
    40% { opacity: 1; transform: scale(1); }
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .dismiss-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: inherit;
    opacity: 0.5;
    cursor: pointer;
    padding: 2px;
    margin-left: 4px;
    border-radius: 3px;
    transition: opacity 0.15s ease, background 0.15s ease;
    flex-shrink: 0;
  }

  .dismiss-btn:hover {
    opacity: 1;
    background: rgba(255,255,255,0.1);
  }
</style>
