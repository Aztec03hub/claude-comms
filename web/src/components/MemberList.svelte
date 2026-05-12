<!--
  @component MemberList
  @description Right sidebar panel displaying online and offline channel members with avatars,
  role badges (Admin/Agent), connection type icons, typing indicators, and a search filter.
  Each user appears once, with connection icons showing how they are connected.
  @prop {Array} online - Array of online member objects with name, key, type, and connections fields.
  @prop {Array} offline - Array of offline member objects.
  @prop {object} typingUsers - Map of participant keys to typing state objects ({ typing: boolean }).
  @prop {Function} onShowProfile - Callback invoked with a member object to display their profile.
-->
<script>
  import { Search, Globe, Monitor, Plug, Terminal, Link } from 'lucide-svelte';
  import { getInitials, getParticipantColor } from '../lib/utils.js';

  let {
    /** Members of the currently-viewed channel who are online. */
    active = [],
    /** Online globally but NOT joined to the currently-viewed channel.
     *  v0.3.2 — the new "Online (elsewhere)" section. */
    onlineElsewhere = [],
    /** Known participants with no live connections. */
    offline = [],
    /** Currently-viewed channel id, used in the "In #X" section header. */
    activeChannelName = 'general',
    /** ``(key) => string[]`` — channels this key is a member of, excluding
     *  activeChannelName. Used for the "in #X +N more" inline location chip. */
    getMemberConversations = () => [],
    typingUsers = {},
    onShowProfile,
  } = $props();

  // Per-section disclosure widgets. M-FIX (v0.3.3): Phil's hard constraint —
  // all three section headers (Active / Online elsewhere / Offline) always
  // render with their chevron + count, regardless of row counts. Sections are
  // stable UI surfaces; their existence is never gated on data. Body
  // collapse state persists per-section in localStorage.
  //
  // Storage keys (v0.3.3):
  //   claude-comms.memberListActiveExpanded          default true
  //   claude-comms.memberListOnlineElsewhereExpanded default true
  //   claude-comms.memberListOfflineExpanded         default false
  //
  // Migration: v0.3.2 shipped only an offline toggle under the legacy key
  // ``claude-comms.offlineExpanded``. On first read we copy that value into
  // ``claude-comms.memberListOfflineExpanded`` (if not already set) and
  // delete the legacy key, so existing users keep their preference.
  const STORAGE_KEYS = {
    active: 'claude-comms.memberListActiveExpanded',
    onlineElsewhere: 'claude-comms.memberListOnlineElsewhereExpanded',
    offline: 'claude-comms.memberListOfflineExpanded',
  };
  const LEGACY_OFFLINE_KEY = 'claude-comms.offlineExpanded';

  /**
   * Read a boolean-as-"1"/"0" flag from localStorage with a fallback when
   * the key is absent or storage is unavailable (SSR / privacy mode).
   */
  function readStoredBool(key, fallback) {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  }

  /**
   * One-shot migration of the legacy ``claude-comms.offlineExpanded`` key
   * onto the new namespaced key. Idempotent: a second call is a no-op.
   */
  function migrateLegacyOfflineKey() {
    if (typeof localStorage === 'undefined') return;
    const legacy = localStorage.getItem(LEGACY_OFFLINE_KEY);
    if (legacy === null) return;
    // Only copy if the new key hasn't been set already — never clobber
    // a fresh preference written under the new name.
    if (localStorage.getItem(STORAGE_KEYS.offline) === null) {
      localStorage.setItem(STORAGE_KEYS.offline, legacy);
    }
    localStorage.removeItem(LEGACY_OFFLINE_KEY);
  }

  migrateLegacyOfflineKey();

  let activeExpanded = $state(readStoredBool(STORAGE_KEYS.active, true));
  let onlineElsewhereExpanded = $state(
    readStoredBool(STORAGE_KEYS.onlineElsewhere, true),
  );
  let offlineExpanded = $state(readStoredBool(STORAGE_KEYS.offline, false));

  $effect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.active, activeExpanded ? '1' : '0');
    }
  });
  $effect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        STORAGE_KEYS.onlineElsewhere,
        onlineElsewhereExpanded ? '1' : '0',
      );
    }
  });
  $effect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.offline, offlineExpanded ? '1' : '0');
    }
  });

  /** Relative "last seen 4m ago" for offline rows. ``lastOffline`` is set
   *  by the store when the participant's last connection drops. */
  function lastSeenRelative(p) {
    if (!p.lastOffline) return '';
    const then = Date.parse(p.lastOffline);
    if (Number.isNaN(then)) return '';
    const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return `last seen ${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `last seen ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `last seen ${hours}h ago`;
    const days = Math.round(hours / 24);
    return `last seen ${days}d ago`;
  }

  let showSearch = $state(false);
  let searchQuery = $state('');

  const CONNECTION_ICONS = {
    web: Globe,
    tui: Monitor,
    mcp: Plug,
    cli: Terminal,
    api: Link,
  };

  const CONNECTION_LABELS = {
    web: 'Web UI',
    tui: 'Terminal',
    mcp: 'MCP',
    cli: 'CLI',
    api: 'API',
  };

  function getClientTypes(member) {
    if (!member.connections || typeof member.connections !== 'object') return [];
    return [...new Set(Object.values(member.connections).map(c => c.client))];
  }

  /**
   * Return the most-recently-set, non-expired activity across a member's
   * connections, or null if none. Activity shape (per richer-expression v4):
   *   {label: string, set_at: ISO8601, expires_at: ISO8601}
   */
  function getActivity(member) {
    if (!member.connections || typeof member.connections !== 'object') return null;
    const now = Date.now();
    let best = null;
    for (const conn of Object.values(member.connections)) {
      const a = conn?.activity;
      if (!a || typeof a.label !== 'string') continue;
      if (a.expires_at) {
        const t = Date.parse(a.expires_at);
        if (!Number.isNaN(t) && t < now) continue;
      }
      const setAt = Date.parse(a.set_at || '');
      if (!best || (Number.isFinite(setAt) && setAt > best._setAt)) {
        best = { label: a.label, _setAt: Number.isFinite(setAt) ? setAt : 0 };
      }
    }
    return best ? best.label : null;
  }

  // ``(m.name || '')`` guards against `m.name` being null / undefined —
  // the store records raw MQTT presence ``msg.name`` without defaulting,
  // so a malformed publish (or a partially-rehydrated participant) can
  // surface here with no name. ``.toLowerCase()`` on undefined throws.
  let filteredActive = $derived(
    searchQuery
      ? active.filter((m) => (m.name || '').toLowerCase().includes(searchQuery.toLowerCase()))
      : active,
  );
  let filteredOnlineElsewhere = $derived(
    searchQuery
      ? onlineElsewhere.filter((m) =>
          (m.name || '').toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : onlineElsewhere,
  );
  let filteredOffline = $derived(
    searchQuery
      ? offline.filter((m) => (m.name || '').toLowerCase().includes(searchQuery.toLowerCase()))
      : offline,
  );
  let totalMembers = $derived(
    active.length + onlineElsewhere.length + offline.length,
  );
</script>

{#snippet onlineRow(member, showLocation)}
  {@const color = getParticipantColor(member.key)}
  {@const isTyping = typingUsers[member.key]?.typing}
  {@const clientTypes = getClientTypes(member)}
  {@const activityLabel = getActivity(member)}
  {@const memberConvs = showLocation ? getMemberConversations(member.key) : []}
  {@const firstConv = memberConvs[0] || null}
  {@const extraCount = Math.max(0, memberConvs.length - 1)}
  <div
    class="member"
    onclick={() => onShowProfile(member)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') onShowProfile(member);
    }}
    role="button"
    tabindex="0"
    data-testid="member-{member.key}"
  >
    <div class="member-avatar" style="background: {color.gradient}">
      {getInitials(member.name)}
      <div class="member-dot online"></div>
    </div>
    <div class="member-info">
      <div class="member-name" style="color: {color.textColor}">{member.name}</div>
      <div class="member-meta">
        {#if member.type === 'human'}
          <span class="member-badge admin">Admin</span>
        {:else}
          <span
            class="member-badge agent"
            class:working={isTyping || !!activityLabel}
            title={isTyping || activityLabel ? 'Working' : 'Ready'}>Agent</span>
        {/if}
        {#if clientTypes.length > 0}
          <div class="connection-icons">
            {#each clientTypes as clientType (clientType)}
              {#if CONNECTION_ICONS[clientType]}
                {@const IconComponent = CONNECTION_ICONS[clientType]}
                <span class="connection-icon" title="Connected via {CONNECTION_LABELS[clientType] || clientType}">
                  <IconComponent size={11} />
                </span>
              {/if}
            {/each}
          </div>
        {/if}
        {#if isTyping}
          <span class="member-activity-inline typing" data-testid="member-typing-{member.key}">
            <span class="member-typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
            <span class="member-activity-text">typing</span>
          </span>
        {:else if activityLabel}
          <span class="member-activity-inline" data-testid="member-activity-{member.key}" title={activityLabel}>
            <span class="member-activity-text">{activityLabel}</span>
          </span>
        {/if}
      </div>
      {#if showLocation && firstConv}
        {@const tooltipText = memberConvs.length > 1
          ? `Also in:\n${memberConvs.map(c => '#' + c).join('\n')}`
          : ''}
        <div class="member-location" title={tooltipText} data-testid="member-location-{member.key}">
          in <span class="member-location-chan">#{firstConv}</span>{#if extraCount > 0}
            <span class="member-location-more">+{extraCount} more</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<aside class="sidebar-right" data-testid="member-list">
  <div class="members-header">
    <span>Members ({totalMembers})</span>
    <button
      class="members-search-btn"
      title="Search members"
      data-testid="members-search-btn"
      onclick={() => {
        showSearch = !showSearch;
        if (!showSearch) searchQuery = '';
      }}
    >
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

  <!--
    M-FIX (v0.3.3): all three section headers ALWAYS render, regardless of
    count. Headers are buttons with chevron + aria-expanded; the body region
    is owned by aria-controls={bodyId}. When a section is empty, an inline
    muted empty-state line stands in for the rows so the section still feels
    inhabited. When collapsed, the body region is omitted from the DOM so
    screen readers don't announce stale content.
  -->

  <!-- Active members in the current channel. -->
  <button
    class="members-section members-section-button"
    data-testid="members-active-section"
    onclick={() => (activeExpanded = !activeExpanded)}
    aria-expanded={activeExpanded}
    aria-controls="members-active-body"
  >
    <span
      class="members-section-chevron"
      class:expanded={activeExpanded}
      aria-hidden="true"
    >▶</span>
    <span class="members-section-label">In #{activeChannelName}</span>
    <span class="members-section-count" data-testid="members-active-count">
      {filteredActive.length}
    </span>
  </button>
  {#if activeExpanded}
    <div
      class="members-list"
      id="members-active-body"
      data-testid="members-active-body"
    >
      {#if filteredActive.length === 0}
        <div
          class="members-empty"
          data-testid="members-active-empty"
        >No one is here yet. Invite someone.</div>
      {:else}
        {#each filteredActive as member (member.key)}
          {@render onlineRow(member, false)}
        {/each}
      {/if}
    </div>
  {/if}

  <!-- Online elsewhere: online globally, not joined to the active channel. -->
  <button
    class="members-section members-section-button"
    data-testid="members-online-elsewhere-section"
    onclick={() => (onlineElsewhereExpanded = !onlineElsewhereExpanded)}
    aria-expanded={onlineElsewhereExpanded}
    aria-controls="members-online-elsewhere-body"
  >
    <span
      class="members-section-chevron"
      class:expanded={onlineElsewhereExpanded}
      aria-hidden="true"
    >▶</span>
    <span class="members-section-label">Online elsewhere</span>
    <span
      class="members-section-count"
      data-testid="members-online-elsewhere-count"
    >{filteredOnlineElsewhere.length}</span>
  </button>
  {#if onlineElsewhereExpanded}
    <div
      class="members-list"
      id="members-online-elsewhere-body"
      data-testid="members-online-elsewhere-body"
    >
      {#if filteredOnlineElsewhere.length === 0}
        <div
          class="members-empty"
          data-testid="members-online-elsewhere-empty"
        >No one is online elsewhere</div>
      {:else}
        {#each filteredOnlineElsewhere as member (member.key)}
          {@render onlineRow(member, true)}
        {/each}
      {/if}
    </div>
  {/if}

  <!-- Offline: known participants with no live connection. -->
  <button
    class="members-section members-section-button"
    data-testid="members-offline-section"
    onclick={() => (offlineExpanded = !offlineExpanded)}
    aria-expanded={offlineExpanded}
    aria-controls="members-offline-body"
  >
    <span
      class="members-section-chevron"
      class:expanded={offlineExpanded}
      aria-hidden="true"
    >▶</span>
    <span class="members-section-label">Offline</span>
    <span class="members-section-count" data-testid="members-offline-count">
      {filteredOffline.length}
    </span>
  </button>
  {#if offlineExpanded}
    <div
      class="members-list"
      id="members-offline-body"
      data-testid="members-offline-body"
    >
      {#if filteredOffline.length === 0}
        <div
          class="members-empty"
          data-testid="members-offline-empty"
        >No one offline yet</div>
      {:else}
        {#each filteredOffline as member (member.key)}
          <div
            class="member"
            onclick={() => onShowProfile(member)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onShowProfile(member);
            }}
            role="button"
            tabindex="0"
            data-testid="member-{member.key}"
          >
            <div class="member-avatar" style="background: var(--bg-elevated)">
              {getInitials(member.name)}
              <div class="member-dot offline"></div>
            </div>
            <div class="member-info">
              <div class="member-name" style="color: var(--text-muted)">{member.name}</div>
              <div class="member-meta">
                <span class="member-badge member-tag">Member</span>
                {#if member.lastOffline}
                  <span class="member-lastseen" data-testid="member-lastseen-{member.key}">
                    {lastSeenRelative(member)}
                  </span>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      {/if}
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

  /*
   * Section header button. M-FIX (v0.3.3): all three section headers
   * (Active / Online elsewhere / Offline) use this same button surface;
   * each owns its own chevron + count badge. Visually identical to the
   * legacy static .members-section label except for the chevron, which
   * is the disclosure affordance.
   */
  .members-section-button {
    width: 100%;
    /* Match .members-section padding so headers align with the rest of
       the sidebar — same 10px/16px/4px box, just rendered as a button. */
    padding: 10px 16px 4px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.8px;
    color: var(--text-faint);
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .members-section-button:hover { color: var(--text-secondary); }
  .members-section-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3);
    border-radius: 4px;
  }

  .members-section-label {
    /* Push the count to the far right via auto-margin on the count
       element, so the label hugs the chevron. */
    flex: 0 0 auto;
  }
  .members-section-count {
    margin-left: auto;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    /* Slightly larger than the uppercase letter-spaced label for
       readability of the badge digits. */
    letter-spacing: 0;
  }

  /*
   * Chevron rotates from 0deg (collapsed) to 90deg (expanded). 150ms
   * transition matches the request; honors prefers-reduced-motion below.
   */
  .members-section-chevron {
    font-size: 8px;
    line-height: 1;
    width: 8px;
    display: inline-block;
    transform: rotate(0deg);
    transform-origin: center;
    transition: transform 150ms ease;
  }
  .members-section-chevron.expanded {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .members-section-chevron {
      transition: none;
    }
  }

  /*
   * Empty-state placeholder for a section whose filtered count is 0.
   * Muted, one line, sits in the same .members-list container so the
   * vertical rhythm of the sidebar stays stable whether or not rows
   * are present.
   */
  .members-empty {
    padding: 6px 10px 10px;
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }

  /* "in #X +N more" inline location chip for Online (elsewhere) rows.
     Sits BELOW the member-meta line on a second row, dimmed and small
     to stay subordinate to the name + badge + connection icons. */
  .member-location {
    margin-top: 2px;
    font-size: 10.5px;
    color: var(--text-faint);
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .member-location-chan {
    color: var(--text-secondary);
    font-weight: 500;
  }
  .member-location-more {
    color: var(--text-faint);
    margin-left: 4px;
    font-style: italic;
    cursor: help;  /* tooltip affordance */
  }

  /* "last seen Nm ago" relative-time stamp on Offline rows. */
  .member-lastseen {
    font-size: 10.5px;
    color: var(--text-faint);
    font-style: italic;
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

  .member-info { display: flex; flex-direction: column; min-width: 0; }
  .member-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .member-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  /*
   * Inline activity label (typing.../"working"/etc) shares the meta-row
   * with the type badge and connection icons. The label ellipsizes if it's
   * too long; the badge and icons (flex-shrink: 0) remain visible. Phil's
   * ask: activity must not hide the type badge or connection icon.
   */
  .member-activity-inline {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 9px;
    color: var(--text-secondary);
    font-style: italic;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }

  .member-activity-inline.typing {
    color: var(--ember-500);
  }

  .member-activity-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }


  .connection-icons {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .connection-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    cursor: default;
    opacity: 1;
    transition: opacity 0.3s ease, color 0.2s ease;
    animation: iconFadeIn 0.3s ease forwards;
  }

  .connection-icon:hover {
    color: var(--text-secondary);
  }

  @keyframes iconFadeIn {
    from { opacity: 0; transform: scale(0.8); }
    to { opacity: 1; transform: scale(1); }
  }

  .member-badge {
    font-size: 9px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    flex-shrink: 0;
  }

  .member-badge.admin {
    background: rgba(245,158,11,0.12);
    color: var(--ember-400);
    border: 1px solid rgba(245,158,11,0.2);
  }

  /* Default agent badge: green (ready / waiting for input). */
  .member-badge.agent {
    background: rgba(52,211,153,0.1);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.15);
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
  }

  /*
    Agent badge — working state. Amber to distinguish from the default
    green. Triggered by .working class which is bound to the presence of
    a typing or activity label (see template).
  */
  .member-badge.agent.working {
    background: rgba(245,158,11,0.14);
    color: var(--ember-300);
    border-color: rgba(245,158,11,0.4);
  }

  .member-badge.member-tag {
    background: var(--bg-surface);
    color: var(--text-faint);
    border: 1px solid var(--border);
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
