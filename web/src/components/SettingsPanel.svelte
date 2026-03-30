<script>
  import { X, User, Bell, Palette, Wifi } from 'lucide-svelte';

  let { store, theme = 'dark', onClose } = $props();

  let displayName = $state(store?.userProfile?.name || 'Anonymous');
  let desktopNotifications = $state(Notification?.permission === 'granted');
  let inAppToasts = $state(true);

  function handleNameChange(e) {
    displayName = e.target.value;
    if (store?.userProfile) {
      store.userProfile.name = displayName;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('claude-comms-user-name', displayName);
    }
  }

  function toggleDesktopNotifications() {
    if (!desktopNotifications && Notification?.permission !== 'granted') {
      Notification.requestPermission().then(perm => {
        desktopNotifications = perm === 'granted';
      });
    } else {
      desktopNotifications = !desktopNotifications;
    }
  }

  function toggleInAppToasts() {
    inAppToasts = !inAppToasts;
  }
</script>

<div class="settings-panel" data-testid="settings-panel" role="complementary" aria-label="Settings">
  <div class="settings-header">
    <span class="settings-title">Settings</span>
    <button class="settings-close" onclick={onClose} data-testid="settings-panel-close" aria-label="Close settings panel">
      <X size={16} strokeWidth={2} />
    </button>
  </div>

  <div class="settings-body">
    <!-- Profile Section -->
    <div class="settings-section">
      <div class="section-heading">
        <User size={14} strokeWidth={2} />
        <span>Profile</span>
      </div>
      <div class="setting-row">
        <label class="setting-label" for="settings-display-name">Display Name</label>
        <input
          id="settings-display-name"
          class="setting-input"
          type="text"
          value={displayName}
          oninput={handleNameChange}
        />
      </div>
      <div class="setting-row">
        <label class="setting-label" for="settings-participant-key">Participant Key</label>
        <div id="settings-participant-key" class="setting-readonly">{store?.userProfile?.key || 'N/A'}</div>
      </div>
    </div>

    <!-- Notifications Section -->
    <div class="settings-section">
      <div class="section-heading">
        <Bell size={14} strokeWidth={2} />
        <span>Notifications</span>
      </div>
      <div class="setting-row toggle-row">
        <span class="setting-label">Desktop Notifications</span>
        <button
          class="toggle-switch"
          class:active={desktopNotifications}
          onclick={toggleDesktopNotifications}
          role="switch"
          aria-checked={desktopNotifications}
          aria-label="Toggle desktop notifications"
        >
          <span class="toggle-knob"></span>
        </button>
      </div>
      <div class="setting-row toggle-row">
        <span class="setting-label">In-App Toasts</span>
        <button
          class="toggle-switch"
          class:active={inAppToasts}
          onclick={toggleInAppToasts}
          role="switch"
          aria-checked={inAppToasts}
          aria-label="Toggle in-app toasts"
        >
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <!-- Appearance Section -->
    <div class="settings-section">
      <div class="section-heading">
        <Palette size={14} strokeWidth={2} />
        <span>Appearance</span>
      </div>
      <div class="setting-row">
        <span class="setting-label">Current Theme</span>
        <span class="setting-value theme-badge">{theme === 'dark' ? 'Dark' : 'Light'}</span>
      </div>
    </div>

    <!-- Connection Section -->
    <div class="settings-section">
      <div class="section-heading">
        <Wifi size={14} strokeWidth={2} />
        <span>Connection</span>
      </div>
      <div class="setting-row">
        <span class="setting-label">Broker URL</span>
        <div class="setting-readonly mono">{store?.brokerUrl || 'ws://localhost:9001'}</div>
      </div>
      <div class="setting-row">
        <span class="setting-label">Status</span>
        <span class="setting-value" class:connected={store?.connected} class:disconnected={!store?.connected}>
          <span class="conn-dot"></span>
          {store?.connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
    </div>
  </div>
</div>

<style>
  .settings-panel {
    position: absolute;
    top: 82px;
    right: 0;
    bottom: 0;
    width: 380px;
    z-index: 50;
    background: rgba(20, 20, 22, 0.96);
    backdrop-filter: blur(20px);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 32px rgba(0,0,0,0.3);
    display: flex;
    flex-direction: column;
    animation: searchSlide 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .settings-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .settings-title {
    font-size: 14px;
    font-weight: 700;
  }

  .settings-close {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .settings-close:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .settings-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px 16px;
  }

  .settings-section {
    padding: 14px 0;
    border-bottom: 1px solid var(--border-subtle, var(--border));
  }

  .settings-section:last-child {
    border-bottom: none;
  }

  .section-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--ember-400);
    margin-bottom: 12px;
  }

  .setting-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }

  .setting-row:last-child {
    margin-bottom: 0;
  }

  .setting-row.toggle-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .setting-label {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }

  .setting-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    font-family: inherit;
    transition: var(--transition-med);
  }

  .setting-input:focus {
    border-color: var(--ember-700);
    box-shadow: 0 0 0 3px var(--border-glow, rgba(245,158,11,0.06));
  }

  .setting-readonly {
    padding: 8px 12px;
    background: var(--bg-deepest, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-faint);
    font-size: 12px;
    user-select: all;
    word-break: break-all;
  }

  .setting-readonly.mono {
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 11px;
  }

  .setting-value {
    font-size: 13px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .theme-badge {
    padding: 3px 10px;
    border-radius: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .conn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
  }

  .connected .conn-dot {
    background: #22c55e;
    box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);
  }

  .disconnected .conn-dot {
    background: #ef4444;
    box-shadow: 0 0 6px rgba(239, 68, 68, 0.4);
  }

  .connected {
    color: #22c55e;
  }

  .disconnected {
    color: #ef4444;
  }

  /* Toggle Switch */
  .toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-deepest, var(--bg-surface));
    cursor: pointer;
    transition: var(--transition-fast);
    flex-shrink: 0;
    padding: 0;
  }

  .toggle-switch.active {
    background: var(--ember-600);
    border-color: var(--ember-500);
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-faint);
    transition: var(--transition-fast);
  }

  .toggle-switch.active .toggle-knob {
    left: 18px;
    background: #fff;
  }

  @media (max-width: 480px) {
    .settings-panel {
      width: 100%;
    }
  }
</style>
