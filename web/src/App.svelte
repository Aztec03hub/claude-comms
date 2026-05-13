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
  import ArtifactPanel from './components/ArtifactPanel.svelte';
  import ConversationBrowser from './components/ConversationBrowser.svelte';
  import UserProfileView from './components/UserProfileView.svelte';
  import ForwardPicker from './components/ForwardPicker.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import ChannelDirectoryModal from './components/ChannelDirectoryModal.svelte';
  import KeyboardShortcutsHelp from './components/KeyboardShortcutsHelp.svelte';
  import { getKeyboardRegistry } from './lib/keyboard.svelte.js';
  import { Users, Search, Pin, Settings, Menu, FileText } from 'lucide-svelte';

  const store = new MqttChatStore();
  const keyboard = getKeyboardRegistry();

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
  let showArtifactPanel = $state(false);
  let showDeleteConfirm = $state(false);
  let deleteTarget = $state(null);
  let showUserProfileView = $state(false);
  let userProfileTarget = $state(null);
  let showForwardPicker = $state(false);
  let forwardTarget = $state(null);
  let showConversationBrowser = $state(false);
  let showMobileSidebar = $state(false);

  // v0.4.0 Step 2.17 — keyboard-shortcut surfaces.
  // ``showChannelDirectory``  → Ctrl+L opens the new ChannelDirectoryModal.
  // ``showQuickJoin``         → Ctrl+J opens the single-input "Channel
  //                             name or ID:" prompt; submitting calls
  //                             ``store.joinChannel(value)``.
  // ``showKeyboardHelp``      → ``?`` opens the keyboard cheatsheet overlay.
  let showChannelDirectory = $state(false);
  let showQuickJoin = $state(false);
  let quickJoinValue = $state('');
  let quickJoinError = $state('');
  let showKeyboardHelp = $state(false);

  // Reactive bridges — poll store state to work around Svelte 5
  // class-based $state not flushing DOM updates from async callbacks.
  // Connect on mount
  $effect(() => {
    store.connect();
    requestPermission();

    return () => {
      store.disconnect();
    };
  });

  // v0.4.0 Step 2.17 — register the global keyboard bindings.
  //
  // The registry owns its own window-keydown listener so handlers here
  // only describe WHAT each combo does, not the listener wiring. Each
  // registration includes a description so the help overlay (``?``)
  // can render a human-readable cheatsheet.
  //
  // Escape is intentionally NOT registered here — App.svelte's existing
  // ``handleGlobalKeydown`` already owns the modal-priority cascade and
  // we don't want to fight it. The registry only swallows combos it has
  // a registered handler for; other keys (including Escape and Ctrl+K)
  // pass through to the svelte:window onkeydown listener untouched.
  $effect(() => {
    keyboard.register('Ctrl+L', () => { showChannelDirectory = true; }, {
      description: 'Open channel directory',
    });
    keyboard.register('Ctrl+N', () => { showChannelModal = true; }, {
      description: 'Create channel',
    });
    keyboard.register('Ctrl+J', () => {
      quickJoinValue = '';
      quickJoinError = '';
      showQuickJoin = true;
    }, { description: 'Quick-join channel' });
    keyboard.register('Ctrl+W', () => {
      const active = store.activeChannel;
      if (active) {
        // Fire-and-forget — leaveChannel returns {done, cancel} but the
        // 15s undo lives in the store; we just kick it off and let any
        // future toast wire surface the undo affordance.
        const handle = store.leaveChannel(active);
        if (handle && typeof handle.done?.catch === 'function') {
          handle.done.catch(() => {
            // swallow — store has its own error surfaces.
          });
        }
      }
    }, { description: 'Leave current channel' });
    keyboard.register('Ctrl+Shift+W', () => {
      // Fallback for browsers that hijack Ctrl+W (closes tab). Same
      // behaviour as Ctrl+W above; users discover the variant from the
      // help overlay.
      const active = store.activeChannel;
      if (active) {
        const handle = store.leaveChannel(active);
        if (handle && typeof handle.done?.catch === 'function') {
          handle.done.catch(() => {});
        }
      }
    }, { description: 'Leave current channel (fallback if browser hijacks Ctrl+W)' });
    keyboard.register('?', () => { showKeyboardHelp = true; }, {
      description: 'Show this help overlay',
    });
    for (let i = 1; i <= 9; i++) {
      const idx = i - 1;
      keyboard.register(`Alt+${i}`, () => {
        const list = store.activeChannels;
        const target = Array.isArray(list) ? list[idx] : null;
        if (target?.id) {
          store.switchChannel(target.id);
        }
      }, { description: `Jump to channel #${i} in Active section` });
    }

    return () => {
      keyboard.unregister('Ctrl+L');
      keyboard.unregister('Ctrl+N');
      keyboard.unregister('Ctrl+J');
      keyboard.unregister('Ctrl+W');
      keyboard.unregister('Ctrl+Shift+W');
      keyboard.unregister('?');
      for (let i = 1; i <= 9; i++) {
        keyboard.unregister(`Alt+${i}`);
      }
    };
  });

  // Snapshot of the registry's description map for the help overlay.
  // The overlay renders this list in registration order so the bindings
  // surface in a stable, scan-friendly order regardless of internal
  // object-key ordering.
  let keyboardHelpEntries = $derived(
    Object.entries(keyboard.descriptions).map(([combo, label]) => ({
      combo,
      label,
    })),
  );

  async function submitQuickJoin() {
    const value = (quickJoinValue || '').trim();
    if (!value) {
      quickJoinError = 'Enter a channel name or ID.';
      return;
    }
    quickJoinError = '';
    const result = await store.joinChannel(value);
    if (result && result.success === false) {
      quickJoinError = result.error || 'Could not join channel.';
      return;
    }
    showQuickJoin = false;
    quickJoinValue = '';
    store.switchChannel(value);
  }

  function cancelQuickJoin() {
    showQuickJoin = false;
    quickJoinValue = '';
    quickJoinError = '';
  }

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
    // help > quick-join > directory > modal > context menu > emoji > ...
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (showKeyboardHelp) {
        showKeyboardHelp = false;
      } else if (showQuickJoin) {
        cancelQuickJoin();
      } else if (showChannelDirectory) {
        showChannelDirectory = false;
      } else if (showMobileSidebar) {
        showMobileSidebar = false;
      } else if (showChannelModal) {
        showChannelModal = false;
      } else if (contextMenu.show) {
        handleCloseContextMenu();
      } else if (showEmojiPicker) {
        showEmojiPicker = false;
        emojiPickerTarget = null;
      } else if (showProfileCard) {
        showProfileCard = false;
      } else if (showUserProfileView) {
        showUserProfileView = false;
        userProfileTarget = null;
      } else if (showPinnedPanel) {
        showPinnedPanel = false;
      } else if (showSettingsPanel) {
        showSettingsPanel = false;
      } else if (showArtifactPanel) {
        showArtifactPanel = false;
      } else if (showConversationBrowser) {
        showConversationBrowser = false;
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
  let lastNotifiedId = $state(null);
  $effect(() => {
    const msgs = store.messages;
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last.id === lastNotifiedId) return;
    lastNotifiedId = last.id;
    if (last.sender.key !== store.userProfile.key) {
      sendNotification(last.sender.name, {
        body: last.body.slice(0, 100),
        tag: last.id
      });

      // In-app toast (skip if toasts disabled or channel is muted)
      if (last.channel !== store.activeChannel || document.hidden) {
        const ch = store.channels.find(c => c.id === last.channel);
        if (store.inAppToasts && !(ch && ch.muted)) {
          addToast({
            id: last.id,
            sender: last.sender,
            channel: last.channel,
            text: last.body.slice(0, 120)
          });
        }
      }
    }
  });

  // ── Toast cap + coalesce (UX G-14) ─────────────────────────────────────
  //
  // The visible toast stack is capped at TOAST_CAP (3). When a new toast
  // arrives and there are already TOAST_CAP toasts visible:
  //
  //   1. If at least one existing visible toast is from the SAME channel,
  //      we coalesce: replace that toast's body with "<sender> and N
  //      others sent messages" (`coalescedCount` tracks N+1 — i.e. the
  //      total events folded into this single toast).
  //
  //   2. If the same channel already has a coalesced toast and reaches 5+
  //      coalesced events, we collapse to a single pill: "+N new in
  //      #channel". The pill stays under the cap and keeps click-routing.
  //
  //   3. If no same-channel toast exists in the visible set, the new
  //      toast displaces the OLDEST visible toast (FIFO). This keeps the
  //      cap honest without ever losing newer cross-channel events.
  //
  // The 5-second self-destruct timer is per-toast and resets on every
  // coalesce so the latest event stays visible for a full window.
  const TOAST_CAP = 3;
  const COALESCE_TO_PILL_AT = 5;
  // Per-toast timeout handles, keyed by toast id. Stored outside `toasts`
  // so the reactive array stays serialisable.
  const toastTimers = new Map();

  function scheduleToastExpiry(id) {
    const existing = toastTimers.get(id);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      toastTimers.delete(id);
      toasts = toasts.filter(t => t.id !== id);
    }, 5000);
    toastTimers.set(id, handle);
  }

  function clearToastTimer(id) {
    const handle = toastTimers.get(id);
    if (handle) {
      clearTimeout(handle);
      toastTimers.delete(id);
    }
  }

  function addToast(toast) {
    // Look for an existing visible toast from the same channel.
    const sameChannelIdx = toasts.findIndex(t => t.channel === toast.channel);

    if (sameChannelIdx >= 0) {
      // Coalesce path. The pre-existing toast in the stack absorbs the new
      // event — we keep its id (so timers stay attached) but rewrite the
      // body to reflect the new aggregate.
      const existing = toasts[sameChannelIdx];
      const coalescedCount = (existing.coalescedCount ?? 1) + 1;

      if (coalescedCount >= COALESCE_TO_PILL_AT) {
        // Promote to compact pill.
        const updated = {
          ...existing,
          pill: true,
          coalescedCount,
          sender: existing.sender, // keep for color/initials fallback
          text: `+${coalescedCount} new in #${toast.channel}`,
          messageId: toast.messageId ?? existing.messageId,
        };
        toasts = toasts.map((t, i) => (i === sameChannelIdx ? updated : t));
      } else {
        // 2..4 coalesced: render as "<sender> and N others sent messages."
        const others = coalescedCount - 1;
        const updated = {
          ...existing,
          pill: false,
          coalescedCount,
          // Sender shown is the most-recent sender so users see fresh
          // names; preserve the channel routing target.
          sender: toast.sender,
          text: `${toast.sender?.name ?? 'someone'} and ${others} other${others === 1 ? '' : 's'} sent messages`,
          messageId: toast.messageId ?? existing.messageId,
        };
        toasts = toasts.map((t, i) => (i === sameChannelIdx ? updated : t));
      }
      // Reset the 5s window on coalesce so the merged toast stays visible.
      scheduleToastExpiry(existing.id);
      return;
    }

    // No same-channel match. If we're already at the cap, evict the
    // oldest toast (index 0) FIFO.
    let next = toasts;
    if (next.length >= TOAST_CAP) {
      const evicted = next[0];
      clearToastTimer(evicted.id);
      next = next.slice(1);
    }
    const fresh = { ...toast, coalescedCount: 1, pill: false };
    toasts = [...next, fresh];
    scheduleToastExpiry(fresh.id);
  }

  function dismissToast(id) {
    clearToastTimer(id);
    toasts = toasts.filter(t => t.id !== id);
  }

  function handleToastActivate(detail) {
    // UX G-13: clicking a toast routes the user to the source channel.
    // If the store ships a goToMessage helper (and the toast carries a
    // messageId), we call it; otherwise channel-switch alone is the
    // documented contract.
    if (!detail?.channel) return;
    store.switchChannel(detail.channel);
    if (detail.messageId && typeof store.goToMessage === 'function') {
      store.goToMessage(detail.messageId);
    }
  }

  // ── Set-your-name banner (UX G-43 follow-up) ───────────────────────────
  //
  // When `store.nameUnset === true` (i.e. neither /api/identity nor
  // localStorage produced a real name), we surface a one-line banner that
  // links to the Settings panel. The banner is dismissible; the dismissal
  // is remembered across reloads via localStorage so a returning user
  // who chose to ignore the prompt isn't nagged.
  const NAME_BANNER_DISMISSED_KEY = 'claude-comms.nameBanner.dismissed';
  // Read persisted dismissal synchronously at module init (no $effect needed
  // — localStorage isn't reactive, so a one-shot read is the right pattern).
  // SSR-safe via typeof guard; jsdom and browser both reach the read branch.
  function readDismissed() {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(NAME_BANNER_DISMISSED_KEY) === '1';
      }
    } catch {
      // localStorage unavailable — fall through.
    }
    return false;
  }
  let dismissedNameBanner = $state(readDismissed());

  function dismissNameBanner() {
    dismissedNameBanner = true;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(NAME_BANNER_DISMISSED_KEY, '1');
      }
    } catch {
      // localStorage write unavailable — banner stays dismissed in-memory.
    }
  }

  function openSettingsFromBanner() {
    showSettingsPanel = true;
  }

  function handleOpenThread(message) {
    threadParent = message;
    showThreadPanel = true;
    showSearchPanel = false;
    // Acknowledge the thread's existing replies — clears the chip's unread
    // accent, mirrors how switching to a channel clears its unread count.
    store?.markThreadSeen?.(message.id);
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
      forwardTarget = message;
      showForwardPicker = true;
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
  <div class="sidebar-mobile-wrapper" class:open={showMobileSidebar}>
    {#if showMobileSidebar}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="sidebar-mobile-backdrop" onclick={() => showMobileSidebar = false}></div>
    {/if}
    <Sidebar
      {store}
      onCreateChannel={() => showChannelModal = true}
      onBrowseChannels={() => showChannelDirectory = true}
      onShowProfile={handleShowProfile}
      onOpenSettings={() => showSettingsPanel = !showSettingsPanel}
      onStarToggle={(channelId) => store.toggleStar(channelId)}
    />
  </div>

  <main class="center">
    <ConnectionStatus
      connected={store.connected}
      onlineCount={store.onlineCount}
      error={store.connectionError}
      onRetry={() => store.connect()}
    />

    {#if store.parseFailureRate >= 5}
      <div class="parse-failure-banner" role="alert" data-testid="parse-failure-banner">
        <span class="parse-failure-icon">⚠</span>
        <span class="parse-failure-text">
          Message decoding errors detected ({store.parseFailureRate} in the last 30s).
          Open DevTools console for diagnostic details
          (search for <code>[claude-comms] MQTT message parse failed</code>).
        </span>
      </div>
    {/if}

    <!--
      v0.4.0 Step 2.6 — server-unreachable banner. Surfaces when the
      ``/api/conversations`` bootstrap (Step 2.5) failed (404/500/network)
      so the user understands why the sidebar is empty. Cleared
      automatically by the store on the next successful bootstrap (e.g.
      after MQTT reconnect re-fires the helper).
    -->
    {#if store.serverUnreachable}
      <div class="parse-failure-banner" role="alert" data-testid="server-unreachable-banner">
        <span class="parse-failure-icon">⚠</span>
        <span class="parse-failure-text">
          Server unreachable — channels unavailable. The page will refresh
          the channel list once the daemon comes back online.
        </span>
      </div>
    {/if}

    <!--
      Set-your-name banner (UX G-43 follow-up). Surfaces ONLY when the
      store reports `nameUnset === true` and the user hasn't dismissed.
      Dismissal is persisted in localStorage so returning users aren't
      nagged. Once a name is saved (anywhere), the store flips
      `nameUnset` false and this banner disappears regardless of
      dismissal state.
    -->
    {#if store.nameUnset && !dismissedNameBanner}
      <div class="name-unset-banner" role="status" data-testid="name-unset-banner">
        <span class="name-unset-text">
          Set a display name so others can recognize you.
        </span>
        <button
          type="button"
          class="name-unset-action"
          data-testid="name-unset-open-settings"
          onclick={openSettingsFromBanner}
        >→ Open settings</button>
        <button
          type="button"
          class="name-unset-dismiss"
          data-testid="name-unset-dismiss"
          aria-label="Dismiss set-your-name banner"
          onclick={dismissNameBanner}
        >&times;</button>
      </div>
    {/if}

    <header class="chat-header" data-testid="chat-header">
      <button class="mobile-menu-btn" type="button" data-testid="mobile-menu-btn" onclick={() => showMobileSidebar = !showMobileSidebar} aria-label="Open sidebar menu">
        <Menu size={20} strokeWidth={2} />
      </button>
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
        <button class="header-btn" title="Artifacts" onclick={() => showArtifactPanel = !showArtifactPanel} data-testid="header-artifacts-btn">
          <FileText size={16} strokeWidth={2} />
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
      onRetryMessage={(messageId) => store.retryMessage(messageId)}
      {store}
    />

    {#if showThreadPanel && threadParent}
      <ThreadPanel
        parentMessage={threadParent}
        messages={store.activeChannelReplies.filter(m => m.reply_to === threadParent.id)}
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
        onToggleTheme={toggleTheme}
      />
    {/if}

    {#if showArtifactPanel}
      <ArtifactPanel
        {store}
        onClose={() => showArtifactPanel = false}
      />
    {/if}

    {#if showConversationBrowser}
      <ConversationBrowser
        {store}
        onClose={() => showConversationBrowser = false}
        onJoinChannel={(name) => {
          store.switchChannel(name);
          showConversationBrowser = false;
        }}
      />
    {/if}

    {#if showUserProfileView && userProfileTarget}
      <UserProfileView
        participant={userProfileTarget}
        onClose={() => { showUserProfileView = false; userProfileTarget = null; }}
        onSendMessage={(p) => {
          // Plan §11 Phase C R2-C3: store-mediated prefill replaces
          // querySelector + synthetic-event approach. MessageInput's
          // $effect picks this up and splices into inputValue cleanly.
          showUserProfileView = false;
          userProfileTarget = null;
          store.composerPrefill = `/dm @${p.name} `;
        }}
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
    <!--
      v0.3.2: bind the store derivations directly. The previous version
      kept a 500ms setInterval snapshot pump (a Svelte 5 anti-pattern for
      state sync — flagged by svelte-autofixer). The store's
      `activeMembers` / `onlineElsewhere` / `offlineParticipants` are
      already `$derived.by()`, so Svelte's reactivity handles propagation
      without an explicit pump; this also fixes the "channelMembers
      churn doesn't trigger re-render" issue since the derivations read
      that state and recompute when it mutates.
    -->
    <MemberList
      active={store.activeMembers}
      onlineElsewhere={store.onlineElsewhere}
      offline={store.offlineParticipants}
      activeChannelName={store.activeChannel}
      getMemberConversations={(key) => store.getMemberConversations(key)}
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
    onMessage={(p) => {
      // Plan §11 Phase C R2-C3: store-mediated prefill replaces
      // querySelector + synthetic-event approach. MessageInput's
      // $effect picks this up and splices into inputValue cleanly.
      showProfileCard = false;
      store.composerPrefill = `/dm @${p.name} `;
    }}
    onViewProfile={(p) => {
      showProfileCard = false;
      if (p.key === store.userProfile?.key) {
        // Viewing own profile — open settings panel
        showSettingsPanel = true;
      } else {
        // Viewing someone else — open user profile view
        userProfileTarget = p;
        showUserProfileView = true;
      }
    }}
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

{#if showForwardPicker && forwardTarget}
  <ForwardPicker
    channels={store.channels}
    currentChannel={store.activeChannel}
    onSelect={(channelId) => {
      store.forwardMessage(forwardTarget, channelId);
      showForwardPicker = false;
      forwardTarget = null;
      addToast({ id: 'fwd-' + Date.now(), sender: { name: 'System', key: 'system', type: 'system' }, channel: store.activeChannel, text: `Message forwarded to #${channelId}` });
    }}
    onClose={() => { showForwardPicker = false; forwardTarget = null; }}
  />
{/if}

{#if showChannelDirectory}
  <ChannelDirectoryModal
    {store}
    bind:open={showChannelDirectory}
    onClose={() => { showChannelDirectory = false; }}
    onChannelClick={(channelId) => {
      store.switchChannel(channelId);
      showChannelDirectory = false;
    }}
    onChannelJoin={(channelId) => store.joinChannel(channelId)}
  />
{/if}

{#if showQuickJoin}
  <!-- v0.4.0 Step 2.17 — Ctrl+J quick-join prompt. Minimal inline dialog
       (single text input + submit). Escape closes via the global priority
       cascade; submit calls store.joinChannel(value). -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="quick-join-backdrop"
    data-testid="quick-join-backdrop"
    onclick={(e) => { if (e.target === e.currentTarget) cancelQuickJoin(); }}
  >
    <div
      class="quick-join-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Quick join channel"
      data-testid="quick-join-dialog"
    >
      <label class="quick-join-label" for="quick-join-input">Channel name or ID:</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="quick-join-input"
        class="quick-join-input"
        type="text"
        bind:value={quickJoinValue}
        data-testid="quick-join-input"
        autofocus
        autocomplete="off"
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitQuickJoin();
          }
        }}
      />
      {#if quickJoinError}
        <p class="quick-join-error" role="alert" data-testid="quick-join-error">
          {quickJoinError}
        </p>
      {/if}
      <div class="quick-join-actions">
        <button
          type="button"
          class="quick-join-btn secondary"
          data-testid="quick-join-cancel"
          onclick={cancelQuickJoin}
        >Cancel</button>
        <button
          type="button"
          class="quick-join-btn primary"
          data-testid="quick-join-submit"
          onclick={submitQuickJoin}
        >Join</button>
      </div>
    </div>
  </div>
{/if}

<KeyboardShortcutsHelp
  bind:open={showKeyboardHelp}
  entries={keyboardHelpEntries}
  onClose={() => { showKeyboardHelp = false; }}
/>

{#each toasts as toast (toast.id)}
  <NotificationToast
    id={toast.id}
    sender={toast.sender}
    channel={toast.channel}
    text={toast.text}
    messageId={toast.messageId}
    pill={toast.pill}
    onActivate={handleToastActivate}
    onDismiss={() => dismissToast(toast.id)}
  />
{/each}

<style>
  /* Surfaced when the MQTT message-parse failure rate crosses 5 per 30s.
   * Always sits below the connection-status row; never blocks the chat.
   * Tone: warning, not error — most parse failures are recoverable noise
   * but the user should know to check DevTools. */
  .parse-failure-banner {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 8px 16px 0;
    padding: 8px 12px;
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.25);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-secondary, #a8a098);
  }
  .parse-failure-icon {
    color: var(--ember-400, #f59e0b);
    font-size: 14px;
    line-height: 1;
    flex-shrink: 0;
    padding-top: 1px;
  }
  .parse-failure-text code {
    background: rgba(0, 0, 0, 0.25);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: 'SF Mono', 'JetBrains Mono', Consolas, monospace;
    font-size: 11px;
  }

  /* Set-your-name banner. Sits at the top of the main pane above
   * chat-header when `store.nameUnset` is true. Subtle ember accent
   * (matches v0.3 design system); dismissible via the right-side close.
   */
  .name-unset-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 8px 16px 0;
    padding: 8px 12px;
    background: var(--bg-elevated, var(--surface-elevated, #1f1c19));
    border: 1px solid var(--border);
    border-left: 3px solid var(--ember-400, #f59e0b);
    border-radius: 8px;
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-secondary, #a8a098);
  }
  .name-unset-text { flex: 1; min-width: 0; }
  .name-unset-action {
    background: none;
    border: none;
    color: var(--ember-300, #fbbf24);
    cursor: pointer;
    font: inherit;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
    transition: var(--transition-fast);
  }
  .name-unset-action:hover {
    background: var(--bg-surface);
    color: var(--ember-200, #fde68a);
  }
  .name-unset-action:focus-visible {
    outline: 2px solid var(--ember-400);
    outline-offset: 2px;
  }
  .name-unset-dismiss {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
    transition: var(--transition-fast);
  }
  .name-unset-dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

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

  .header-members :global(svg) { opacity: 0.7; }

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

  /* ── Mobile menu button ── */
  .mobile-menu-btn {
    display: none;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    flex-shrink: 0;
  }

  .mobile-menu-btn:hover {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  /* ── Mobile sidebar wrapper ── */
  .sidebar-mobile-wrapper {
    display: contents;
  }

  .sidebar-mobile-backdrop {
    display: none;
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

    .mobile-menu-btn {
      display: flex;
    }

    .sidebar-mobile-wrapper {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 100%;
      z-index: 200;
      pointer-events: none;
    }

    .sidebar-mobile-wrapper.open {
      width: 100%;
      pointer-events: auto;
    }

    .sidebar-mobile-wrapper :global(.sidebar-left) {
      display: flex !important;
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 268px;
      min-width: 268px;
      z-index: 202;
      transform: translateX(-100%);
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: none;
    }

    .sidebar-mobile-wrapper.open :global(.sidebar-left) {
      transform: translateX(0);
      box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5);
    }

    .sidebar-mobile-backdrop {
      display: block;
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 201;
      animation: overlayIn 0.2s ease;
    }
  }

  /* v0.4.0 Step 2.17 — Ctrl+J quick-join prompt. Matches the heavier
   * ChannelDirectoryModal visual treatment but compressed for a single
   * text input + two action buttons. */
  .quick-join-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9000;
    padding: 24px;
    backdrop-filter: blur(2px);
  }
  .quick-join-dialog {
    background: var(--bg-elevated, var(--surface-elevated, #1f1c19));
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
    width: min(420px, 100%);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .quick-join-label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-secondary, #d3cfc7);
  }
  .quick-join-input {
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-deepest, #14110f);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    color: var(--text-primary, #f4f1ec);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
  }
  .quick-join-input:focus {
    border-color: var(--ember-700);
    box-shadow: 0 0 0 3px var(--border-glow);
  }
  .quick-join-error {
    font-size: 12px;
    color: var(--ember-300, #fbbf24);
    margin: 0;
  }
  .quick-join-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .quick-join-btn {
    padding: 7px 14px;
    border-radius: 6px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-family: inherit;
    transition: var(--transition-fast);
  }
  .quick-join-btn.primary {
    background: var(--ember-600, #d97706);
    color: #fff;
    border-color: var(--ember-600);
  }
  .quick-join-btn.primary:hover {
    background: var(--ember-500, #f59e0b);
    border-color: var(--ember-500);
  }
  .quick-join-btn.secondary:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
</style>
