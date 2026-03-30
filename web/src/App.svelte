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
  import PinnedPanel from './components/PinnedPanel.svelte';
  import SearchPanel from './components/SearchPanel.svelte';
  import ThreadPanel from './components/ThreadPanel.svelte';

  const store = new MqttChatStore();

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

  // Connect on mount
  $effect(() => {
    store.connect();
    requestPermission();
    return () => store.disconnect();
  });

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
    toasts.push(toast);
    setTimeout(() => {
      const idx = toasts.findIndex(t => t.id === toast.id);
      if (idx >= 0) toasts.splice(idx, 1);
    }, 5000);
  }

  function dismissToast(id) {
    const idx = toasts.findIndex(t => t.id === id);
    if (idx >= 0) toasts.splice(idx, 1);
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
    }
  }

  function handleShowProfile(participant) {
    profileCardTarget = participant;
    showProfileCard = true;
  }

  function handleEmojiSelect(emojiData) {
    // Emoji selected, could add reaction to target message
    showEmojiPicker = false;
    emojiPickerTarget = null;
  }
</script>

<div class="app-layout">
  <Sidebar
    {store}
    onCreateChannel={() => showChannelModal = true}
    onShowProfile={handleShowProfile}
  />

  <main class="center">
    <ConnectionStatus connected={store.connected} onlineCount={store.onlineCount} error={store.connectionError} />

    <header class="chat-header">
      <div class="header-icon">#</div>
      <span class="header-name">{store.activeChannel}</span>
      <span class="header-sep"></span>
      <span class="header-topic">{store.activeChannelMeta?.topic || ''}</span>
      <button class="header-members" type="button">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="4.5" cy="4" r="2.5"/><path d="M0 11.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><circle cx="8.5" cy="4" r="2" opacity=".5"/></svg>
        {store.onlineCount + store.offlineParticipants.length}
      </button>
      <div class="header-actions">
        <button class="header-btn" title="Search" onclick={() => { showSearchPanel = !showSearchPanel; showThreadPanel = false; }}>
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><line x1="11" y1="11" x2="14.5" y2="14.5"/></svg>
        </button>
        <button class="header-btn" title="Pinned messages" onclick={() => showPinnedPanel = !showPinnedPanel}>
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 2l5 5-3 3-1 4-4-4-4 1 3-3z"/></svg>
        </button>
        <button class="header-btn" title="Settings">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3m10 0h1.5M3.1 3.1l1 1m7.8 7.8l1 1M12.9 3.1l-1 1M4.1 11.9l-1 1"/></svg>
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

    <MessageInput
      {store}
      channelName={store.activeChannel}
      typingUsers={store.activeTypingUsers}
      onOpenEmoji={() => showEmojiPicker = !showEmojiPicker}
    />
  </main>

  <MemberList
    online={store.onlineParticipants}
    offline={store.offlineParticipants}
    typingUsers={store.typingUsers}
    onShowProfile={handleShowProfile}
  />
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
  }

  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
    z-index: 1;
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

  .center::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background: repeating-linear-gradient(transparent, transparent 2px, rgba(0,0,0,0.02) 2px, rgba(0,0,0,0.02) 4px);
  }

  .chat-header {
    padding: 14px 22px;
    display: flex;
    align-items: center;
    gap: 12px;
    position: relative;
    z-index: 2;
    background: rgba(17,17,19,0.8);
    backdrop-filter: blur(16px) saturate(1.2);
  }

  .chat-header::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 1px;
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
    letter-spacing: -0.3px;
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
  }

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
</style>
