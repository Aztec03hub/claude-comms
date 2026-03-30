<!--
  @component Avatar
  @description Displays a circular avatar with the user's initials, gradient background, optional online/offline/idle status indicator, and optional click handler for viewing profiles.
  @prop {string} name - The user's display name, used to derive initials.
  @prop {string} gradient - CSS gradient string for the avatar background.
  @prop {string|null} status - Online presence status: 'online', 'offline', 'idle', or null.
  @prop {number} size - Diameter of the avatar in pixels (default: 34).
  @prop {Function|null} onClick - Optional click handler, typically to open a profile card.
-->
<script>
  import { getInitials } from '../lib/utils.js';

  let { name, gradient, status = null, size = 34, onClick = null } = $props();

  let initials = $derived(getInitials(name));
</script>

{#if onClick}
  <div
    class="avatar"
    style="background: {gradient}; width: {size}px; height: {size}px; font-size: {Math.round(size * 0.32)}px;"
    onclick={onClick}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    role="button"
    tabindex="0"
    aria-label="View profile for {name}"
    data-testid="avatar"
  >
    {initials}
    {#if status}
      <div class="status-indicator" class:online={status === 'online'} class:offline={status === 'offline'} class:idle={status === 'idle'}></div>
    {/if}
  </div>
{:else}
  <div
    class="avatar"
    style="background: {gradient}; width: {size}px; height: {size}px; font-size: {Math.round(size * 0.32)}px;"
    data-testid="avatar"
  >
    {initials}
    {#if status}
      <div class="status-indicator" class:online={status === 'online'} class:offline={status === 'offline'} class:idle={status === 'idle'}></div>
    {/if}
  </div>
{/if}

<style>
  .avatar {
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    color: #0a0a0c;
    margin-top: 3px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    transition: var(--transition-fast);
    cursor: pointer;
    position: relative;
  }

  .avatar:hover {
    transform: scale(1.08);
    box-shadow: 0 2px 10px rgba(0,0,0,0.4);
  }

  .status-indicator {
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 2px solid var(--bg-sidebar);
    transition: var(--transition-med);
  }

  .status-indicator.online {
    background: var(--ember-400);
    box-shadow: 0 0 6px rgba(245,158,11,0.35);
  }

  .status-indicator.idle { background: var(--gold); }
  .status-indicator.offline { background: var(--text-faint); }
</style>
