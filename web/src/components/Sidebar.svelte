<!--
  @component Sidebar (v0.4.0 Step 2.12 thin-shell rewrite). Three
  SidebarChannelSection instances + brand/search header + footer (profile,
  connection status) + on-demand ChannelContextMenu / LeaveChannelDialog.
  SORT-LOCK: no sorting in this file; store $derived projections hand
  pre-sorted arrays in. See SidebarChannelRow / SidebarChannelSection /
  ChannelContextMenu / LeaveChannelDialog for the heavy lifting.
-->
<script>
  import { Star, Hash, Globe, Plus, Settings, Command, Compass } from 'lucide-svelte';
  import SidebarChannelSection from './SidebarChannelSection.svelte';
  import ChannelContextMenu from './ChannelContextMenu.svelte';
  import LeaveChannelDialog from './LeaveChannelDialog.svelte';
  import StatusEditor from './StatusEditor.svelte';
  import * as notifications from '../lib/notifications.svelte.js';
  import pkg from '../../package.json';

  const APP_VERSION = pkg?.version || '';

  let {
    store,
    onCreateChannel,
    onBrowseChannels,
    onShowProfile,
    onOpenSettings,
    onStarToggle,
    // Polish Wave Batch 2 wiring — App.svelte injects these so the Sidebar
    // doesn't have to know how the destructive-confirm dialog or undo-toast
    // are mounted. ``onConfirmDestructive(opts) => Promise<boolean>``;
    // ``onShowUndoToast({ message, onUndo, onExpire })``. Tests can stub
    // them with vi.fn() that resolves on demand.
    onConfirmDestructive,
    onShowUndoToast,
  } = $props();

  // Footer connection-status binding (UX G-25) — three-state mirror of ConnectionStatus.svelte.
  let connectionLabel = $derived(store.connected ? 'Online' : (store.connectionError ? 'Offline' : 'Reconnecting…'));
  let connectionState = $derived(store.connected ? 'online' : (store.connectionError ? 'offline' : 'connecting'));

  // Context-menu + leave-dialog state. One menu / one dialog at a time.
  let contextMenuOpen = $state(false);
  let contextMenuChannel = $state(null);
  let contextMenuEvent = $state(null);
  let leaveDialogOpen = $state(false);
  let leaveDialogChannel = $state(null);
  let leaveDialogMessageCount = $state(0);
  let leaveDialogIsStarred = $state(false);
  let leaveDialogHasPinnedMessages = $state(false);

  // StatusEditor popover state (UX G-24, v0.4.2 Step 3.13).
  // Anchored to the identity row's status line click. Open / close is
  // local boolean; the editor itself is self-positioning (fixed
  // bottom-left of viewport) so the sidebar's overflow:hidden doesn't
  // clip it.
  let statusEditorOpen = $state(false);
  function openStatusEditor() { statusEditorOpen = true; }
  function closeStatusEditor() { statusEditorOpen = false; }
  async function handleStatusSave(emoji, text, expiresAt) {
    statusEditorOpen = false;
    await store.setProfileStatus(emoji, text, expiresAt);
  }
  async function handleStatusClear() {
    statusEditorOpen = false;
    await store.clearProfileStatus();
  }

  function openContextMenu(event, channelId) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    contextMenuChannel = store.channelsById?.[channelId] ?? null;
    contextMenuEvent = event;
    contextMenuOpen = true;
  }
  function closeContextMenu() {
    contextMenuOpen = false;
    contextMenuChannel = null;
    contextMenuEvent = null;
  }

  // Pre-leave gate (Step 2.11 contract): >50 my-messages OR starred OR my-pinned authorship.
  function countMyMessages(channelId) {
    const selfKey = store.userProfile?.key;
    const messages = store.messages;
    if (!selfKey || !Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) if (m?.channel === channelId && m?.from === selfKey) n += 1;
    return n;
  }
  function hasMyPinnedMessages(channelId) {
    const selfKey = store.userProfile?.key;
    const pinned = store.pinnedMessages;
    if (!selfKey || !Array.isArray(pinned)) return false;
    return pinned.some((m) => m?.channel === channelId && m?.from === selfKey);
  }
  function shouldConfirmLeave(channel) {
    if (!channel) return false;
    if (channel.starred) return true;
    if (hasMyPinnedMessages(channel.id)) return true;
    if (countMyMessages(channel.id) > 50) return true;
    return false;
  }

  /**
   * Spawn an undo toast for an in-flight ``{ done, cancel }`` envelope.
   * Polish Wave Batch 2 — converts the store's leave/archive/close envelopes
   * into the ``{ message, onUndo, onExpire }`` shape App.svelte's
   * ``onShowUndoToast`` consumes. No-op when the host hasn't supplied the
   * prop (e.g. test renders that don't care about toast wiring).
   */
  function spawnUndoToast(handle, message) {
    if (typeof onShowUndoToast !== 'function') return;
    if (!handle || typeof handle.cancel !== 'function') return;
    onShowUndoToast({
      message,
      onUndo: () => { try { handle.cancel(); } catch { /* already committed */ } },
      // onExpire is a no-op: the store's internal 15s timer commits the
      // action on its own; we don't need to push a second commit signal.
      onExpire: () => {},
    });
  }

  async function handleContextAction(actionId) {
    const c = contextMenuChannel;
    closeContextMenu();
    if (!c) return;
    if (actionId === 'toggle-star') return void store.setStar(c.id, !c.starred);
    if (typeof actionId === 'string' && actionId.startsWith('mute:')) {
      return void store.setMute(c.id, actionId.split(':')[1]);
    }
    // v0.4.2 Wave G follow-up [VERIFY-WAVE-G-3]: the Q8 quickview row in
    // ChannelContextMenu emits ``actionId='notif:cycle'`` and expects the
    // parent to advance the per-channel notification policy through the
    // ``All → Mentions → Off → All`` cycle. The companion
    // ``actionId='notif:configure'`` action is handled by
    // ChannelContextMenu itself: it dispatches a
    // ``claude-comms:configure-notifications`` window CustomEvent which
    // App.svelte listens for to mount the full NotificationPolicyMenu
    // popover. Both surfaces use the SAME store accessors so the
    // bell-icon variant on SidebarChannelRow + the toast / browser
    // Notification gate re-render off a single source of truth.
    if (actionId === 'notif:cycle') {
      if (typeof store.cycleNotificationPolicy === 'function') {
        store.cycleNotificationPolicy(c.id);
      }
      return;
    }
    if (actionId === 'mark-read') return void store.markAllRead(c.id);
    if (actionId === 'copy-link') {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(`/#/c/${encodeURIComponent(c.id)}`);
        }
      } catch { /* clipboard blocked (jsdom, denied) — silent */ }
      return;
    }
    if (actionId === 'leave') {
      if (shouldConfirmLeave(c)) {
        leaveDialogChannel = c;
        leaveDialogMessageCount = countMyMessages(c.id);
        leaveDialogIsStarred = c.starred === true;
        leaveDialogHasPinnedMessages = hasMyPinnedMessages(c.id);
        leaveDialogOpen = true;
      } else {
        const handle = store.leaveChannel(c.id);
        spawnUndoToast(handle, `Left #${c.name ?? c.id}`);
      }
      return;
    }
    if (actionId === 'close') {
      const handle = store.closeChannel(c.id);
      spawnUndoToast(handle, `Closed #${c.name ?? c.id}`);
      return;
    }
    if (actionId === 'delete') {
      // Polish Wave Batch 2 — replace the v0.4.0 window.confirm placeholder
      // with the shared TypeNameConfirmDialog via the Promise-based
      // onConfirmDestructive helper from App.svelte. When the helper is
      // not supplied (test render), fall back to the previous boolean
      // semantics so existing tests don't break.
      const channelName = c.name ?? c.id;
      let ok = false;
      if (typeof onConfirmDestructive === 'function') {
        ok = await onConfirmDestructive({
          resourceName: `channel #${channelName}`,
          requireTypedName: channelName,
          title: 'Delete channel?',
          body: `This will permanently delete #${channelName} and all its history. This cannot be undone.`,
          confirmLabel: 'Delete channel',
          severity: 'danger',
        });
      } else if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        ok = window.confirm(`Delete #${channelName}? This cannot be undone.`);
      }
      if (ok) store.deleteChannel(c.id);
      return;
    }
    if (actionId === 'info' && typeof onBrowseChannels === 'function') onBrowseChannels();
  }

  function handleLeaveConfirm() {
    const ch = leaveDialogChannel;
    const id = ch?.id;
    leaveDialogOpen = false;
    leaveDialogChannel = null;
    if (id) {
      const handle = store.leaveChannel(id);
      spawnUndoToast(handle, `Left #${ch?.name ?? id}`);
    }
  }
  function handleLeaveCancel() {
    leaveDialogOpen = false;
    leaveDialogChannel = null;
  }

  function handleSwitchChannel(channelId) { store.switchChannel(channelId); }
  async function handleJoinChannel(channelId) {
    const result = await store.joinChannel(channelId);
    if (result && result.success !== false) store.switchChannel(channelId);
  }
  // Star toggle — prefer parent onStarToggle prop, fall back to store.setStar.
  function handleStarToggle(channelId) {
    if (typeof onStarToggle === 'function') return void onStarToggle(channelId);
    const c = store.channelsById?.[channelId];
    if (!c) return;
    store.setStar(channelId, !c.starred);
  }

  let contextMenuIsMember = $derived(contextMenuChannel?.member === true);
  let contextMenuIsCreator = $derived(
    contextMenuChannel?.createdBy != null
    && store.userProfile?.key != null
    && contextMenuChannel.createdBy === store.userProfile.key
  );
  // v0.4.2 Wave G follow-up [VERIFY-WAVE-G-3]: resolve the current
  // notification policy for the currently-anchored context-menu channel
  // so the Q8 quickview row label re-renders when the user cycles. The
  // store's ``notificationPolicies`` $state map is the reactive source;
  // ``getNotificationPolicy`` reads through it (lazy-populated from
  // localStorage on first call per channel). We also reference the map
  // explicitly so this $derived re-fires on writes. Svelte's reactivity
  // tracks the GET, but a method call hides the map access from the
  // tracker unless we touch ``store.notificationPolicies`` here.
  let contextMenuPolicy = $derived.by(() => {
    // Touch the reactive map so $derived re-fires on writes from
    // cycleNotificationPolicy / setNotificationPolicy.
    /* eslint-disable-next-line no-unused-expressions */
    store.notificationPolicies;
    if (!contextMenuChannel || typeof store.getNotificationPolicy !== 'function') {
      return { policy: 'All', highlightWords: [] };
    }
    return store.getNotificationPolicy(contextMenuChannel.id);
  });
  // Stable reference passed down into SidebarChannelSection → SidebarChannelRow.
  // Each row calls this with its own channel id to read the policy. Touching
  // ``store.notificationPolicies`` inside is how the row-level $derived
  // re-fires when a cycle/save writes a new entry to the reactive map.
  function getChannelNotificationPolicy(channelId) {
    if (!channelId || typeof store.getNotificationPolicy !== 'function') {
      return { policy: 'All', highlightWords: [] };
    }
    return store.getNotificationPolicy(channelId);
  }

  // v0.4.2 Wave G follow-up [VERIFY-WAVE-G-4]: register the per-channel
  // notification policy resolver with the browser-Notification wrapper
  // so its gate (``shouldNotifyForPolicy``) reads the live store state.
  // Sidebar mounts once per app, alongside the store, so this is the
  // natural injection point. We unregister on teardown so test
  // ``cleanup()`` doesn't leak resolver state between renders.
  $effect(() => {
    // Guarded against incomplete vi.mock fixtures in legacy test files
    // (the parallel ChatHeader agent owns App.svelte so we can't update
    // their mocks this wave). Vitest's auto-mock proxy throws on access
    // for unmocked exports, so the property read itself is wrapped in
    // try/catch. A missing export silently no-ops the registration.
    let setResolver = null;
    try {
      const candidate = notifications.setNotificationPolicyResolver;
      if (typeof candidate === 'function') setResolver = candidate;
    } catch {
      // Auto-mock surfaced an unmocked property; treat as a no-op.
    }
    if (!setResolver) return;
    setResolver((channelId) => getChannelNotificationPolicy(channelId));
    return () => setResolver(null);
  });
  function showSelfProfile() {
    const { key, name, type } = store.userProfile;
    onShowProfile({ key, name, type, status: 'online' });
  }
</script>

<aside class="sidebar-left" data-testid="sidebar">
  <div class="sidebar-brand">
    <div class="brand-icon">CC</div>
    <h1>Claude Comms</h1>
    <span class="brand-version" data-testid="sidebar-version">v{APP_VERSION}</span>
  </div>

  <div class="search-wrap">
    <input class="search-input" type="text" placeholder="Search conversations..." data-testid="sidebar-search">
    <span class="search-kbd"><Command size={11} strokeWidth={2.5} />K</span>
  </div>

  <div class="sidebar-sections" data-testid="sidebar-sections">
    <SidebarChannelSection
      label="Starred"
      icon={Star}
      channels={store.starredChannels}
      activeChannelId={store.activeChannel}
      emptyState="No starred channels. Right-click a channel to star it."
      storageKey="claude-comms.sidebar.starred.expanded"
      defaultExpanded={true}
      onChannelClick={handleSwitchChannel}
      onChannelContextMenu={openContextMenu}
      onStarToggle={handleStarToggle}
      getNotificationPolicy={getChannelNotificationPolicy}
    />
    <SidebarChannelSection
      label="Active"
      icon={Hash}
      channels={store.activeChannels}
      activeChannelId={store.activeChannel}
      emptyState="You haven't joined any channels yet. Browse the directory or create one."
      storageKey="claude-comms.sidebar.active.expanded"
      defaultExpanded={true}
      onChannelClick={handleSwitchChannel}
      onChannelContextMenu={openContextMenu}
      onStarToggle={handleStarToggle}
      getNotificationPolicy={getChannelNotificationPolicy}
    />
    <SidebarChannelSection
      label="Available"
      icon={Globe}
      channels={store.availableChannels}
      activeChannelId={store.activeChannel}
      emptyState="No channels available. Create one to get started."
      storageKey="claude-comms.sidebar.available.expanded"
      defaultExpanded={true}
      onChannelClick={handleJoinChannel}
      onChannelContextMenu={openContextMenu}
      onStarToggle={handleStarToggle}
      getNotificationPolicy={getChannelNotificationPolicy}
    />
  </div>

  <button class="create-channel" onclick={onCreateChannel} data-testid="sidebar-create-channel">
    <Plus size={12} /> New Conversation
  </button>
  <button class="browse-channels" onclick={onBrowseChannels} data-testid="sidebar-browse-channels">
    <Compass size={12} /> Browse All
  </button>

  <div
    class="user-profile"
    data-testid="sidebar-user-profile"
    onclick={showSelfProfile}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') showSelfProfile(); }}
    role="button"
    tabindex="0"
  >
    <div class="user-avatar-wrap">
      <div class="user-avatar">{store.userProfile.name.slice(0, 2).toUpperCase()}</div>
      <div
        class="status-dot"
        class:online={connectionState === 'online'}
        class:connecting={connectionState === 'connecting'}
        class:offline={connectionState === 'offline'}
        data-testid="sidebar-status-dot"
      ></div>
    </div>
    <div class="user-info">
      <div class="uname">{store.userProfile.name}</div>
      <div
        class="ustatus"
        class:online={connectionState === 'online'}
        class:connecting={connectionState === 'connecting'}
        class:offline={connectionState === 'offline'}
        data-testid="sidebar-user-status"
      >{connectionLabel}</div>
      <button
        type="button"
        class="profile-status-row"
        class:has-status={store.userProfile.profileStatus != null}
        onclick={(e) => { e.stopPropagation(); openStatusEditor(); }}
        data-testid="sidebar-profile-status"
        title="Set a status"
      >
        {#if store.userProfile.profileStatus}
          {#if store.userProfile.profileStatus.emoji}
            <span class="ps-emoji" data-testid="sidebar-profile-status-emoji">{store.userProfile.profileStatus.emoji}</span>
          {/if}
          <span class="ps-text" data-testid="sidebar-profile-status-text">{store.userProfile.profileStatus.text ?? ''}</span>
        {:else}
          <span class="ps-placeholder">Set a status</span>
        {/if}
      </button>
    </div>
    <button class="user-settings" title="User settings" onclick={(e) => { e.stopPropagation(); onOpenSettings(); }}>
      <Settings size={16} />
    </button>
  </div>

  {#if statusEditorOpen}
    <StatusEditor
      currentStatus={store.userProfile.profileStatus}
      onSave={handleStatusSave}
      onClear={handleStatusClear}
      onCancel={closeStatusEditor}
    />
  {/if}

  {#if contextMenuOpen && contextMenuChannel}
    <ChannelContextMenu
      channel={contextMenuChannel}
      anchorEvent={contextMenuEvent}
      isMember={contextMenuIsMember}
      isCreator={contextMenuIsCreator}
      onAction={handleContextAction}
      onClose={closeContextMenu}
      currentNotificationPolicy={contextMenuPolicy}
    />
  {/if}

  {#if leaveDialogOpen && leaveDialogChannel}
    <LeaveChannelDialog
      channel={leaveDialogChannel}
      messageCount={leaveDialogMessageCount}
      isStarred={leaveDialogIsStarred}
      hasPinnedMessages={leaveDialogHasPinnedMessages}
      onConfirm={handleLeaveConfirm}
      onCancel={handleLeaveCancel}
    />
  {/if}
</aside>

<style>
  .sidebar-left { width: var(--sidebar-w); min-width: var(--sidebar-w); background: var(--bg-sidebar); backdrop-filter: blur(20px); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; position: relative; z-index: 1; }
  .sidebar-left::after { content: ''; position: absolute; top: 0; right: 0; bottom: 0; width: 1px; background: linear-gradient(180deg, rgba(245,158,11,0.06), transparent 30%, transparent 70%, rgba(245,158,11,0.04)); pointer-events: none; }
  .sidebar-brand { padding: 22px 18px 16px; display: flex; align-items: center; gap: 11px; }
  .sidebar-brand h1 { font-size: 17px; font-weight: 800; letter-spacing: -0.4px; background: linear-gradient(135deg, var(--ember-400), var(--ember-300), var(--gold)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .brand-icon { width: 30px; height: 30px; border-radius: 9px; background: linear-gradient(135deg, var(--ember-600), var(--ember-400)); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; color: #0a0a0c; box-shadow: 0 2px 8px rgba(245,158,11,0.2), 0 0 0 1px rgba(245,158,11,0.1); }
  .brand-version { font-size: 9px; font-weight: 600; color: var(--text-faint); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; margin-left: 2px; letter-spacing: 0.3px; }
  .search-wrap { padding: 0 14px 14px; position: relative; }
  .search-input { width: 100%; padding: 9px 12px 9px 36px; background: var(--bg-deepest); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 12.5px; outline: none; transition: var(--transition-med); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%234a4540' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='6' cy='6' r='4.5'/%3E%3Cline x1='9.5' y1='9.5' x2='13' y2='13'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: 12px center; }
  .search-input::placeholder { color: var(--text-faint); }
  .search-input:focus { border-color: var(--ember-700); box-shadow: 0 0 0 3px var(--border-glow), 0 0 16px rgba(245,158,11,0.04); }
  .search-kbd { position: absolute; right: 22px; top: 50%; transform: translateY(-50%); font-size: 10px; color: var(--text-faint); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; font-family: 'SF Mono', Consolas, monospace; line-height: 1; pointer-events: none; display: flex; align-items: center; gap: 2px; }
  .sidebar-sections { flex: 1; overflow-y: auto; padding: 0 8px; scroll-behavior: smooth; }
  .create-channel, .browse-channels { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 7px; border-radius: var(--radius-sm); background: none; color: var(--text-faint); font-size: 11px; font-weight: 500; cursor: pointer; transition: var(--transition-fast); font-family: inherit; }
  .create-channel { margin: 4px 8px 8px; border: 1px dashed var(--border); }
  .create-channel:hover { border-color: var(--ember-700); border-style: solid; color: var(--ember-400); background: rgba(245,158,11,0.04); }
  .browse-channels { margin: 0 8px 8px; border: 1px solid rgba(245,158,11,0.15); }
  .browse-channels:hover { border-color: var(--ember-700); color: var(--ember-400); background: rgba(245,158,11,0.04); }
  .user-profile { margin-top: auto; padding: 14px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 10px; background: linear-gradient(180deg, transparent, rgba(0,0,0,0.15)); cursor: pointer; transition: background 0.15s ease; flex-shrink: 0; }
  .user-profile:hover { background: linear-gradient(180deg, rgba(245,158,11,0.05), rgba(0,0,0,0.2)); }
  .user-avatar-wrap { position: relative; cursor: pointer; }
  .user-avatar { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, var(--ember-600), var(--ember-400)); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: #0a0a0c; }
  .status-dot { position: absolute; bottom: -1px; right: -1px; width: 10px; height: 10px; border-radius: 50%; background: #f59e0b; border: 2.5px solid var(--bg-sidebar); box-shadow: 0 0 6px rgba(245,158,11,0.4); transition: background 0.2s ease, box-shadow 0.2s ease; }
  .status-dot.online { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.4); }
  .status-dot.connecting { background: var(--ember-400, #f59e0b); box-shadow: 0 0 6px rgba(245,158,11,0.4); }
  .status-dot.offline { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.4); }
  .user-info { flex: 1; }
  .user-info .uname { font-size: 13px; font-weight: 600; }
  .user-info .ustatus { font-size: 11px; color: var(--ember-500); text-shadow: 0 0 10px rgba(245,158,11,0.3); transition: color 0.2s ease; }
  .user-info .ustatus.online { color: #34d399; text-shadow: 0 0 10px rgba(52,211,153,0.3); }
  .user-info .ustatus.connecting { color: var(--ember-400, #f59e0b); }
  .user-info .ustatus.offline { color: #f87171; text-shadow: 0 0 10px rgba(248,113,113,0.3); }
  .profile-status-row { display: flex; align-items: center; gap: 5px; margin-top: 3px; padding: 1px 0; background: none; border: none; color: var(--text-muted); font-size: 11px; cursor: pointer; max-width: 100%; overflow: hidden; text-align: left; font-family: inherit; }
  .profile-status-row:hover { color: var(--text-secondary); }
  .profile-status-row.has-status { color: var(--text-secondary); }
  .profile-status-row .ps-emoji { font-size: 12px; line-height: 1; flex-shrink: 0; }
  .profile-status-row .ps-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .profile-status-row .ps-placeholder { color: var(--text-faint); font-style: italic; }
  .user-settings { width: 28px; height: 28px; border-radius: 8px; border: none; background: none; color: var(--text-faint); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: var(--transition-fast); }
  .user-settings:hover { background: var(--bg-surface); color: var(--text-secondary); }
  @media (max-width: 480px) { .sidebar-left { display: none; } }
</style>
