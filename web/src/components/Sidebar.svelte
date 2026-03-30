<script>
  let { store, onCreateChannel, onShowProfile } = $props();

  let starredCollapsed = $state(false);
  let convoCollapsed = $state(false);

  function handleChannelClick(channelId) {
    store.switchChannel(channelId);
  }

  function handleStarToggle(e, channelId) {
    e.stopPropagation();
    store.toggleStar(channelId);
  }
</script>

<aside class="sidebar-left" data-testid="sidebar">
  <div class="sidebar-brand">
    <div class="brand-icon">CC</div>
    <h1>Claude Comms</h1>
    <span class="brand-version">v0.9</span>
  </div>

  <div class="search-wrap">
    <input class="search-input" type="text" placeholder="Search conversations..." data-testid="sidebar-search">
    <span class="search-kbd">\u2318K</span>
  </div>

  {#if store.starredChannels.length > 0}
    <div class="section-label" class:collapsed={starredCollapsed} data-testid="sidebar-starred-section">
      <span class="star">\u2605</span> Starred
      <button class="arrow" onclick={() => starredCollapsed = !starredCollapsed} aria-label="Toggle starred" data-testid="sidebar-starred-toggle">\u25BE</button>
    </div>
    {#if !starredCollapsed}
      <div class="channel-list" style="flex: none;">
        {#each store.starredChannels as channel (channel.id)}
          <div
            class="channel-item"
            class:active={channel.id === store.activeChannel}
            class:unread={channel.unread > 0}
            onclick={() => handleChannelClick(channel.id)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleChannelClick(channel.id); }}
            role="button"
            tabindex="0"
            data-testid="channel-item-{channel.id}"
          >
            <div class="ch-icon">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2v12M12 2v12M2 6h12M2 10h12"/></svg>
            </div>
            <div class="ch-info">
              <div class="ch-name">{channel.id}</div>
              <div class="ch-preview">{channel.topic || ''}</div>
            </div>
            <div class="ch-meta">
              {#if channel.unread > 0}
                <span class="ch-badge">{channel.unread}</span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="sidebar-divider"></div>
  {/if}

  <div class="section-label" class:collapsed={convoCollapsed} data-testid="sidebar-conversations-section">
    Conversations
    <button class="arrow" onclick={() => convoCollapsed = !convoCollapsed} aria-label="Toggle conversations" data-testid="sidebar-conversations-toggle">\u25BE</button>
  </div>
  {#if !convoCollapsed}
    <div class="channel-list">
      {#each store.channels as channel (channel.id)}
        <div
          class="channel-item"
          class:active={channel.id === store.activeChannel}
          class:unread={channel.unread > 0}
          onclick={() => handleChannelClick(channel.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleChannelClick(channel.id); }}
          role="button"
          tabindex="0"
          data-testid="channel-item-{channel.id}"
        >
          <div class="ch-icon">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2v12M12 2v12M2 6h12M2 10h12"/></svg>
          </div>
          <div class="ch-info">
            <div class="ch-name">{channel.id}</div>
            <div class="ch-preview">{channel.topic || ''}</div>
          </div>
          <div class="ch-meta">
            {#if channel.unread > 0}
              <span class="ch-badge">{channel.unread}</span>
            {/if}
          </div>
          <div class="ch-actions">
            <button class="ch-action-btn" title="Mute" onclick={(e) => e.stopPropagation()}>
              <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 3.5h2l3-2.5v8l-3-2.5H1z"/></svg>
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <button class="create-channel" onclick={onCreateChannel} data-testid="sidebar-create-channel">
    <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v10 M1 6h10"/></svg>
    New Conversation
  </button>

  <div class="user-profile" data-testid="sidebar-user-profile">
    <div
      class="user-avatar-wrap"
      onclick={() => onShowProfile({ key: store.userProfile.key, name: store.userProfile.name, type: store.userProfile.type, status: 'online' })}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onShowProfile({ key: store.userProfile.key, name: store.userProfile.name, type: store.userProfile.type, status: 'online' }); }}
      role="button"
      tabindex="0"
    >
      <div class="user-avatar">{store.userProfile.name.slice(0, 2).toUpperCase()}</div>
      <div class="status-dot"></div>
    </div>
    <div class="user-info">
      <div class="uname">{store.userProfile.name}</div>
      <div class="ustatus">Online</div>
    </div>
    <button class="user-settings" title="User settings">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3m10 0h1.5M3.1 3.1l1 1m7.8 7.8l1 1M12.9 3.1l-1 1M4.1 11.9l-1 1"/></svg>
    </button>
  </div>
</aside>

<style>
  .sidebar-left {
    width: var(--sidebar-w);
    min-width: var(--sidebar-w);
    background: rgba(19, 19, 21, 0.85);
    backdrop-filter: blur(20px);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  .sidebar-left::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 1px;
    background: linear-gradient(180deg, rgba(245,158,11,0.06), transparent 30%, transparent 70%, rgba(245,158,11,0.04));
    pointer-events: none;
  }

  .sidebar-left :global(*) {
    transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  .sidebar-brand {
    padding: 22px 18px 16px;
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .sidebar-brand h1 {
    font-size: 17px;
    font-weight: 800;
    letter-spacing: -0.4px;
    background: linear-gradient(135deg, var(--ember-400), var(--ember-300), var(--gold));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .brand-icon {
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 800;
    color: #0a0a0c;
    box-shadow: 0 2px 8px rgba(245,158,11,0.2), 0 0 0 1px rgba(245,158,11,0.1);
    position: relative;
    overflow: visible;
    animation: brandBreath 4s ease-in-out infinite;
  }

  .brand-icon::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 9px;
    background: linear-gradient(180deg, rgba(255,255,255,0.15), transparent 50%);
    pointer-events: none;
  }

  .brand-icon::before {
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ember-400);
    opacity: 0;
    animation: brandParticle 4s ease-in-out infinite 1s;
  }

  .brand-version {
    font-size: 9px;
    font-weight: 600;
    color: var(--text-faint);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    margin-left: 2px;
    letter-spacing: 0.3px;
  }

  .search-wrap {
    padding: 0 14px 14px;
    position: relative;
  }

  .search-input {
    width: 100%;
    padding: 9px 12px 9px 36px;
    background: var(--bg-deepest);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 12.5px;
    outline: none;
    transition: var(--transition-med);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%234a4540' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='6' cy='6' r='4.5'/%3E%3Cline x1='9.5' y1='9.5' x2='13' y2='13'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: 12px center;
  }

  .search-input::placeholder { color: var(--text-faint); }
  .search-input:focus {
    border-color: var(--ember-700);
    box-shadow: 0 0 0 3px var(--border-glow), 0 0 16px rgba(245,158,11,0.04);
  }

  .search-kbd {
    position: absolute;
    right: 22px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 10px;
    color: var(--text-faint);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-family: 'SF Mono', Consolas, monospace;
    line-height: 1.4;
    pointer-events: none;
  }

  .section-label {
    padding: 8px 18px 6px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1.4px;
    color: var(--text-faint);
    display: flex;
    align-items: center;
    gap: 6px;
    text-transform: uppercase;
  }

  .section-label .star { color: var(--ember-500); font-size: 11px; }

  .section-label .arrow {
    font-size: 8px;
    color: var(--text-faint);
    margin-left: auto;
    transition: var(--transition-fast);
    cursor: pointer;
    user-select: none;
    background: none;
    border: none;
    padding: 2px 4px;
    font-family: inherit;
  }

  .section-label.collapsed .arrow { transform: rotate(-90deg); }

  .channel-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px;
    scroll-behavior: smooth;
  }

  .channel-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 10px;
    margin: 1px 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: var(--transition-fast);
    position: relative;
  }

  .channel-item:hover { background: var(--bg-surface); }

  .channel-item.active {
    background: var(--bg-surface);
    box-shadow: 0 0 16px rgba(245,158,11,0.08), inset 0 0 0 1px rgba(245,158,11,0.1);
  }

  .channel-item.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 55%;
    border-radius: 0 3px 3px 0;
    background: linear-gradient(180deg, var(--ember-400), var(--ember-600));
    box-shadow: 0 0 12px rgba(245,158,11,0.4), 0 0 4px rgba(245,158,11,0.6);
  }

  .channel-item:focus-visible {
    box-shadow: 0 0 0 2px rgba(245,158,11,0.3);
  }

  .ch-icon {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    flex-shrink: 0;
    background: var(--bg-deepest);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: var(--text-faint);
    font-weight: 600;
    border: 1px solid var(--border-subtle);
  }

  .channel-item.active .ch-icon {
    border-color: rgba(245,158,11,0.15);
    color: var(--text-muted);
  }

  .ch-info { flex: 1; min-width: 0; }

  .ch-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.15px;
    transition: var(--transition-fast);
  }

  .channel-item.active .ch-name { color: var(--ember-300); }
  .channel-item.unread .ch-name { color: var(--text-primary); font-weight: 700; }
  .channel-item.unread .ch-preview { color: var(--text-muted); }

  .ch-preview {
    font-size: 11.5px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
  }

  .ch-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    flex-shrink: 0;
  }

  .ch-badge {
    font-size: 10px;
    font-weight: 700;
    color: #0a0a0c;
    background: linear-gradient(135deg, var(--ember-500), var(--ember-400));
    border-radius: 10px;
    padding: 1px 7px;
    min-width: 18px;
    text-align: center;
    box-shadow: 0 0 10px rgba(245,158,11,0.3), 0 0 2px rgba(245,158,11,0.5);
    animation: badgePulse 3s ease-in-out infinite, badgeBounce 0.3s ease both;
  }

  .ch-actions {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 1px;
    opacity: 0;
    transition: opacity var(--transition-fast);
  }

  .channel-item:hover .ch-actions { opacity: 1; }

  .ch-action-btn {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    border: none;
    background: var(--bg-elevated);
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    font-size: 11px;
  }

  .ch-action-btn:hover { color: var(--text-primary); }

  .sidebar-divider {
    height: 1px;
    background: linear-gradient(90deg, transparent 5%, var(--border) 30%, var(--border) 70%, transparent 95%);
    margin: 8px 18px;
  }

  .create-channel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 4px 8px 8px;
    padding: 7px;
    border-radius: var(--radius-sm);
    border: 1px dashed var(--border);
    background: none;
    color: var(--text-faint);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: var(--transition-fast);
    font-family: inherit;
  }

  .create-channel:hover {
    border-color: var(--ember-700);
    border-style: solid;
    color: var(--ember-400);
    background: rgba(245,158,11,0.04);
  }

  .user-profile {
    padding: 14px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    background: linear-gradient(180deg, transparent, rgba(0,0,0,0.15));
  }

  .user-avatar-wrap { position: relative; cursor: pointer; }

  .user-avatar {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    color: #0a0a0c;
  }

  .status-dot {
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #f59e0b;
    border: 2.5px solid var(--bg-sidebar);
    box-shadow: 0 0 6px rgba(245,158,11,0.4);
  }

  .user-info { flex: 1; }
  .user-info .uname { font-size: 13px; font-weight: 600; }
  .user-info .ustatus {
    font-size: 11px;
    color: var(--ember-500);
    text-shadow: 0 0 10px rgba(245,158,11,0.3);
  }

  .user-settings {
    width: 28px;
    height: 28px;
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

  .user-settings:hover {
    background: var(--bg-surface);
    color: var(--text-secondary);
  }

  @media (max-width: 480px) {
    .sidebar-left {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 100;
      box-shadow: 4px 0 24px rgba(0,0,0,0.5);
    }
  }
</style>
