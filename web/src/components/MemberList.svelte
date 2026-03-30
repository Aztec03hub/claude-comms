<!--
  @component MemberList
  @description Right sidebar panel displaying online and offline channel members with avatars, role badges (Admin/Agent), typing indicators, and a search filter. Clicking a member opens their profile card.
  @prop {Array} online - Array of online member objects with name, key, type, and client fields.
  @prop {Array} offline - Array of offline member objects.
  @prop {object} typingUsers - Map of participant keys to typing state objects ({ typing: boolean }).
  @prop {Function} onShowProfile - Callback invoked with a member object to display their profile.
-->
<script>
  import { Search } from 'lucide-svelte';
  import { getInitials, getParticipantColor } from '../lib/utils.js';

  let { online = [], offline = [], typingUsers = {}, onShowProfile } = $props();

  let showSearch = $state(false);
  let searchQuery = $state('');

  let filteredOnline = $derived(
    searchQuery ? online.filter(m => m.name.toLowerCase().includes(searchQuery.toLowerCase())) : online
  );
  let filteredOffline = $derived(
    searchQuery ? offline.filter(m => m.name.toLowerCase().includes(searchQuery.toLowerCase())) : offline
  );
</script>

<aside class="sidebar-right" data-testid="member-list">
  <div class="members-header">
    <span>Members ({online.length + offline.length})</span>
    <button class="members-search-btn" title="Search members" data-testid="members-search-btn" onclick={() => { showSearch = !showSearch; if (!showSearch) searchQuery = ''; }}>
      <Search size={12} />
    </button>
  </div>

  {#if showSearch}
    <div class="members-search-bar">
      <input
        class="members-search-input"
        type="text"
        placeholder="Search members..."
        bind:value={searchQuery}
        data-testid="members-search-input"
      />
    </div>
  {/if}

  {#if filteredOnline.length > 0}
    <div class="members-section" data-testid="members-online-section">Online ({filteredOnline.length})</div>
    <div class="members-list">
      {#each filteredOnline as member (member.key + '-' + (member.client || 'unknown'))}
        {@const color = getParticipantColor(member.key)}
        {@const isTyping = typingUsers[member.key]?.typing}
        <div
          class="member"
          onclick={() => onShowProfile(member)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onShowProfile(member); }}
          role="button"
          tabindex="0"
          data-testid="member-{member.key}"
        >
          <div class="member-avatar" style="background: {color.gradient}">
            {getInitials(member.name)}
            <div class="member-dot online"></div>
          </div>
          <div class="member-info">
            <div class="member-name" style="color: {color.textColor}">
              {member.name}
              <span class="member-client">{member.client || 'unknown'}</span>
            </div>
            {#if isTyping}
              <div class="member-typing">
                <div class="member-typing-dots"><span></span><span></span><span></span></div>
                typing...
              </div>
            {:else if member.type === 'human'}
              <span class="member-badge admin">Admin</span>
            {:else}
              <span class="member-badge agent">Agent</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if filteredOffline.length > 0}
    <div class="members-section" style="margin-top: 8px" data-testid="members-offline-section">Offline ({filteredOffline.length})</div>
    <div class="members-list">
      {#each filteredOffline as member (member.key + '-' + (member.client || 'unknown'))}
        <div
          class="member"
          onclick={() => onShowProfile(member)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onShowProfile(member); }}
          role="button"
          tabindex="0"
          data-testid="member-{member.key}"
        >
          <div class="member-avatar" style="background: var(--bg-elevated)">
            {getInitials(member.name)}
            <div class="member-dot offline"></div>
          </div>
          <div class="member-info">
            <div class="member-name" style="color: var(--text-muted)">
              {member.name}
              <span class="member-client">{member.client || 'unknown'}</span>
            </div>
            <span class="member-badge member-tag">Member</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .sidebar-right {
    width: var(--right-w);
    min-width: var(--right-w);
    background: var(--bg-sidebar);
    backdrop-filter: blur(20px);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  @media (max-width: 640px) {
    .sidebar-right {
      display: none;
    }
  }

  .sidebar-right :global(*) {
    transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  .members-header {
    padding: 18px 16px 12px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1.2px;
    color: var(--text-faint);
    text-transform: uppercase;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .members-search-btn {
    width: 22px;
    height: 22px;
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

  .members-search-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-surface);
  }

  .members-search-bar {
    padding: 4px 12px 8px;
    border-bottom: 1px solid var(--border);
  }

  .members-search-input {
    width: 100%;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    transition: var(--transition-fast);
  }

  .members-search-input:focus {
    border-color: var(--ember-600);
    box-shadow: 0 0 0 2px rgba(245,158,11,0.15);
  }

  .members-search-input::placeholder {
    color: var(--text-faint);
  }

  .members-section {
    padding: 10px 16px 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.8px;
    color: var(--text-faint);
    text-transform: uppercase;
  }

  .members-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px;
  }

  .member {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: var(--transition-fast);
  }

  .member:hover { background: var(--bg-surface); }

  .member:hover .member-avatar {
    box-shadow: 0 0 0 2px var(--bg-sidebar), 0 0 0 3px currentColor;
    transition: box-shadow var(--transition-fast);
  }

  .member:focus-visible {
    box-shadow: 0 0 0 2px rgba(245,158,11,0.3);
  }

  .member-avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: #0a0a0c;
    position: relative;
  }

  .member-dot {
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 2px solid var(--bg-sidebar);
    transition: var(--transition-med);
  }

  .member-dot.online {
    background: var(--ember-400);
    box-shadow: 0 0 6px rgba(245,158,11,0.35);
  }

  .member-dot.offline { background: var(--text-faint); }

  .member-info { display: flex; flex-direction: column; }
  .member-name { font-size: 13px; font-weight: 500; display: flex; align-items: baseline; gap: 4px; }

  .member-client {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: lowercase;
    background: var(--bg-surface);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }

  .member-badge {
    font-size: 9px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .member-badge.admin {
    background: rgba(245,158,11,0.12);
    color: var(--ember-400);
    border: 1px solid rgba(245,158,11,0.2);
  }

  .member-badge.agent {
    background: rgba(52,211,153,0.1);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.15);
  }

  .member-badge.member-tag {
    background: var(--bg-surface);
    color: var(--text-faint);
    border: 1px solid var(--border);
  }

  .member-typing {
    font-size: 9px;
    color: var(--ember-500);
    font-style: italic;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .member-typing-dots {
    display: flex;
    gap: 2px;
  }

  .member-typing-dots span {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--ember-500);
    animation: dotPulse 1.4s ease-in-out infinite;
  }

  .member-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
  .member-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
</style>
