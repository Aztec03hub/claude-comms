<script>
  import { MqttChatStore } from './lib/mqtt-store.svelte.js';
  import { requestPermission, sendNotification } from './lib/notifications.svelte.js';
  import Sidebar from './components/Sidebar.svelte';
  import ChatView from './components/ChatView.svelte';
  import MemberList from './components/MemberList.svelte';
  import ConnectionStatus from './components/ConnectionStatus.svelte';
  import MessageInput from './components/MessageInput.svelte';
  import ChannelModal from './components/ChannelModal.svelte';
  import NotificationToast from './components/NotificationToast.svelte';
  import EmojiPicker from './components/EmojiPicker.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import ProfileCard from './components/ProfileCard.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import PinnedPanel from './components/PinnedPanel.svelte';
  import SearchPanel from './components/SearchPanel.svelte';
  import ThreadPanel from './components/ThreadPanel.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import { Users, Search, Pin, Settings } from 'lucide-svelte';

  const store = new MqttChatStore();

  let theme = $state('dark');

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }

  let showChannelModal = $state(false);
  let showEmojiPicker = $state(false);
  let showPinnedPanel = $state(false);
  let showSearchPanel = $state(false);
  let showThreadPanel = $state(false);
  let showProfileCard = $state(false);
  let profileCardTarget = $state(null);
  let contextMenu = $state({ show: false, x: 0, y: 0, message: null });
  let toasts = $state([]);
  let threadParent = $state(null);
  let emojiPickerTarget = $state(null);
  let showMemberList = $state(true);
  let showSettingsPanel = $state(false);
  let showDeleteConfirm = $state(false);
  let deleteTarget = $state(null);

  // Connect on mount
  $effect(() => {
    store.connect();
    requestPermission();
    return () => store.disconnect();
  });

  // Global keyboard shortcuts
  function handleGlobalKeydown(e) {
    // Ctrl+K — open search panel
    if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      showSearchPanel = !showSearchPanel;
      if (showSearchPanel) showThreadPanel = false;
      return;
    }

    // Escape — close panels in priority order:
    // modal > context menu > emoji picker > profile card > pinned > search > thread
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (showChannelModal) {
        showChannelModal = false;
      } else if (contextMenu.show) {
        handleCloseContextMenu();
      } else if (showEmojiPicker) {
        showEmojiPicker = false;
        emojiPickerTarget = null;
      } else if (showProfileCard) {
        showProfileCard = false;
      } else if (showPinnedPanel) {
        showPinnedPanel = false;
      } else if (showSettingsPanel) {
        showSettingsPanel = false;
      } else if (showSearchPanel) {
        showSearchPanel = false;
      } else if (showThreadPanel) {
        showThreadPanel = false;
        threadParent = null;
      } else {
        return; // Nothing to close
      }

      // Return focus to message input after panel is removed from DOM
      setTimeout(() => {
        const input = document.querySelector('[data-testid="message-input"]');
        if (input) input.focus();
      }, 100);
      return;
    }
  }

  // Notify on new messages (when not focused)
  $effect(() => {
    const msgs = store.messages;
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last.sender.key !== store.userProfile.key) {
      sendNotification(last.sender.name, {
        body: last.body.slice(0, 100),
        tag: last.id
      });

      // In-app toast
      if (last.channel !== store.activeChannel || document.hidden) {
        addToast({
          id: last.id,
          sender: last.sender,
          channel: last.channel,
          text: last.body.slice(0, 120)
        });
      }
    }
  });

  function addToast(toast) {
    toasts = [...toasts, toast];
    setTimeout(() => {
      toasts = toasts.filter(t => t.id !== toast.id);
    }, 5000);
  }

  function dismissToast(id) {
    toasts = toasts.filter(t => t.id !== id);
  }

  function handleOpenThread(message) {
    threadParent = message;
    showThreadPanel = true;
    showSearchPanel = false;
  }

  function handleContextMenu(e) {
    contextMenu = { show: true, x: e.x, y: e.y, message: e.message };
  }

  function handleCloseContextMenu() {
    contextMenu = { ...contextMenu, show: false };
  }

  function handleContextAction(e) {
    const { action, message } = e;
    handleCloseContextMenu();

    if (action === 'reply') handleOpenThread(message);
    else if (action === 'pin') store.togglePin(message);
    else if (action === 'copy') navigator.clipboard.writeText(message.body);
    else if (action === 'react') {
      emojiPickerTarget = message;
      showEmojiPicker = true;
    } else if (action === 'forward') {
      navigator.clipboard.writeText(message.body);
      addToast({ id: 'fwd-' + Date.now(), sender: { name: 'System', key: 'system', type: 'system' }, channel: store.activeChannel, text: 'Forwarding coming soon' });
    } else if (action === 'unread') {
      store.markUnread(message);
    } else if (action === 'delete') {
      deleteTarget = message;
      showDeleteConfirm = true;
    }
  }

  function handleShowProfile(participant) {
    profileCardTarget = participant;
    showProfileCard = true;
  }

  function handleReact(message, emoji) {
    if (emoji) {
      // Toggle existing reaction directly (clicked a reaction pill)
      store.addReaction(message.id, emoji);
    } else {
      // Open emoji picker to add new reaction (clicked + button)
      emojiPickerTarget = message;
      showEmojiPicker = true;
    }
  }

  function handleEmojiSelect(emojiData) {
    if (emojiPickerTarget) {
      // Opened from React button on a message — add reaction
      store.addReaction(emojiPickerTarget.id, emojiData.emoji);
    } else {
      // Opened from input emoji button — insert emoji into message input
      const input = document.querySelector('[data-testid="message-input"]');
      if (input) {
        const start = input.selectionStart || input.value.length;
        input.value = input.value.slice(0, start) + emojiData.emoji + input.value.slice(start);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.selectionStart = input.selectionEnd = start + emojiData.emoji.length;
      }
    }
    showEmojiPicker = false;
    emojiPickerTarget = null;
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="app-layout">
  <Sidebar
    {store}
    onCreateChannel={() => showChannelModal = true}
    onShowProfile={handleShowProfile}
    onMuteChannel={(channelId) => store.muteChannel(channelId)}
    onOpenSettings={() => showSettingsPanel = !showSettingsPanel}
  />

  <main class="center">
    <ConnectionStatus connected={store.connected} onlineCount={store.onlineCount} error={store.connectionError} />

    <header class="chat-header" data-testid="chat-header">
      <div class="header-icon">#</div>
      <span class="header-name" data-testid="header-channel-name">{store.activeChannel}</span>
      <span class="header-sep"></span>
      <span class="header-topic">{store.activeChannelMeta?.topic || ''}</span>
      <button class="header-members" type="button" data-testid="header-members-count" onclick={() => showMemberList = !showMemberList}>
        <Users size={12} strokeWidth={2} />
        {store.onlineCount + store.offlineParticipants.length}
      </button>
      <div class="header-actions">
        <button class="header-btn" title="Search" onclick={() => { showSearchPanel = !showSearchPanel; showThreadPanel = false; }} data-testid="header-search-btn">
          <Search size={16} strokeWidth={2} />
        </button>
        <button class="header-btn" title="Pinned messages" onclick={() => showPinnedPanel = !showPinnedPanel} data-testid="header-pin-btn">
          <Pin size={16} strokeWidth={2} />
        </button>
        <ThemeToggle mode={theme} onToggle={toggleTheme} />
        <button class="header-btn" title="Settings" onclick={() => showSettingsPanel = !showSettingsPanel} data-testid="header-settings-btn">
          <Settings size={16} strokeWidth={2} />
        </button>
      </div>
    </header>

    {#if showPinnedPanel}
      <PinnedPanel
        messages={store.activePinnedMessages}
        onClose={() => showPinnedPanel = false}
      />
    {/if}

    <ChatView
      messages={store.activeMessages}
      currentUser={store.userProfile}
      participants={store.participants}
      onOpenThread={handleOpenThread}
      onContextMenu={handleContextMenu}
      onShowProfile={handleShowProfile}
      onReact={handleReact}
    />

    {#if showThreadPanel && threadParent}
      <ThreadPanel
        parentMessage={threadParent}
        messages={store.messages.filter(m => m.reply_to === threadParent.id)}
        participants={store.participants}
        currentUser={store.userProfile}
        onClose={() => { showThreadPanel = false; threadParent = null; }}
        onSendReply={(body) => store.sendMessage(body, threadParent.id)}
      />
    {/if}

    {#if showSearchPanel}
      <SearchPanel
        {store}
        onClose={() => showSearchPanel = false}
      />
    {/if}

    {#if showSettingsPanel}
      <SettingsPanel
        {store}
        {theme}
        onClose={() => showSettingsPanel = false}
      />
    {/if}

    <MessageInput
      {store}
      channelName={store.activeChannel}
      typingUsers={store.activeTypingUsers}
      onOpenEmoji={() => showEmojiPicker = !showEmojiPicker}
    />
  </main>

  {#if showMemberList}
    <MemberList
      online={store.onlineParticipants}
      offline={store.offlineParticipants}
      typingUsers={store.typingUsers}
      onShowProfile={handleShowProfile}
    />
  {/if}
</div>

{#if showChannelModal}
  <ChannelModal
    onClose={() => showChannelModal = false}
    onCreate={(id, topic) => { store.createChannel(id, topic); showChannelModal = false; }}
  />
{/if}

{#if showEmojiPicker}
  <EmojiPicker
    onSelect={handleEmojiSelect}
    onClose={() => showEmojiPicker = false}
  />
{/if}

{#if contextMenu.show}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    message={contextMenu.message}
    onAction={handleContextAction}
    onClose={handleCloseContextMenu}
  />
{/if}

{#if showProfileCard && profileCardTarget}
  <ProfileCard
    participant={profileCardTarget}
    onClose={() => showProfileCard = false}
  />
{/if}

{#if showDeleteConfirm && deleteTarget}
  <ConfirmDialog
    title="Delete Message"
    message="Are you sure you want to delete this message? This action cannot be undone."
    confirmLabel="Delete"
    confirmDanger={true}
    onConfirm={() => { store.deleteMessage(deleteTarget.id); showDeleteConfirm = false; deleteTarget = null; }}
    onCancel={() => { showDeleteConfirm = false; deleteTarget = null; }}
  />
{/if}

{#each toasts as toast (toast.id)}
  <NotificationToast
    {...toast}
    onDismiss={() => dismissToast(toast.id)}
  />
{/each}

<style>
  .app-layout {
    display: flex;
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
  }

  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
    z-index: 1;
    overflow: hidden;
  }

  .center::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background-image: radial-gradient(circle at 1px 1px, var(--text-faint) 0.5px, transparent 0.5px);
    background-size: 32px 32px;
    opacity: 0.025;
  }

  /* Scanline overlay removed - not in design spec */

  .chat-header {
    padding: 14px 22px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid var(--border);
    position: relative;
    z-index: 101;
    background: linear-gradient(180deg, var(--bg-base), var(--bg-base));
    backdrop-filter: blur(16px) saturate(1.2);
  }

  .chat-header::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 1px;
    pointer-events: none;
    background: linear-gradient(90deg, transparent, var(--ember-700), var(--ember-500), var(--ember-700), transparent);
    background-size: 200% 100%;
    animation: headerGlow 8s ease infinite;
    opacity: 0.6;
  }

  .header-icon {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: var(--text-muted);
    font-weight: 300;
  }

  .header-name {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.2px;
  }

  .header-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 4px;
  }

  .header-topic {
    font-size: 12.5px;
    color: var(--text-muted);
    flex: 1;
  }

  .header-members {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 20px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }

  .header-members svg { opacity: 0.7; }

  .header-members:hover {
    border-color: var(--ember-700);
    color: var(--text-secondary);
  }

  .header-actions {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }

  .header-btn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .header-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  @media (max-width: 480px) {
    .chat-header {
      padding: 10px 12px;
      gap: 6px;
    }

    .header-topic,
    .header-sep,
    .header-members {
      display: none;
    }

    .header-btn {
      width: 28px;
      height: 28px;
    }
  }
</style>
