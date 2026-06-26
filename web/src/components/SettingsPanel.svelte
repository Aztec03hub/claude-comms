<!--
  @component SettingsPanel
  @description Slide-in settings panel with sections for Profile (display name editing), Notifications (desktop and in-app toast toggles), Appearance (dark mode toggle), and Connection (broker URL and status display).
  @prop {object} store - The ChatStore instance for reading/writing user profile and notification preferences.
  @prop {string} theme - Current theme: 'dark' or 'light' (default: 'dark').
  @prop {Function} onClose - Callback invoked to close the settings panel.
  @prop {Function} onToggleTheme - Callback invoked to toggle between dark and light themes.
-->
<script>
  import { untrack, onDestroy } from 'svelte';
  import { X, User, Bell, Palette, Wifi } from 'lucide-svelte';
  import { updateName as apiUpdateName } from '../lib/api.js';

  let { store, theme = 'dark', onClose, onToggleTheme } = $props();

  const MAX_NAME_LENGTH = 50;
  const DEBOUNCE_MS = 500;
  const SAVED_FADE_MS = 1500;
  const ERROR_FADE_MS = 3000;

  // The initial profile name when the panel was opened. Used to revert the
  // input + the store on failure (UX G-9).
  const initialName = untrack(() => store?.userProfile?.name || 'Anonymous');

  let displayName = $state(initialName);
  let lastSavedName = $state(initialName);
  let nameError = $derived.by(() => {
    if (!displayName.trim()) return 'Name cannot be empty.';
    if (displayName.length > MAX_NAME_LENGTH) return 'Name must be ' + MAX_NAME_LENGTH + ' characters or fewer.';
    return '';
  });
  let desktopNotifications = $state(Notification?.permission === 'granted');
  let inAppToasts = $state(untrack(() => store?.inAppToasts ?? true));

  // Connection diagnostics (single-origin design §6): the in-UI mirror of the
  // ``claude-comms doctor`` CLI. Refresh once when the panel mounts so the
  // readout reflects the current state of each leg; the user can re-run it.
  let diagnosticsRunning = $state(false);
  async function refreshDiagnostics() {
    if (!store || typeof store.runDiagnostics !== 'function') return;
    diagnosticsRunning = true;
    try {
      await store.runDiagnostics();
    } finally {
      diagnosticsRunning = false;
    }
  }
  // Kick an initial probe on mount (untracked so it runs exactly once, not on
  // every diagnostics mutation).
  $effect(() => {
    untrack(() => refreshDiagnostics());
  });
  // The leg labels + the value each maps to in store.diagnostics. ``null`` is
  // rendered as "checking", true as ✓, false as ✗.
  const DIAG_LEGS = [
    { key: 'web', label: 'Web server' },
    { key: 'rest', label: 'REST API' },
    { key: 'mcp', label: 'MCP' },
    { key: 'broker', label: 'Broker' },
  ];
  function diagSymbol(state) {
    if (state === true) return '✓';
    if (state === false) return '✗';
    return '…';
  }
  function diagClass(state) {
    if (state === true) return 'diag-ok';
    if (state === false) return 'diag-fail';
    return 'diag-unknown';
  }

  /**
   * Inline rename status surfaced near the name input under aria-live
   * polite. `kind` discriminates style classes; `text` is the rendered
   * copy. `kind` is one of: 'idle' | 'saving' | 'saved' | 'error' |
   * 'blocked'. (UX G-9.)
   */
  let nameStatus = $state({ kind: 'idle', text: '' });

  // Pending debounce + fade timers, cleared on each new keystroke or
  // unmount to avoid stale state writes.
  let debounceTimer = null;
  let fadeTimer = null;

  function clearTimers() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (fadeTimer !== null) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  function setStatus(kind, text, fadeMs = 0) {
    nameStatus = { kind, text };
    if (fadeTimer !== null) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    if (fadeMs > 0) {
      fadeTimer = setTimeout(() => {
        nameStatus = { kind: 'idle', text: '' };
        fadeTimer = null;
      }, fadeMs);
    }
  }

  /**
   * Persist a confirmed-good rename to localStorage so a future session
   * can re-seed before the daemon responds. Mirrors the pre-G-9 write
   * behavior but moves it AFTER server confirmation so a failed rename
   * never leaves the local store out of sync.
   */
  function persistLocally(name) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('claude-comms-user-name', name);
      }
    } catch {
      // localStorage unavailable -- silently ignore
    }
  }

  async function commitNameChange(candidate) {
    // Guard against keystrokes that landed during the in-flight POST and
    // moved `displayName` somewhere new; only land the change if it still
    // matches what we sent.
    const inFlight = candidate;

    setStatus('saving', 'Saving...');
    const key = store?.userProfile?.key || '';
    const result = await apiUpdateName(key, candidate);

    // If the user kept typing while in-flight, abandon this result --
    // the new value's debounce will issue its own POST.
    if (displayName !== inFlight) {
      return;
    }

    if (result && result.success) {
      if (store?.userProfile) {
        store.userProfile.name = result.name || candidate;
      }
      if (store && store.nameUnset) {
        store.nameUnset = false;
      }
      lastSavedName = result.name || candidate;
      persistLocally(lastSavedName);
      setStatus('saved', 'Saved', SAVED_FADE_MS);
    } else {
      const reason = (result && result.error) || 'Unknown error.';
      // Revert the input to the last server-confirmed name. The store's
      // userProfile.name was not mutated (we wait for confirmation) so
      // no rollback there is required.
      displayName = lastSavedName;
      setStatus('error', 'Error: ' + reason, ERROR_FADE_MS);
    }
  }

  function handleNameChange(e) {
    const val = e.target.value;
    // Enforce max length at input level
    if (val.length > MAX_NAME_LENGTH) {
      displayName = val.slice(0, MAX_NAME_LENGTH);
      e.target.value = displayName;
    } else {
      displayName = val;
    }

    // Always cancel any pending debounce -- we restart the timer on
    // every keystroke. (Also cancels any fading "Saved"/"Error" hint so
    // the next status flips in cleanly.)
    clearTimers();

    const candidate = displayName.trim();
    if (!candidate) {
      // Empty / whitespace -- the derived nameError already surfaces the
      // problem; do not call the backend.
      return;
    }
    if (candidate.length > MAX_NAME_LENGTH) {
      return;
    }
    if (candidate === lastSavedName) {
      // No-op rename (typed-then-erased back to the saved value).
      setStatus('idle', '');
      return;
    }

    // Offline guard. Block the backend call with a clear hint per the
    // UX G-9 brief.
    if (!store?.connected) {
      setStatus('blocked', 'Cannot rename while disconnected. Reconnect first.');
      return;
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      commitNameChange(candidate);
    }, DEBOUNCE_MS);
  }

  onDestroy(() => {
    clearTimers();
  });

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
    if (store) store.inAppToasts = inAppToasts;
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
          class:input-error={!!nameError}
          type="text"
          value={displayName}
          maxlength={MAX_NAME_LENGTH}
          oninput={handleNameChange}
        />
        {#if nameError}
          <span class="field-error">{nameError}</span>
        {:else}
          <span class="field-hint">{displayName.length}/{MAX_NAME_LENGTH}</span>
        {/if}
        <span
          class="name-status name-status-{nameStatus.kind}"
          data-testid="settings-name-status"
          data-status-kind={nameStatus.kind}
          aria-live="polite"
        >
          {nameStatus.text}
        </span>
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
      <div class="setting-row toggle-row">
        <span class="setting-label">Dark Mode</span>
        <button
          class="toggle-switch"
          class:active={theme === 'dark'}
          onclick={onToggleTheme}
          role="switch"
          aria-checked={theme === 'dark'}
          aria-label="Toggle dark mode"
        >
          <span class="toggle-knob"></span>
        </button>
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

      <!-- Connection diagnostics (single-origin design §6): the in-UI mirror
           of `claude-comms doctor`. Shows which leg (web / REST / MCP / broker)
           is reachable so a failure is self-explaining. -->
      <div class="setting-row diag-row">
        <span class="setting-label">Connection diagnostics</span>
        <button
          type="button"
          class="diag-refresh-btn"
          data-testid="diagnostics-refresh"
          onclick={refreshDiagnostics}
          disabled={diagnosticsRunning}
          aria-label="Re-run connection diagnostics"
        >
          {diagnosticsRunning ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      <ul class="diag-list" data-testid="connection-diagnostics" aria-live="polite">
        {#each DIAG_LEGS as leg (leg.key)}
          <li class="diag-item">
            <span class="diag-symbol {diagClass(store?.diagnostics?.[leg.key])}" aria-hidden="true">
              {diagSymbol(store?.diagnostics?.[leg.key])}
            </span>
            <span class="diag-leg-label">{leg.label}</span>
          </li>
        {/each}
      </ul>
    </div>
  </div>
</div>

<style>
  .settings-panel {
    position: absolute;
    /* v0.4.4 hotfix (Bug 6): align with the chat container's top edge
       so the panel sits flush against the ChatHeader instead of
       leaving an 82px gap. Same fix + same rationale as SearchPanel
       (pre-v0.4.2 inline chat header lived OUTSIDE the chat
       container; v0.4.2 moved it INSIDE ChatView, making this
       82px offset vestigial). Pattern reference: ArtifactPanel. */
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    z-index: var(--z-panel);
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

  .setting-input.input-error {
    border-color: #ef4444;
  }

  .setting-input.input-error:focus {
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
  }

  .field-error {
    font-size: 11px;
    color: #ef4444;
    margin-top: 2px;
  }

  .field-hint {
    font-size: 10px;
    color: var(--text-faint);
    margin-top: 2px;
    text-align: right;
  }

  .name-status {
    font-size: 11px;
    margin-top: 4px;
    min-height: 14px;
    transition: opacity 200ms ease;
  }

  .name-status-idle {
    color: var(--text-faint);
    opacity: 0;
  }

  .name-status-saving {
    color: var(--text-faint);
  }

  .name-status-saved {
    color: #22c55e;
  }

  .name-status-error {
    color: var(--ember-400);
  }

  .name-status-blocked {
    color: var(--ember-400);
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

  /* Connection diagnostics readout (single-origin design §6). */
  .diag-row {
    align-items: center;
  }
  .diag-refresh-btn {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    background: var(--bg-deepest, var(--bg-surface));
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    transition: var(--transition-fast);
  }
  .diag-refresh-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--text-faint);
  }
  .diag-refresh-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .diag-list {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
  }
  .diag-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .diag-symbol {
    font-weight: 700;
    width: 12px;
    text-align: center;
    flex-shrink: 0;
  }
  .diag-symbol.diag-ok {
    color: #22c55e;
  }
  .diag-symbol.diag-fail {
    color: #ef4444;
  }
  .diag-symbol.diag-unknown {
    color: var(--text-faint);
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
