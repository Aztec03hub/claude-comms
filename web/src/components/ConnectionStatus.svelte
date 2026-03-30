<script>
  let { connected = false, onlineCount = 0, error = null } = $props();
</script>

{#if connected}
  <div class="connection-banner connected" data-testid="connection-status">
    <div class="connection-dot"></div>
    Connected &mdash; {onlineCount} agent{onlineCount !== 1 ? 's' : ''} online
  </div>
{:else if error}
  <div class="connection-banner error" data-testid="connection-status">
    <div class="connection-dot error-dot"></div>
    {error}
  </div>
{:else}
  <div class="connection-banner connecting" data-testid="connection-status">
    <div class="connection-dot connecting-dot"></div>
    Connecting...
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
  }

  .connection-banner.connected {
    background: linear-gradient(90deg, rgba(5,150,105,0.12), rgba(5,150,105,0.08));
    border-bottom: 1px solid rgba(5,150,105,0.2);
    color: #34d399;
  }

  .connection-banner.error {
    background: linear-gradient(90deg, rgba(239,68,68,0.12), rgba(239,68,68,0.08));
    border-bottom: 1px solid rgba(239,68,68,0.2);
    color: #f87171;
  }

  .connection-banner.connecting {
    background: linear-gradient(90deg, rgba(245,158,11,0.12), rgba(245,158,11,0.08));
    border-bottom: 1px solid rgba(245,158,11,0.2);
    color: var(--ember-400);
  }

  .connection-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #34d399;
    box-shadow: 0 0 6px rgba(52,211,153,0.4);
    animation: connPulse 2s ease-in-out infinite;
  }

  .connection-dot.error-dot {
    background: #f87171;
    box-shadow: 0 0 6px rgba(248,113,113,0.4);
  }

  .connection-dot.connecting-dot {
    background: var(--ember-400);
    box-shadow: 0 0 6px rgba(245,158,11,0.4);
  }
</style>
