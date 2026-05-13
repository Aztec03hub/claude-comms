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
  import pkg from '../../package.json';

  const APP_VERSION = pkg?.version || '';

  let { store, onCreateChannel, onBrowseChannels, onShowProfile, onOpenSettings, onStarToggle } = $props();

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

  async function handleContextAction(actionId) {
    const c = contextMenuChannel;
    closeContextMenu();
    if (!c) return;
    if (actionId === 'toggle-star') return void store.setStar(c.id, !c.starred);
    if (typeof actionId === 'string' && actionId.startsWith('mute:')) {
      return void store.setMute(c.id, actionId.split(':')[1]);
    }
    if (actionId === 'mark-read') return; // v0.4.1 follow-up — no store method yet.
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
        store.leaveChannel(c.id);
      }
      return;
    }
    if (actionId === 'close') return void store.closeChannel(c.id);
    if (actionId === 'delete') {
      // Step 2.13 will replace this with a type-name-to-confirm modal.
      const ok = typeof window !== 'undefined'
        ? window.confirm(`Delete #${c.name ?? c.id}? This cannot be undone.`)
        : false;
      if (ok) store.deleteChannel(c.id);
      return;
    }
    if (actionId === 'info' && typeof onBrowseChannels === 'function') onBrowseChannels();
  }

  function handleLeaveConfirm() {
    const id = leaveDialogChannel?.id;
    leaveDialogOpen = false;
    leaveDialogChannel = null;
    if (id) store.leaveChannel(id);
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
    </div>
    <button class="user-settings" title="User settings" onclick={(e) => { e.stopPropagation(); onOpenSettings(); }}>
      <Settings size={16} />
    </button>
  </div>

  {#if contextMenuOpen && contextMenuChannel}
    <ChannelContextMenu
      channel={contextMenuChannel}
      anchorEvent={contextMenuEvent}
      isMember={contextMenuIsMember}
      isCreator={contextMenuIsCreator}
      onAction={handleContextAction}
      onClose={closeContextMenu}
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
  .user-settings { width: 28px; height: 28px; border-radius: 8px; border: none; background: none; color: var(--text-faint); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: var(--transition-fast); }
  .user-settings:hover { background: var(--bg-surface); color: var(--text-secondary); }
  @media (max-width: 480px) { .sidebar-left { display: none; } }
</style>
