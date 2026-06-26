<!--
  @component ConnectionStatus
  @description Displays a top-of-page banner showing MQTT connection state: connected (with participant count, auto-hides after 3s), connecting (with animated dots), or error (with retry countdown). Dismissable by the user. After 5 failed reconnect attempts the banner shifts to an actionable "Cannot reach broker — [Retry now] [Reload page]" state (UX G-27).
  @prop {boolean} connected - Whether the MQTT connection is currently established.
  @prop {number} onlineCount - Number of participants currently online.
  @prop {string|null} error - Error message string when connection fails, or null.
  @prop {(() => void) | undefined} onRetry - Optional callback invoked when the user clicks "Retry now" after the failure threshold. Wire to `store.connect()` from the parent. If omitted, the button is rendered but is a no-op.
  @prop {number} failureThreshold - Number of failed reconnect attempts before switching to the actionable failure banner. Defaults to 5; exposed as a prop so tests can drive the transition deterministically.
-->
<script>
  import { untrack } from 'svelte';
  import { RefreshCw, X } from 'lucide-svelte';

  let {
    connected = false,
    onlineCount = 0,
    error = null,
    onRetry = undefined,
    failureThreshold = 5,
  } = $props();
  let retryCount = $state(0);
  let retryTimer = $state(null);
  let retrySeconds = $state(0);
  let dismissed = $state(false);
  let autoHide = $state(false);
  let autoHideTimer = $state(null);
  let prevConnected = $state(undefined);

  // UX G-27: once `retryCount` crosses `failureThreshold`, the banner stops
  // claiming it is "still reconnecting" and surfaces two explicit affordances
  // (Retry / Reload). We derive this rather than mutating extra state so the
  // computation stays tied to the same counter the existing error effect
  // increments on each failed attempt.
  let reconnectFailed = $derived(retryCount >= failureThreshold);

  // Reset dismissed state when connection status changes; auto-hide connected banner.
  // prevConnected is read inside untrack() to prevent circular dependency.
  $effect(() => {
    const currentConnected = connected;
    const currentError = error;

    const prev = untrack(() => prevConnected);
    if (prev !== undefined && currentConnected !== prev) {
      dismissed = false;
      autoHide = false;
    }
    prevConnected = currentConnected;

    // Auto-hide connected banner after 3 seconds
    let timer;
    if (currentConnected && !currentError) {
      const existingTimer = untrack(() => autoHideTimer);
      if (existingTimer) clearTimeout(existingTimer);
      autoHide = false;
      timer = setTimeout(() => {
        autoHide = true;
        autoHideTimer = null;
      }, 3000);
      autoHideTimer = timer;
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  });

  // Track reconnection attempts when in error state.
  // retryCount is read inside untrack() to prevent circular dependency.
  $effect(() => {
    let interval;
    if (error && !connected) {
      retryCount = untrack(() => retryCount) + 1;
      retrySeconds = 5;
      const existingTimer = untrack(() => retryTimer);
      if (existingTimer) clearInterval(existingTimer);
      interval = setInterval(() => {
        retrySeconds--;
        if (retrySeconds <= 0) {
          clearInterval(interval);
          retryTimer = null;
        }
      }, 1000);
      retryTimer = interval;
    } else if (connected) {
      retryCount = 0;
      retrySeconds = 0;
      const existingTimer = untrack(() => retryTimer);
      if (existingTimer) clearInterval(existingTimer);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  });

  function dismiss() {
    dismissed = true;
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  }

  // UX G-27: "Retry now" button handler. Calls the parent-supplied callback
  // (wired to `store.connect()` in App.svelte). The attempt counter is NOT
  // reset eagerly — if the retry fails we want to stay in the failure state.
  // Successful connection clears `retryCount` via the existing error effect
  // (the `else if (connected)` branch sets it back to 0).
  function handleRetry() {
    if (typeof onRetry === 'function') {
      onRetry();
    }
  }

  // UX G-27: "Reload page" button handler. `location.reload()` is wrapped so
  // tests can stub the location object. Guard against missing `location`
  // (jsdom-without-window edge cases).
  function handleReload() {
    if (typeof location !== 'undefined' && typeof location.reload === 'function') {
      location.reload();
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
  <div
    class="connection-banner error"
    class:failed={reconnectFailed}
    data-testid="connection-status"
    data-failed={reconnectFailed ? 'true' : 'false'}
    role={reconnectFailed ? 'status' : 'alert'}
    aria-live={reconnectFailed ? 'polite' : 'assertive'}
  >
    <div class="connection-dot error-dot" aria-hidden="true"></div>
    {#if reconnectFailed}
      <span class="error-text">Cannot reach broker</span>
      <span class="retry-actions">
        <button
          type="button"
          class="cta-btn"
          data-testid="connection-retry-btn"
          onclick={handleRetry}
          aria-label="Retry MQTT broker connection"
        >
          Retry now
        </button>
        <button
          type="button"
          class="cta-btn"
          data-testid="connection-reload-btn"
          onclick={handleReload}
          aria-label="Reload the page"
        >
          Reload page
        </button>
      </span>
    {:else}
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
    {/if}
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
    z-index: var(--z-banner);
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

  /* UX G-27: failure-state action buttons. Visual weight is higher than
     the dismiss button (these are the primary affordance), but still
     restrained to keep the banner from dominating the page. */
  .retry-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 6px;
    flex-shrink: 0;
  }

  .cta-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(239,68,68,0.16);
    border: 1px solid rgba(248,113,113,0.4);
    color: #fecaca;
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    line-height: 1.4;
  }

  .cta-btn:hover {
    background: rgba(239,68,68,0.28);
    border-color: rgba(248,113,113,0.6);
    color: #fff;
  }

  .cta-btn:focus-visible {
    outline: 2px solid rgba(248,113,113,0.8);
    outline-offset: 1px;
  }

  /* When the banner shifts to the failure variant the indeterminate
     animation would imply progress that isn't happening — drop it. */
  .connection-banner.error.failed {
    animation: none;
  }
</style>
