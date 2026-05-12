import mqtt from 'mqtt';
import { generateUUID, generateKey } from './utils.js';
import { API_BASE, apiGet } from './api.js';

// Derive the MQTT broker URL from the current page hostname.
// API origin derivation now lives in lib/api.js (exported as API_BASE);
// this file only handles the WebSocket side, which must be absolute since
// it's a different port regardless of dev/prod.
const _host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const BROKER_URL = `ws://${_host}:9001/mqtt`;
const TOPIC_PREFIX = 'claude-comms';
const TYPING_TTL_MS = 5000;
const BASE_RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;
const BACKOFF_AFTER_ATTEMPTS = 5;
const MAX_MESSAGES = 5000;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_CHANNEL_NAME_LENGTH = 50;
const MAX_DISPLAY_NAME_LENGTH = 50;

/** Allowed connection client types. Unknown types are rejected. */
const CONNECTION_TYPES = ['web', 'tui', 'mcp', 'cli', 'api'];

/** How long a connection can go without a heartbeat before TTL cleanup removes it (ms). */
const CONNECTION_TTL_MS = 120_000;

/** How long an offline user entry is kept for display before removal (ms). */
const OFFLINE_DISPLAY_MS = 5 * 60 * 1000;

/**
 * Safe localStorage wrapper that falls back gracefully
 * when storage is unavailable (private browsing, quota exceeded, etc.).
 */
const safeStorage = {
  getItem(key) {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // localStorage unavailable (private browsing, quota exceeded) -- silently ignore
    }
  }
};

/**
 * MqttChatStore — Svelte 5 runes-based reactive MQTT chat store.
 *
 * Uses $state for mutable reactive fields, $derived for computed values.
 * Connects to amqtt broker via WebSocket and manages all chat state.
 */
export class MqttChatStore {
  // ── Reactive State ──
  messages = $state([]);
  /**
   * Channel list. v0.4.0 S-FIX: no hardcoded seed.
   *
   * Bootstrap path: ``connect()`` invokes ``#bootstrapChannels()`` after the
   * MQTT broker handshake completes. That helper calls
   * ``/api/conversations`` (the daemon's authoritative list per Step 2.1)
   * and maps each row into the store-internal shape used throughout this
   * file. On 0 rows, on 404/500, or on network failure, ``channels``
   * stays empty and ``serverUnreachable`` flips true on failure so the
   * UI can render a banner (consumer wiring deferred to Step 2.6).
   *
   * Field name mapping vs the wire payload (Step 2.1 contract,
   * camelCase ``my``-prefix → unprefixed store-internal):
   *   - ``myUnread`` → ``unread``
   *   - ``myStarred`` → ``starred``
   *   - ``myMuted`` → ``muted``
   * All other fields (``id``, ``name``, ``topic``, ``member``, ...) pass
   * through as-is.
   */
  channels = $state([]);
  activeChannel = $state('general');
  /**
   * Reactive flag indicating the daemon's ``/api/conversations`` endpoint
   * was unreachable during bootstrap. ``true`` when the bootstrap fetch
   * threw or returned non-2xx. Drives a one-line "Server unreachable —
   * channels unavailable" banner in App.svelte (banner wiring lands in
   * Step 2.6's wave per architecture spec §III.4). Resets to ``false`` on
   * a successful subsequent bootstrap (e.g. after reconnect).
   */
  serverUnreachable = $state(false);
  participants = $state({});

  /**
   * Per-channel membership: ``{channelId: { key: lastSeenTs }, ...}``.
   * Populated by two sources:
   *
   * 1. REST poll of ``/api/participants/{channel}`` — the daemon now
   *    returns each member's full ``conversations`` list (v0.3.2+).
   *    On every poll we update entries for every channel each returned
   *    member is a part of.
   * 2. Live MQTT presence — topic ``claude-comms/conv/{conv}/presence/
   *    {key}`` is parsed by ``#handleMessage`` and the conversation
   *    name is passed to ``#handlePresence``, which records the
   *    presence event under ``channelMembers[conv][key]``.
   *
   * Drives the three MemberList sections (``activeMembers``,
   * ``onlineElsewhere``, ``offlineParticipants``) and the
   * "in #X +N more" inline location chip for participants who are
   * online but not joined to the currently-viewed channel.
   *
   * NOT trimmed when a participant leaves a channel (no leave-presence
   * event is published today). Stale entries get corrected on the next
   * REST poll which is authoritative for the active channel; for other
   * channels this is best-effort.
   */
  channelMembers = $state({});
  connected = $state(false);
  connectionError = $state(null);
  typingUsers = $state({});
  pinnedMessages = $state([]);
  inAppToasts = $state(true);
  /**
   * Local user identity. `name` defaults to the sentinel `'(unset)'` rather
   * than any real human name so a fresh web client never silently posts
   * messages under a wrong identity (UX G-43). `connect()` attempts
   * `/api/identity` first; on success the daemon's name replaces this
   * sentinel. If the daemon returns blank/missing, the sentinel survives
   * and `nameUnset` flips true so the UI can surface a banner prompting
   * the user to set a real name (full prompt modal deferred to a later
   * step).
   */
  userProfile = $state({
    key: '',
    name: '(unset)',
    type: 'human'
  });

  /**
   * True iff the local userProfile.name is still the sentinel `(unset)` —
   * i.e. neither `/api/identity` nor localStorage produced a real name.
   * App.svelte reads this to render a one-line "Set your name" banner;
   * once the user picks a name (via Settings or a future onboarding modal)
   * this flips false. Plain $state boolean — App.svelte can subscribe via
   * a `$derived(store.nameUnset)` if it wants.
   */
  nameUnset = $state(true);

  /**
   * Reactive tick counter bumped whenever a chat message carrying an
   * `artifact_ref` lands in the active channel. Consumers (ArtifactPanel)
   * watch this counter inside a `$effect` and debounce their refresh.
   * Bumping here is a no-op coalesce — we do not track which artifact
   * changed, only that *something* did.
   */
  artifactsDirty = $state(0);

  /**
   * Per-thread seen cursors keyed by root message id, value is the latest
   * reply ts the user has acknowledged. Populated when `markThreadSeen` is
   * called (e.g. when the ThreadPanel opens) and persisted to localStorage
   * alongside the per-conv unread markers. Drives `thread_unread_count` on
   * roots in `activeMessages`. Mirrors phoenix's MCP-side per-thread cursor
   * (plan §4.2) but lives client-side for the web data path.
   */
  threadSeenCursors = $state({});

  /**
   * Composer prefill text. When non-null, `MessageInput.svelte` consumes the
   * value via a `$effect`, sets `inputValue` to it, focuses the textarea,
   * positions the cursor at end, then clears this back to `null`.
   *
   * Set by `ProfileCard` / `UserProfileView` (via App.svelte handlers) to
   * pre-fill `/dm @<name> ` for the "Send DM" button. Replaces the prior
   * `document.querySelector` + `input.value =` + synthetic-event approach
   * in App.svelte (plan §11 Phase C, R2-C3 fix). The store-mediated event
   * keeps Svelte state coherent and auto-commits autocomplete tokens
   * cleanly via the existing input pipeline.
   *
   * @type {string | null}
   */
  composerPrefill = $state(null);

  /**
   * Rolling count of MQTT message-parse failures in the last 30 seconds.
   * Drives the "Message decoding errors detected" banner. Updated by
   * `#receiveMqttFrame`; pruned on every update so stale entries age out
   * without a timer. Threshold ≥ 5 → banner visible.
   *
   * Empty payloads (retained-clear presence cleanups) are NOT counted —
   * those are routine broker-state ops, not real parse failures.
   */
  parseFailureRate = $state(0);

  /**
   * Reactive payload mirroring the last `artifact_ref` chat message that
   * landed in the active channel. Consumers (ArtifactPanel) watch this to
   * decide whether to surface the remote-update banner during an edit.
   *
   *   `{ name: string, version: number | null, senderName: string,
   *      epoch: number }`
   *
   * The `epoch` is a monotonically-increasing counter bumped on every
   * notification so `$effect` subscribers re-fire even if two back-to-back
   * notifications have the same `name` + `version` (unlikely but defensive
   * against Svelte's deep-equality shortcut for object props).
   *
   * Version is best-effort parsed from the system-message body (see
   * `#parseArtifactRefBody`); if we can't parse it out, it remains `null`
   * and the panel will fall back to a re-fetch to discover the new version.
   */
  latestArtifactRefNotification = $state(null);

  /** @type {mqtt.MqttClient | null} */
  #client = null;

  /**
   * Timestamps (ms) of recent MQTT parse failures, used to compute
   * ``parseFailureRate`` over a 30s rolling window. See ``#recordParseFailure``.
   * @type {number[]}
   */
  #parseFailureTimestamps = [];
  #seenIds = new Set();
  #typingTimers = {};
  #myTypingTimer = null;
  #seenMessageIds = new Set();
  #failureCount = 0;
  #backoffActive = false;
  #backoffTimer = null;
  #participantPollTimer = null;
  /** Unique instance ID for this browser tab/session (4 hex chars). */
  #instanceId = Math.random().toString(16).slice(2, 6);
  /** Timer for periodic heartbeat presence re-publish (60s). */
  #heartbeatTimer = null;
  /** Timer for TTL cleanup of stale connections (30s). */
  #ttlCleanupTimer = null;

  /**
   * Map keyed by `"${artifactName}:${version}"` → expiry timestamp (ms since
   * epoch). Populated by `markSelfUpdate()` when the panel POSTs a new
   * artifact version; consumed by `isOurRecentUpdate()` so the incoming
   * MQTT echo of our own write does not trigger a "remote update" banner.
   * Entries auto-expire after 5 seconds. Owned here (not in the panel) so
   * the MQTT message handler has authoritative access without a cross-
   * component ref — see plan §1 R5-6.
   * @type {Map<string, number>}
   */
  #recentlySelfUpdated = new Map();

  /**
   * Outgoing messages queued while we were disconnected from the broker
   * (UX G-62). Each entry is `{ messageId, topic, payload }`. On reconnect
   * (`#client.on('connect')`) `#drainPendingSends()` flushes them in
   * insertion order; failures or queue overflow flip the bubble status to
   * `'failed'` via `#updateLocalMessageStatus`.
   *
   * Cap = 100 entries. When the cap is exceeded the OLDEST entry is
   * dropped (FIFO) and its bubble is marked `failed` with reason
   * `"queue full"`. We choose drop-oldest because a long offline session
   * is more likely to want the user's most-recent thoughts delivered than
   * messages composed hours earlier; matches mainstream chat-client
   * conventions (Slack, iMessage).
   *
   * @type {Array<{ messageId: string, topic: string, payload: string }>}
   */
  #pendingSends = [];
  /** Hard cap on `#pendingSends` queue length. See field doc above. */
  static #PENDING_SENDS_CAP = 100;

  /**
   * Bootstrap the channel list from the daemon's ``/api/conversations``
   * endpoint (v0.4.0 S-FIX). Single source of truth at startup — replaces
   * the prior hardcoded seed list. Maps the v0.4.0 ChannelRow payload
   * (Step 2.1 contract, Design Spec §13.4) into the store-internal shape,
   * applying the ``my``-prefix → unprefixed rename so Step 2.6 can read
   * the cleaner names directly.
   *
   * Edge cases (architecture spec §III.4):
   *   - 0 rows  → ``channels = []``; sidebar derivations return empty.
   *   - non-array body or wrong shape → treat like 0 rows; no crash.
   *   - 404 / 500 / network throw → ``serverUnreachable = true``;
   *     ``channels = []``; parse-failure counter bumped via the same
   *     v0.3.1 helper used for MQTT parse failures.
   *
   * Success path explicitly flips ``serverUnreachable`` back to ``false``
   * so a reconnect after a transient outage clears the banner.
   *
   * Idempotent: safe to call on every ``'connect'`` event. Currently
   * REPLACES ``channels`` wholesale on success; Step 2.6 will refine the
   * merge semantics once local-only state (starred/muted) lands.
   */
  async #bootstrapChannels() {
    let rows;
    try {
      rows = await apiGet('/api/conversations');
    } catch (err) {
      this.serverUnreachable = true;
      this.channels = [];
      this.#recordParseFailure();
      console.warn(
        '[claude-comms] /api/conversations bootstrap failed',
        {
          status: err && err.status,
          message: err && err.message,
          timestamp: new Date().toISOString(),
        },
      );
      return;
    }

    // Tolerate either a bare array (current daemon shape) or a wrapped
    // ``{ conversations: [...] }`` envelope (future-compat). Anything
    // else is treated as 0 rows.
    let list = rows;
    if (rows && !Array.isArray(rows) && Array.isArray(rows.conversations)) {
      list = rows.conversations;
    }
    if (!Array.isArray(list)) {
      this.channels = [];
      this.serverUnreachable = false;
      return;
    }

    this.channels = list.map((row) => this.#channelRowFromPayload(row));
    this.serverUnreachable = false;
  }

  /**
   * Map a single ``/api/conversations`` row → store-internal channel
   * shape. Renames the caller-personalized ``my``-prefix fields and
   * defaults every other field so the store never carries ``undefined``
   * leaks (Design Spec §13.4 preamble: "no undefined leaks"). Defensive
   * against partial rows so a future daemon dropping a field doesn't
   * crash the bootstrap.
   *
   * @param {object} row - Single ChannelRow-shaped row from the daemon.
   * @returns {object} Store-internal channel object.
   */
  #channelRowFromPayload(row) {
    const r = row && typeof row === 'object' ? row : {};
    return {
      id: typeof r.id === 'string' ? r.id : '',
      name: typeof r.name === 'string' ? r.name : (typeof r.id === 'string' ? r.id : ''),
      topic: typeof r.topic === 'string' ? r.topic : '',
      member: r.member === true,
      memberCount: typeof r.memberCount === 'number' ? r.memberCount : 0,
      lastActivity: r.lastActivity ?? null,
      mode: typeof r.mode === 'string' ? r.mode : 'public',
      visibility: typeof r.visibility === 'string' ? r.visibility : 'listed',
      createdAt: r.createdAt ?? null,
      createdBy: r.createdBy ?? null,
      // my-prefix → unprefixed rename (architecture spec §III.4 preamble)
      unread: typeof r.myUnread === 'number' ? r.myUnread : 0,
      starred: r.myStarred === true,
      muted: r.myMuted === true,
      // Archive fields default to non-archived when absent (the daemon
      // does not emit them yet as of v0.4.0 Step 2.1; reserved for the
      // archive-aware payload in a later step).
      archived: r.archived === true,
      archived_at: r.archived_at ?? null,
      archived_by: r.archived_by ?? null,
    };
  }

  /**
   * Test-only seam: run the channel-bootstrap helper directly. Mirrors
   * what the production ``'connect'`` callback does. Used by
   * ``tests/mqtt-store-bootstrap.spec.js`` to exercise the 0-row,
   * populated-row, and error paths without standing up a live daemon.
   */
  async _bootstrapChannelsForTest() {
    await this.#bootstrapChannels();
  }

  /**
   * Fetch message history from the REST API for a given channel.
   * Messages are deduplicated against the seen-ID set so live MQTT
   * messages that arrived before the history response don't appear twice.
   * @param {string} channel - The channel to fetch history for.
   */
  async #fetchHistory(channel) {
    try {
      const res = await fetch(`${API_BASE}/api/messages/${encodeURIComponent(channel)}?count=50`);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.messages)) return;

      const newMessages = [];
      for (const msg of data.messages) {
        if (!msg.id || this.#seenIds.has(msg.id)) continue;
        this.#seenIds.add(msg.id);
        newMessages.push({ ...msg, channel });
      }
      if (newMessages.length > 0) {
        // Defer the state update to next microtask so Svelte 5's
        // reactive system is fully initialized after connect()
        await new Promise(r => setTimeout(r, 0));
        // Immutable reassignment triggers $derived recalculation
        this.messages = [...this.messages, ...newMessages]
          .sort((a, b) => new Date(a.ts) - new Date(b.ts));

        // Cap the messages array to prevent unbounded growth
        if (this.messages.length > MAX_MESSAGES) {
          this.messages = this.messages.slice(-MAX_MESSAGES);
        }
      }
    } catch {
      // History fetch failed — not critical, live messages still work
    }
  }

  /**
   * Fetch the participant list from the REST API for a given channel.
   * Merges server-side participants into the local user-keyed participants
   * map. For self, only merges non-web connections to avoid overwriting
   * locally-managed web instance state.
   * @param {string} channel - The channel to fetch participants for.
   */
  async #fetchParticipants(channel) {
    try {
      const res = await fetch(`${API_BASE}/api/participants/${encodeURIComponent(channel)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.participants)) return;

      const serverKeys = new Set();
      for (const p of data.participants) {
        serverKeys.add(p.key);

        // v0.3.2: record each member's full conversation set into
        // channelMembers. The server includes a ``conversations`` field
        // per member (sorted list of conv ids). For each conv in that
        // list, mark this key as a member. Treats REST as authoritative
        // -- on each poll we set the most-recent timestamp.
        if (Array.isArray(p.conversations)) {
          const nowTs = new Date().toISOString();
          for (const conv of p.conversations) {
            if (!this.channelMembers[conv]) {
              this.channelMembers[conv] = {};
            }
            this.channelMembers[conv][p.key] = nowTs;
          }
        }

        if (p.key === this.userProfile.key) {
          // For self: merge connections from API but don't overwrite any connection
          // we're currently managing locally (our own web instance(s))
          const existing = this.participants[p.key];
          if (existing) {
            for (const [connKey, info] of Object.entries(p.connections || {})) {
              // Skip any connection key we already track locally (our own instances)
              if (existing.connections[connKey]) continue;
              existing.connections[connKey] = info;
            }
          }
          continue;
        }
        // For others: merge connections (don't overwrite MQTT-delivered state)
        const existing = this.participants[p.key];
        if (existing) {
          // Merge connections from API into existing entry
          for (const [connKey, info] of Object.entries(p.connections || {})) {
            if (!existing.connections[connKey]) {
              existing.connections[connKey] = info;
            }
          }
          existing.name = p.name;
          existing.type = p.type;
        } else {
          this.participants[p.key] = {
            key: p.key,
            name: p.name,
            type: p.type,
            connections: p.connections || {},
            lastOffline: null,
          };
        }
      }

      // Prune stale local participants the server no longer recognizes for the
      // active channel — but ONLY if the local entry has no live connections.
      //
      // Background (Issue A from the v0.3.1 follow-up brief): the previous
      // version of this code pruned every local participant not present in
      // /api/participants/<activeChannel>. That broke multi-channel
      // membership: if a worker was a member of both #general and
      // #svelte-work, viewing #general would prune the worker the moment
      // a REST poll landed because /api/participants/general only returns
      // the worker IF they're in #general -- but the prune ran globally
      // against the local map, deleting them from view entirely even
      // though their membership in BOTH channels was valid server-side.
      //
      // The genuine "ghost cleanup" case is a participant whose retained
      // MQTT presence stuck around from a previous session, but who is no
      // longer in any channel server-side. Such ghosts always have an
      // empty connections dict (their retained presence got applied but
      // the broker delivers nothing newer). So we only prune when:
      //   1. Channel being polled is the active channel
      //   2. Local participant is not in server's response for this channel
      //   3. Local participant has NO active connections
      //
      // A participant with active connections is, by definition, still
      // online somewhere -- they may simply be a member of a DIFFERENT
      // channel than the one we're polling. Leave them alone.
      if (channel === this.activeChannel) {
        for (const localKey of Object.keys(this.participants)) {
          if (localKey === this.userProfile.key) continue;
          if (serverKeys.has(localKey)) continue;
          const local = this.participants[localKey];
          if (!local) continue;
          if (Object.keys(local.connections || {}).length > 0) {
            // Live elsewhere — keep them in the global map. The OTHER
            // channel's REST poll (when the user switches to that channel)
            // will confirm their membership, and the global MemberList
            // continues showing them as online.
            continue;
          }
          delete this.participants[localKey];
        }
      }
    } catch {
      // Participant fetch failed — not critical, MQTT presence still works
    }
  }

  /**
   * Start periodic polling of the participants REST API.
   * Called on connect; stopped on disconnect.
   */
  #startParticipantPolling() {
    this.#stopParticipantPolling();
    // Initial fetch
    this.#fetchParticipants(this.activeChannel);
    // Poll every 30 seconds
    this.#participantPollTimer = setInterval(() => {
      this.#fetchParticipants(this.activeChannel);
    }, 30000);
  }

  /**
   * Stop periodic participant polling.
   */
  #stopParticipantPolling() {
    if (this.#participantPollTimer) {
      clearInterval(this.#participantPollTimer);
      this.#participantPollTimer = null;
    }
  }

  // ── Derived State ──
  // Svelte 5 $state proxies track every synchronous property read inside a
  // $derived expression — including `.filter()`, `.find()`, `Object.values`,
  // `Object.keys`, etc., because they all read the proxy. There is no need
  // for explicit `_len = this.messages.length` "dependency-pinning" reads;
  // the proxy intercepts the iteration. See the Svelte 5 `$derived` docs
  // section "Understanding dependencies" for the precise model.
  // A historical mis-fix here added `_len`/`_p` placeholder reads under the
  // belief that array iteration didn't track; that was a cargo-cult and has
  // been removed (eng R-1).
  activeMessages = $derived.by(() => {
    // Top-level only: thread replies (reply_to !== null) live in the right-
    // side ThreadPanel data source (`activeChannelReplies` below), not the
    // main timeline. Plan §5 — channel feed is roots only; chip on the root
    // (MessageBubble.thread-indicator) signals reply count.
    //
    // Splice `thread_unread_count` onto each root from the per-thread seen-
    // cursor (client-side, mirrors the per-conv `ch.unreadFrom` / `ch.unread`
    // pattern at this:782,991-1015). Phoenix's `comms_check.thread_unread`
    // MCP field serves non-web clients; web computes the same shape locally.
    const ch = this.activeChannel;
    const cursors = this.threadSeenCursors;
    const roots = this.messages.filter(m => m.channel === ch && !m.reply_to);
    const replies = this.messages.filter(m => m.channel === ch && m.reply_to);
    return roots.map(root => {
      if (!root.thread_reply_count) return root;
      const cursorTs = cursors[root.id] || null;
      const unreadCount = cursorTs
        ? replies.filter(r => r.reply_to === root.id && r.ts > cursorTs).length
        : (root.thread_reply_count || 0);
      // Avoid mutating the source dict — return a shallow extension.
      return { ...root, thread_unread_count: unreadCount };
    });
  });

  // Raw per-channel messages including replies — used by the ThreadPanel
  // data source (App.svelte mounts ThreadPanel with messages filtered by
  // reply_to === root.id). Threads stay client-side derived because the
  // firehose MQTT topic carries all replies anyway and there is no per-
  // thread WebSocket in the web data path.
  activeChannelReplies = $derived(
    this.messages.filter(m => m.channel === this.activeChannel && m.reply_to)
  );

  activeChannelMeta = $derived(
    this.channels.find(c => c.id === this.activeChannel)
  );

  starredChannels = $derived(this.channels.filter(c => c.starred));

  onlineParticipants = $derived(
    Object.values(this.participants).filter(p => Object.keys(p.connections).length > 0)
  );

  // Offline = entry exists but connections is empty (kept briefly for display)
  offlineParticipants = $derived(
    Object.values(this.participants).filter(p => Object.keys(p.connections).length === 0)
  );

  /**
   * v0.3.2 — three-state MemberList feeds.
   *
   * activeMembers: participants who are members of the currently-viewed
   * channel AND online. The primary "who can I address right now" list.
   *
   * onlineElsewhere: participants online globally but NOT joined to the
   * active channel. They're around the server but not in this room.
   * Rendered with an "in #X +N more" location chip so the user can see
   * where they actually are.
   *
   * (offlineParticipants stays as-is above — no channel filter, just
   * "has empty connections.")
   *
   * Sort: alphabetical by name within each section. Stable under churn.
   */
  activeMembers = $derived.by(() => {
    const ch = this.activeChannel;
    const cm = this.channelMembers;
    const memberKeys = cm[ch] ? new Set(Object.keys(cm[ch])) : new Set();
    return Object.values(this.participants)
      .filter(
        (p) =>
          memberKeys.has(p.key) && Object.keys(p.connections).length > 0,
      )
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  });

  onlineElsewhere = $derived.by(() => {
    const ch = this.activeChannel;
    const cm = this.channelMembers;
    const self = this.userProfile.key;
    const memberKeys = cm[ch] ? new Set(Object.keys(cm[ch])) : new Set();
    return Object.values(this.participants)
      .filter(
        (p) =>
          p.key !== self &&
          !memberKeys.has(p.key) &&
          Object.keys(p.connections).length > 0,
      )
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  });

  /**
   * Helper for the "in #X +N more" inline location chip. Returns the
   * sorted list of channels this participant is a member of, EXCLUDING
   * the currently-viewed channel. Empty list means the participant has
   * no known channel membership (e.g. transient registration that
   * hasn't joined anywhere yet); the UI should render no location chip.
   *
   * Channel set is determined by:
   *   1. channelMembers[conv] (built from REST + live MQTT presence)
   *   2. excluding the active channel
   *
   * Sort: alphabetical by channel id. The chip displays the first entry
   * and "+N more" if N > 0 remaining; the tooltip lists all entries.
   *
   * @param {string} key
   * @returns {string[]}
   */
  getMemberConversations(key) {
    const cm = this.channelMembers;
    const activeCh = this.activeChannel;
    const out = [];
    for (const conv of Object.keys(cm)) {
      if (conv === activeCh) continue;
      if (cm[conv] && cm[conv][key]) {
        out.push(conv);
      }
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }

  activeTypingUsers = $derived.by(() => {
    const ch = this.activeChannel;
    const selfKey = this.userProfile.key;
    return Object.entries(this.typingUsers)
      .filter(([key, info]) => {
        return info.channel === ch
          && info.typing
          && key !== selfKey
          && (Date.now() - new Date(info.ts).getTime()) < TYPING_TTL_MS;
      })
      .map(([key, info]) => ({
        key,
        name: this.participants[key]?.name || key
      }));
  });

  /**
   * Active non-typing activities across online participants for the current
   * channel. Returns one entry per participant whose connections carry a
   * non-expired `activity` (per richer-expression v4). Excludes the local
   * user and excludes `typing` (already handled by activeTypingUsers above).
   * Each entry: {key, name, label}.
   *
   * Activity wire shape (in connections[conn_key].activity):
   *   {label: string, set_at: ISO8601, expires_at: ISO8601}
   *
   * Picks the most-recently-set non-expired activity across a participant's
   * connections (matching the MemberList.getActivity selection logic).
   */
  activeActivities = $derived.by(() => {
    // Read activeChannel so the derived recomputes on channel switches even
    // though the current return value is global (see the trailing note).
    void this.activeChannel;
    const selfKey = this.userProfile.key;
    const now = Date.now();
    const out = [];
    for (const [key, p] of Object.entries(this.participants)) {
      if (key === selfKey) continue;
      // Scope to current channel: participant must be a member.
      // (Use the same membership check the rest of the store relies on —
      // online + connections present.)
      if (!p || !p.connections || typeof p.connections !== 'object') continue;
      let bestLabel = null;
      let bestSetAt = -Infinity;
      for (const conn of Object.values(p.connections)) {
        const a = conn?.activity;
        if (!a || typeof a.label !== 'string') continue;
        if (a.label === 'typing') continue; // typing rendered separately
        if (a.expires_at) {
          const t = Date.parse(a.expires_at);
          if (Number.isFinite(t) && t < now) continue;
        }
        const setAt = Date.parse(a.set_at || '');
        const cmp = Number.isFinite(setAt) ? setAt : 0;
        if (cmp > bestSetAt) {
          bestSetAt = cmp;
          bestLabel = a.label;
        }
      }
      if (bestLabel) {
        out.push({ key, name: p.name || key, label: bestLabel });
      }
    }
    // Note: channel-scoping for activities is currently global — the
    // presence registry doesn't track per-conversation membership for
    // MCP claudes the way it does for typing. This matches the v4 spec
    // ("activity is always per-conversation broadcast"); we surface it
    // only when the participant is also online.
    return out;
  });

  activePinnedMessages = $derived(
    this.pinnedMessages.filter(m => m.channel === this.activeChannel)
  );

  onlineCount = $derived(this.onlineParticipants.length);

  /** Total number of messages across all channels. */
  messageCount = $derived(this.messages.length);

  /**
   * Look up a channel by its ID.
   * @param {string} id - The channel identifier.
   * @returns {object|undefined} The channel object, or undefined if not found.
   */
  getChannelById(id) {
    return this.channels.find(c => c.id === id);
  }

  /**
   * Look up a participant by their key.
   * @param {string} key - The participant key (8 hex chars).
   * @returns {object|undefined} The participant object, or undefined if not found.
   */
  getParticipantByKey(key) {
    return this.participants[key];
  }

  /**
   * Connect to the MQTT broker via WebSocket.
   * Restores user identity from localStorage and sets up event handlers
   * for connection, disconnection, reconnection, and incoming messages.
   * @throws Will set connectionError state if the broker is unreachable.
   */
  async connect() {
    // Restore unread markers before anything else so the sidebar shows them
    this.#restoreUnreadMarkers();

    // Fetch identity from the daemon config so web + TUI share the same key.
    // Falls back to localStorage if the daemon is not running. UX G-43:
    // never silently default to a real human name — the sentinel `(unset)`
    // survives if no source produces a real name, and `nameUnset` drives a
    // banner instead.
    try {
      const res = await fetch(API_BASE + '/api/identity');
      if (res.ok) {
        const identity = await res.json();
        this.userProfile.key = identity.key;
        // Adopt the daemon's name ONLY if it's non-empty. A blank daemon
        // identity should not overwrite our sentinel — that would silently
        // empty the displayed name without surfacing the unset state.
        if (typeof identity.name === 'string' && identity.name.trim().length > 0) {
          this.userProfile.name = identity.name;
          this.nameUnset = false;
        }
        if (identity.type) this.userProfile.type = identity.type;
      }
    } catch {
      console.error('[claude-comms] Failed to fetch identity from', API_BASE + '/api/identity');
    }

    // If identity fetch failed (shouldn't happen — daemon serves this page),
    // generate a temporary key. No localStorage caching — the daemon config
    // is the single source of truth for identity. Name stays `(unset)` so
    // the UI banner fires.
    if (!this.userProfile.key) {
      this.userProfile.key = generateKey();
    }

    // Restore user name from localStorage only (not key — key comes from
    // daemon). Only fall back to a stored name if the daemon didn't already
    // provide one, AND the stored value is a real non-empty string. The
    // legacy `'Phil'` hardcoded default is gone (UX G-43); we no longer
    // need to special-case it here.
    if (this.nameUnset) {
      const storedName = safeStorage.getItem('claude-comms-user-name');
      if (storedName && storedName.trim().length > 0) {
        this.userProfile.name = storedName;
        this.nameUnset = false;
      }
    }

    const clientId = 'claude-comms-web-' + this.userProfile.key + '-' + this.#instanceId;
    const connKey = 'web-' + this.#instanceId;
    const presenceTopic = TOPIC_PREFIX + '/presence/' + this.userProfile.key + '/' + connKey;

    this.#client = mqtt.connect(BROKER_URL, {
      clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      will: {
        topic: presenceTopic,
        payload: JSON.stringify({
          key: this.userProfile.key,
          name: this.userProfile.name,
          type: this.userProfile.type,
          status: 'offline',
          client: 'web',
          instanceId: this.#instanceId,
          ts: new Date().toISOString(),
        }),
        qos: 1,
        retain: true
      }
    });

    this.#client.on('connect', () => {
      this.connected = true;
      this.connectionError = null;
      this.#failureCount = 0;
      this.#backoffActive = false;
      this.#subscribeAll();
      this.#publishPresence('online');

      // v0.4.0 S-FIX: hydrate the channel list from the daemon's
      // authoritative /api/conversations endpoint. Fire-and-forget — the
      // helper handles its own errors (404/500/network) by flipping
      // `serverUnreachable` and leaving `channels` empty. Channels must
      // be populated BEFORE any per-channel work (history fetch,
      // participant polling) so derivations that read `channels` see
      // the real set rather than the empty initial `[]`.
      this.#bootstrapChannels();

      // UX G-62: flush any messages the user composed while we were
      // disconnected. Drains FIFO; each item carries its own (topic,
      // payload) snapshot so the active channel at drain time doesn't
      // matter. Done BEFORE history fetch so the user's queued sends are
      // the first thing the broker sees on reconnect.
      this.#drainPendingSends();

      // Self-add: create user entry with our web connection
      const now = new Date().toISOString();
      if (!this.participants[this.userProfile.key]) {
        this.participants[this.userProfile.key] = {
          key: this.userProfile.key,
          name: this.userProfile.name,
          type: this.userProfile.type,
          connections: {},
          lastOffline: null,
        };
      }
      this.participants[this.userProfile.key].connections[connKey] = {
        client: 'web', instanceId: this.#instanceId, since: now, lastSeen: now
      };
      this.participants[this.userProfile.key].lastOffline = null;

      // Fetch message history from the REST API so messages survive page refresh
      this.#fetchHistory(this.activeChannel);
      // Start polling participant list from the server to discover
      // TUI/MCP clients whose presence may not bridge across transports
      this.#startParticipantPolling();

      // Start heartbeat: re-publish presence every 60s to update lastSeen
      this.#stopHeartbeat();
      this.#heartbeatTimer = setInterval(() => {
        this.#publishPresence('online');
        // Also update our own local lastSeen
        const self = this.participants[this.userProfile.key];
        if (self && self.connections[connKey]) {
          self.connections[connKey].lastSeen = new Date().toISOString();
        }
      }, 60_000);

      // Start TTL cleanup: check all connections every 30s
      this.#stopTtlCleanup();
      this.#ttlCleanupTimer = setInterval(() => {
        this.#runTtlCleanup();
      }, 30_000);
    });

    this.#client.on('error', (err) => {
      this.#failureCount++;
      if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
        this.connectionError = 'Broker unavailable — is "claude-comms start" running? (expected at ' + BROKER_URL + ')';
      } else if (err.message?.includes('WebSocket')) {
        this.connectionError = 'WebSocket connection failed — is "claude-comms start" running? Check broker WebSocket listener on ' + BROKER_URL + '.';
      } else {
        this.connectionError = 'MQTT error: ' + (err.message || String(err));
      }

      // After repeated failures, activate exponential backoff
      if (this.#failureCount >= BACKOFF_AFTER_ATTEMPTS && !this.#backoffActive) {
        this.#activateBackoff();
      }
    });

    this.#client.on('close', () => {
      this.connected = false;
    });

    this.#client.on('offline', () => {
      this.connected = false;
      this.#failureCount++;
      if (!this.connectionError) {
        this.connectionError = 'Connection lost — waiting to reconnect...';
      }

      if (this.#failureCount >= BACKOFF_AFTER_ATTEMPTS && !this.#backoffActive) {
        this.#activateBackoff();
      }
    });

    this.#client.on('reconnect', () => {
      if (this.#backoffActive) return; // suppress during backoff
      this.connectionError = 'Reconnecting to broker...';
    });

    this.#client.on('message', (topic, payload) => {
      this.#receiveMqttFrame(topic, payload);
    });
  }

  /**
   * Decode a single MQTT frame and dispatch it to `#handleMessage`.
   *
   * Replaces the previous inline `try { JSON.parse(...) }` that logged
   * `"Failed to parse MQTT message:"` with no context, making every
   * downstream report a dead end. This variant:
   *
   * - **Silently skips empty payloads** — retained-clear publishes (e.g.
   *   `publish(presenceTopic, '', {retain: true})`) are intentional broker
   *   state-clears; they're not parse failures.
   * - **Logs structured context** when JSON.parse fails: topic, payload
   *   length, a 500-char preview (with a `[truncated, total=N]` tail when
   *   the payload was longer), error name + message, and a timestamp. Makes
   *   "parse failed" bug reports root-cause-able without a re-pro.
   * - **Tracks failure rate** over a 30s rolling window via
   *   `#recordParseFailure`. Threshold ≥ 5 → the App.svelte banner appears.
   * - **Continues** rather than letting the exception bubble — one bad
   *   message never freezes the message stream.
   *
   * @param {string} topic - MQTT topic the frame arrived on.
   * @param {Uint8Array | Buffer | string} payload - Raw payload from mqtt.js.
   */
  #receiveMqttFrame(topic, payload) {
    const text =
      typeof payload === 'string' ? payload : payload.toString();

    // Empty payloads are intentional broker-state clears (e.g. retained-
    // presence cleanup). Not a parse failure.
    if (text.length === 0) return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      const PREVIEW_LIMIT = 500;
      const preview =
        text.length > PREVIEW_LIMIT
          ? text.slice(0, PREVIEW_LIMIT) +
            `... [truncated, total=${text.length}]`
          : text;
      const errorName = err instanceof Error ? err.name : 'unknown';
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[claude-comms] MQTT message parse failed', {
        topic,
        payloadLength: text.length,
        payloadPreview: preview,
        errorName,
        errorMessage,
        timestamp: new Date().toISOString(),
      });
      this.#recordParseFailure();
      return;
    }
    this.#handleMessage(topic, msg);
  }

  /**
   * Record a parse failure timestamp and update the rolling 30s-window
   * counter that drives the UI banner. Prunes stale entries on every call
   * so we don't need a separate timer for aging.
   */
  #recordParseFailure() {
    const now = Date.now();
    const WINDOW_MS = 30_000;
    this.#parseFailureTimestamps = this.#parseFailureTimestamps.filter(
      (t) => now - t < WINDOW_MS,
    );
    this.#parseFailureTimestamps.push(now);
    this.parseFailureRate = this.#parseFailureTimestamps.length;
  }

  /**
   * Disconnect from the MQTT broker and clean up.
   * Publishes an offline presence message before closing the connection.
   */
  disconnect() {
    this.#stopParticipantPolling();
    this.#stopHeartbeat();
    this.#stopTtlCleanup();

    // Clear our own typing timer
    if (this.#myTypingTimer) {
      clearTimeout(this.#myTypingTimer);
      this.#myTypingTimer = null;
    }

    // Clear all remote typing expiry timers
    for (const key of Object.keys(this.#typingTimers)) {
      clearTimeout(this.#typingTimers[key]);
    }
    this.#typingTimers = {};

    // Clear backoff reconnect timer
    if (this.#backoffTimer) {
      clearTimeout(this.#backoffTimer);
      this.#backoffTimer = null;
      this.#backoffActive = false;
    }

    if (this.#client) {
      // Graceful disconnect: publish offline, then empty retained to clean broker
      this.#publishPresence('offline');
      const connKey = 'web-' + this.#instanceId;
      const presenceTopic = TOPIC_PREFIX + '/presence/' + this.userProfile.key + '/' + connKey;
      this.#client.publish(presenceTopic, '', { retain: true });
      this.#client.end();
      this.#client = null;
      this.connected = false;
    }
  }

  /**
   * Send a chat message to the active channel.
   * The message is echoed locally before publishing to the broker,
   * so it appears immediately even on slow connections.
   *
   * Signature change (plan §11 Phase C, R2-C2 atomicity constraint): the
   * third positional arg is now an options object `{ mentions, recipients }`.
   * The two fields are independent primitives:
   *   - `mentions` (broadcast highlight): visible to all channel members,
   *     named users get a notification cue. Wire field: `mentions: string[]`.
   *   - `recipients` (whisper): visible only to sender + listed recipients.
   *     Wire field: `recipients: string[]`. Server's `_is_visible` filter
   *     uses this exclusively.
   *
   * Both default to `null`. Callers passing only two positional args (e.g.
   * threaded reply) get broadcast semantics.
   *
   * @param {string} body - The message text (whitespace-only bodies are ignored).
   * @param {string|null} replyTo - Optional ID of the message being replied to.
   * @param {{ mentions?: string[]|null, recipients?: string[]|null }} [options]
   *   `mentions` — list of participant keys to highlight (broadcast).
   *   `recipients` — list of participant keys to whisper to (private).
   */
  sendMessage(body, replyTo = null, { mentions = null, recipients = null } = {}) {
    if (!body.trim()) return;

    const msg = {
      id: generateUUID(),
      ts: new Date().toISOString(),
      sender: {
        key: this.userProfile.key,
        name: this.userProfile.name,
        type: this.userProfile.type
      },
      mentions: mentions?.length ? [...mentions] : null,
      recipients: recipients?.length ? [...recipients] : null,
      body: body.trim(),
      reply_to: replyTo,
      conv: this.activeChannel,
      // Per-message delivery status (UX G-62). Outgoing local-echo bubbles
      // start as 'sending'. On successful publish (or queued + drained on
      // reconnect) → 'sent'. On publish error or queue-full eviction →
      // 'failed' (then user can call retryMessage(id)).
      status: 'sending',
    };

    const topic = TOPIC_PREFIX + '/conv/' + this.activeChannel + '/messages';
    const payload = JSON.stringify(msg);

    // Local echo: add message immediately so it appears even without broker
    this.#handleChatMessage(this.activeChannel, msg);

    if (this.#client && this.connected) {
      this.#publishOutgoing(msg.id, topic, payload);
    } else {
      // Disconnected — queue instead of silently dropping (UX G-62, the
      // previous behavior). The bubble stays in 'sending' until the
      // queue drains on reconnect.
      this.#queuePendingSend(msg.id, topic, payload);
    }

    // Stop typing indicator
    this.#publishTyping(false);
  }

  /**
   * Publish an outgoing message to the broker and update its local-echo
   * bubble status. On success → `'sent'`. On error (synchronous throw or
   * async callback err) → `'failed'`. Used both by `sendMessage` for the
   * happy path and by `#drainPendingSends` / `retryMessage` for queued
   * messages.
   *
   * @param {string} messageId - Local-echo message id (the UUID stamped
   *   onto the bubble at compose time).
   * @param {string} topic - MQTT topic to publish on.
   * @param {string} payload - Stringified JSON payload.
   */
  #publishOutgoing(messageId, topic, payload) {
    if (!this.#client) {
      this.#updateLocalMessageStatus(messageId, 'failed');
      return;
    }
    try {
      this.#client.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          this.#updateLocalMessageStatus(messageId, 'failed');
        } else {
          this.#updateLocalMessageStatus(messageId, 'sent');
        }
      });
    } catch {
      // mqtt.js shouldn't throw synchronously, but if a malformed payload
      // somehow makes it here we surface the failure instead of silently
      // leaving the bubble in 'sending' forever.
      this.#updateLocalMessageStatus(messageId, 'failed');
    }
  }

  /**
   * Enqueue an outgoing send for later delivery (UX G-62). When the queue
   * is full (`#PENDING_SENDS_CAP`), drops the OLDEST entry and marks its
   * bubble `failed` so the user can retry / re-send. The new entry is
   * always accepted — losing newest-on-overflow would be more surprising
   * than losing the entry that has already been waiting longest.
   *
   * @param {string} messageId
   * @param {string} topic
   * @param {string} payload
   */
  #queuePendingSend(messageId, topic, payload) {
    if (this.#pendingSends.length >= MqttChatStore.#PENDING_SENDS_CAP) {
      const dropped = this.#pendingSends.shift();
      if (dropped) {
        this.#updateLocalMessageStatus(dropped.messageId, 'failed');
      }
    }
    this.#pendingSends.push({ messageId, topic, payload });
  }

  /**
   * Drain the pending-send queue in FIFO order. Called from the
   * `'connect'` callback once the broker is back. Each entry goes through
   * `#publishOutgoing`, which handles its own success/failure status
   * update. Anything still in 'failed' afterwards keeps a `retryMessage`
   * affordance via the bubble.
   */
  #drainPendingSends() {
    if (this.#pendingSends.length === 0) return;
    const queue = this.#pendingSends;
    this.#pendingSends = [];
    for (const item of queue) {
      this.#publishOutgoing(item.messageId, item.topic, item.payload);
    }
  }

  /**
   * Mutate the `status` field of the locally-echoed message with the given
   * id. No-op if the message has been deleted in the meantime (the user
   * may have purged it or it may have aged out of the bounded array). The
   * Svelte 5 `$state` proxy tracks the in-place property write — no
   * immutable rebuild needed (the message object identity is what
   * MessageBubble keys on).
   *
   * @param {string} messageId
   * @param {'sending' | 'sent' | 'failed'} status
   */
  #updateLocalMessageStatus(messageId, status) {
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg) return;
    msg.status = status;
  }

  /**
   * Test-only seam: install a stub mqtt client + force the `connected`
   * flag. Lets unit tests exercise `#publishOutgoing` and the retry path
   * without standing up a real broker. Not part of the public production
   * API — present here because the private `#client` slot isn't reachable
   * from outside the class. Used by `tests/mqtt-store-pending-sends.spec.js`.
   *
   * @param {object} client - mqtt.js-compatible stub (must implement
   *   `publish(topic, payload, opts, cb)`).
   * @param {boolean} connected - whether to flag the store as connected
   *   after installation.
   */
  _installTestClient(client, connected = true) {
    this.#client = client;
    this.connected = connected;
  }

  /**
   * Test-only seam: simulate the `'connect'` event callback's queue
   * flush, without actually opening a real broker socket. Mirrors what
   * the production `#client.on('connect', …)` handler does for the
   * G-62 path (subscribe/presence/history are not relevant for queue
   * tests, so this seam covers only the drain step).
   */
  _drainPendingSendsForTest() {
    this.#drainPendingSends();
  }

  /**
   * Test-only inspector: returns the current pending-send queue size.
   * Useful for asserting the queue is empty after a simulated drain.
   */
  _pendingSendsLengthForTest() {
    return this.#pendingSends.length;
  }

  /**
   * Retry a message previously marked `'failed'`. Flips status back to
   * `'sending'` and either publishes (if connected) or re-queues (if not).
   * No-op if the id is unknown or its status is anything other than
   * `'failed'` — guards against double-publish if the user clicks Retry
   * twice in quick succession.
   *
   * @param {string} messageId
   */
  retryMessage(messageId) {
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg) return;
    if (msg.status !== 'failed') return;

    const topic = TOPIC_PREFIX + '/conv/' + (msg.channel || msg.conv || this.activeChannel) + '/messages';
    // Re-serialize without our internal `status` and `channel` fields —
    // they're local-echo metadata only, not part of the wire format.
    const wire = { ...msg };
    delete wire.status;
    delete wire.channel;
    const payload = JSON.stringify(wire);

    msg.status = 'sending';

    if (this.#client && this.connected) {
      this.#publishOutgoing(msg.id, topic, payload);
    } else {
      this.#queuePendingSend(msg.id, topic, payload);
    }
  }

  /**
   * Switch the active channel and clear its unread count.
   * No-op if already viewing the target channel.
   * @param {string} channelId - The channel to switch to.
   */
  switchChannel(channelId) {
    if (channelId === this.activeChannel) return;

    // Clear unread for old active
    const ch = this.channels.find(c => c.id === channelId);
    if (ch) {
      ch.unread = 0;
      ch.unreadFrom = null;
      this.#saveUnreadMarkers();
    }

    this.activeChannel = channelId;

    // Re-subscribe to new channel topics if needed
    if (this.#client && this.connected) {
      this.#subscribeAll();
    }

    // Fetch history and participants for the new channel
    this.#fetchHistory(channelId);
    this.#fetchParticipants(channelId);
  }

  /**
   * Create a new channel and switch to it.
   * Publishes retained metadata to the broker so other clients discover it.
   * No-op if a channel with the given ID already exists.
   * @param {string} id - Unique channel identifier (lowercase, dashes).
   * @param {string} topic - Short description shown in the channel header.
   */
  createChannel(id, topic = '') {
    if (this.channels.find(c => c.id === id)) return;

    this.channels = [...this.channels, { id, topic, starred: false, unread: 0 }];

    // Publish meta
    if (this.#client) {
      const metaTopic = TOPIC_PREFIX + '/conv/' + id + '/meta';
      this.#client.publish(metaTopic, JSON.stringify({
        conv_id: id,
        created_by: this.userProfile.key,
        created_at: new Date().toISOString(),
        topic
      }), { qos: 1, retain: true });
    }

    this.switchChannel(id);
  }

  /**
   * Toggle whether a channel is starred (pinned at the top of the sidebar).
   * @param {string} channelId - The channel to star/unstar.
   */
  toggleStar(channelId) {
    const ch = this.channels.find(c => c.id === channelId);
    if (ch) ch.starred = !ch.starred;
  }

  /**
   * Publish a typing indicator to the active channel.
   * Call this on keystrokes in the message input; the indicator
   * auto-expires after 3 seconds of inactivity.
   */
  notifyTyping() {
    if (this.#myTypingTimer) clearTimeout(this.#myTypingTimer);
    this.#publishTyping(true);
    this.#myTypingTimer = setTimeout(() => {
      this.#publishTyping(false);
    }, 3000);
  }

  /**
   * Mark a channel as having unread messages starting from a specific message.
   * @param {object} message - A message object; its channel/conv field is used to find the channel.
   */
  markUnread(message) {
    const ch = this.channels.find(c => c.id === (message.channel || message.conv || this.activeChannel));
    if (ch) {
      ch.unreadFrom = message.id;
      ch.unread = Math.max(ch.unread, 1);
      // Persist to localStorage so unread markers survive page refresh
      this.#saveUnreadMarkers();
    }
  }

  /**
   * Mark a thread as seen by advancing its per-thread seen-cursor to the
   * latest reply ts in the local message list. Called when ThreadPanel
   * opens for a root, mirroring how `markUnread`-cleared channels work
   * when the user switches to them. Persists to localStorage so the
   * seen state survives a page refresh.
   * @param {string} rootId - The thread root message id.
   */
  markThreadSeen(rootId) {
    if (!rootId) return;
    // Find the latest reply ts for this root in the current message list.
    let latestTs = null;
    for (const m of this.messages) {
      if (m.reply_to === rootId && (!latestTs || m.ts > latestTs)) {
        latestTs = m.ts;
      }
    }
    // Even when there are no replies yet (e.g. ThreadPanel opened on an
    // empty thread), stamp the cursor with the root's own ts so a later
    // arriving reply registers as unread immediately. Without this stamp
    // the chip would silently swallow the first reply because cursorTs
    // would still be null in `activeMessages`.
    if (!latestTs) {
      const root = this.messages.find(m => m.id === rootId);
      latestTs = root?.ts || new Date().toISOString();
    }
    this.threadSeenCursors = { ...this.threadSeenCursors, [rootId]: latestTs };
    this.#saveUnreadMarkers();
  }

  /**
   * Mark a message as "seen" (read) by the current user.
   * This is a local-only tracker — it updates the message's `read_by` count
   * so the ReadReceipt component shows meaningful data. Does not publish
   * over MQTT; real distributed read receipts would require a dedicated
   * topic (e.g., `conv/{channel}/read-cursors`).
   * @param {string} messageId - The ID of the message that was viewed.
   */
  markSeen(messageId) {
    if (this.#seenMessageIds.has(messageId)) return;
    this.#seenMessageIds.add(messageId);

    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return;

    // Only track reads on messages from other users
    if (msg.sender?.key === this.userProfile.key) return;

    // Increment the read_by count (used by ReadReceipt component)
    msg.read_by = (msg.read_by || 0) + 1;
  }

  /**
   * Delete a message by ID.
   * Replaces the messages array (immutable update) to trigger Svelte 5 reactivity.
   * @param {string} messageId - The ID of the message to remove.
   */
  deleteMessage(messageId) {
    const msg = this.messages.find(m => m.id === messageId);
    const channel = msg?.channel || msg?.conv || this.activeChannel;
    this.messages = this.messages.filter(m => m.id !== messageId);

    // Broadcast deletion to other clients
    if (this.#client && this.connected) {
      const topic = TOPIC_PREFIX + '/conv/' + channel + '/deletions';
      this.#client.publish(topic, JSON.stringify({
        message_id: messageId,
        sender: {
          key: this.userProfile.key,
          name: this.userProfile.name,
          type: this.userProfile.type
        }
      }), { qos: 1 });
    }
  }

  /**
   * Toggle muted flag on a channel (muted channels suppress notifications).
   * @param {string} channelId - The channel to mute/unmute.
   */
  muteChannel(channelId) {
    const ch = this.channels.find(c => c.id === channelId);
    if (ch) ch.muted = !ch.muted;
  }

  /**
   * Forward a message to a different channel.
   * Creates a new message with the same body and a `forwarded_from` reference.
   * @param {object} message - The original message object to forward.
   * @param {string} targetChannelId - The channel to forward the message to.
   */
  forwardMessage(message, targetChannelId) {
    const prevChannel = this.activeChannel;
    const msg = {
      id: generateUUID(),
      ts: new Date().toISOString(),
      sender: {
        key: this.userProfile.key,
        name: this.userProfile.name,
        type: this.userProfile.type
      },
      mentions: null,
      recipients: null,
      body: message.body,
      reply_to: null,
      conv: targetChannelId,
      forwarded_from: message.id
    };

    const topic = TOPIC_PREFIX + '/conv/' + targetChannelId + '/messages';

    // Local echo
    this.#handleChatMessage(targetChannelId, msg);

    if (this.#client && this.connected) {
      this.#client.publish(topic, JSON.stringify(msg), { qos: 1 });
    }
  }

  /**
   * Search messages across all channels.
   * @param {string} query
   * @returns {Array}
   */
  searchMessages(query) {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return this.messages.filter(m =>
      m.body.toLowerCase().includes(q)
    );
  }

  /**
   * Add or toggle a reaction emoji on a message.
   * If the user already reacted with this emoji, it is removed.
   *
   * Wire format (v4 of richer-expression-architecture):
   *   topic:   claude-comms/conv/{conv}/reactions  (retain=false)
   *   payload: {message_id, emoji, op: "toggle"|"add"|"remove", actor_key, ts}
   *
   * Client always publishes op="toggle" for user-initiated clicks; the server
   * resolves to add or remove based on current reaction state and persists
   * the resolved op to the JSONL log. The server then re-broadcasts the
   * resolved op to all subscribers.
   *
   * @param {string} messageId - The message to react to.
   * @param {string} emoji - The emoji character (or free-text token, <=32 chars).
   */
  addReaction(messageId, emoji) {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) {
      msg.reactions = [];
    }

    // Optimistic local update — server's re-broadcast will correct any drift.
    const existing = msg.reactions.find(r => r.emoji === emoji);
    if (existing) {
      if (existing.active) {
        existing.count--;
        existing.active = false;
        if (existing.count <= 0) {
          msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
        }
      } else {
        existing.count++;
        existing.active = true;
      }
    } else {
      msg.reactions.push({ emoji, count: 1, active: true });
    }

    // Broadcast toggle intent to server + other clients
    if (this.#client && this.connected) {
      const channel = msg.channel || msg.conv || this.activeChannel;
      const topic = TOPIC_PREFIX + '/conv/' + channel + '/reactions';
      this.#client.publish(topic, JSON.stringify({
        message_id: messageId,
        emoji,
        op: 'toggle',
        actor_key: this.userProfile.key,
        ts: new Date().toISOString()
      }), { qos: 1 });
    }
  }

  /**
   * Pin or unpin a message in its channel.
   * Pinned messages appear in the pinned-messages panel.
   * @param {object} message - The message object to pin/unpin.
   */
  togglePin(message) {
    const idx = this.pinnedMessages.findIndex(m => m.id === message.id);
    const channel = message.channel || message.conv || this.activeChannel;
    let action;
    if (idx >= 0) {
      this.pinnedMessages = this.pinnedMessages.filter(m => m.id !== message.id);
      action = 'unpin';
    } else {
      this.pinnedMessages = [...this.pinnedMessages, { ...message, channel }];
      action = 'pin';
    }

    // Broadcast pin/unpin to other clients
    if (this.#client && this.connected) {
      const topic = TOPIC_PREFIX + '/conv/' + channel + '/pins';
      this.#client.publish(topic, JSON.stringify({
        message_id: message.id,
        action,
        sender: {
          key: this.userProfile.key,
          name: this.userProfile.name,
          type: this.userProfile.type
        }
      }), { qos: 1 });
    }
  }

  // ── Private Methods ──

  /**
   * Persist unread markers (per-conv `unreadFrom` + `unread`, plus per-
   * thread seen cursors) to localStorage so they survive page refresh.
   * Per-thread cursors live alongside per-conv markers under a separate
   * top-level key — keeps the existing schema readable without nesting.
   */
  #saveUnreadMarkers() {
    const markers = {};
    for (const ch of this.channels) {
      if (ch.unreadFrom || ch.unread > 0) {
        markers[ch.id] = { unreadFrom: ch.unreadFrom || null, unread: ch.unread || 0 };
      }
    }
    safeStorage.setItem('claude-comms-unread-markers', JSON.stringify(markers));
    // Persist per-thread seen cursors separately. Empty object is fine —
    // the restore path tolerates a missing key.
    safeStorage.setItem(
      'claude-comms-thread-seen-cursors',
      JSON.stringify(this.threadSeenCursors || {}),
    );
  }

  /**
   * Restore unread markers from localStorage on startup. Reads both the
   * per-conv markers and the per-thread seen cursors.
   */
  #restoreUnreadMarkers() {
    const raw = safeStorage.getItem('claude-comms-unread-markers');
    if (raw) {
      try {
        const markers = JSON.parse(raw);
        for (const ch of this.channels) {
          if (markers[ch.id]) {
            ch.unreadFrom = markers[ch.id].unreadFrom || null;
            ch.unread = markers[ch.id].unread || 0;
          }
        }
      } catch {
        // Corrupt data — ignore
      }
    }
    const rawThread = safeStorage.getItem('claude-comms-thread-seen-cursors');
    if (rawThread) {
      try {
        const cursors = JSON.parse(rawThread);
        if (cursors && typeof cursors === 'object') {
          this.threadSeenCursors = cursors;
        }
      } catch {
        // Corrupt data — ignore
      }
    }
  }

  #subscribeAll() {
    if (!this.#client) return;

    // Subscribe to all conversations
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/messages', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/typing/+', { qos: 0 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/meta', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/reactions', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/activity', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/pins', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/deletions', { qos: 1 });

    // New global presence topic
    // Conversation lifecycle events broadcast by the daemon on mutate.
    // Issue B fix from the v0.3.1 follow-up brief: previously the channel
    // sidebar only refreshed on full page reload because conversation
    // creates / topic changes / deletes had no live channel. This
    // subscription pairs with #handleSystemConversation below.
    this.#client.subscribe(TOPIC_PREFIX + '/system/conversations', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/presence/+/+', { qos: 1 });
    // Old topics for migration compatibility (dual subscription)
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/presence/+', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/system/participants/+', { qos: 1 });
  }

  #handleMessage(topic, msg) {
    if (!topic.startsWith(TOPIC_PREFIX + '/')) return;
    const topicParts = topic.slice(TOPIC_PREFIX.length + 1).split('/');

    if (topicParts[0] === 'conv' && topicParts[2] === 'messages') {
      this.#handleChatMessage(topicParts[1], msg);
    } else if (topicParts[0] === 'presence') {
      // Global presence: presence/{key}/{client}-{instanceId}. No
      // conversation context — pass null and the handler won't touch
      // channelMembers.
      this.#handlePresence(msg, null);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'presence') {
      // Per-conversation presence: conv/{convId}/presence/{key}. The
      // conversation is encoded in the topic; pass it through so the
      // handler can record channelMembers[convId][key].
      this.#handlePresence(msg, topicParts[1]);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'typing') {
      this.#handleTyping(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'meta') {
      this.#handleMeta(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'reactions') {
      this.#handleRemoteReaction(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'activity') {
      this.#handleRemoteActivity(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'pins') {
      this.#handleRemotePin(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'deletions') {
      this.#handleRemoteDeletion(topicParts[1], msg);
    } else if (topicParts[0] === 'system' && topicParts[1] === 'participants') {
      // Old system/participants topic (migration compat)
      this.#handleParticipantRegistry(msg);
    } else if (topicParts[0] === 'system' && topicParts[1] === 'conversations') {
      // Conversation lifecycle event (v0.3.2+).
      this.#handleSystemConversation(msg);
    }
  }

  /**
   * React to a ``claude-comms/system/conversations`` broadcast.
   *
   * Wire format (set by ``publish_conversation_event`` in mcp_server.py)::
   *
   *     { type: "conversation_created" | "conversation_topic_changed"
   *             | "conversation_deleted",
   *       name: "<conv-id>",
   *       topic: "<optional>",
   *       creator_key: "<8-hex on create>",
   *       ts: "<ISO8601>" }
   *
   * Updates the in-store ``channels`` array so the left sidebar reflects
   * remote conversation mutations live, instead of waiting for the next
   * page reload. The REST snapshot remains the authoritative source on
   * page bootstrap; this handler is the live-delta layer on top.
   */
  #handleSystemConversation(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.name !== 'string') return;
    const name = msg.name;
    switch (msg.type) {
      case 'conversation_created': {
        // Insert if not present. Don't clobber unread / starred state if
        // the user had previously cached this channel locally.
        if (!this.channels.some((c) => c.id === name)) {
          this.channels = [
            ...this.channels,
            {
              id: name,
              topic: typeof msg.topic === 'string' ? msg.topic : '',
              starred: false,
              unread: 0,
            },
          ];
        }
        break;
      }
      case 'conversation_topic_changed': {
        const idx = this.channels.findIndex((c) => c.id === name);
        if (idx >= 0 && typeof msg.topic === 'string') {
          // Immutable update -- Svelte 5 $state arrays track identity on
          // reassignment, not in-place mutation.
          this.channels = this.channels.map((c, i) =>
            i === idx ? { ...c, topic: msg.topic } : c,
          );
        }
        break;
      }
      case 'conversation_deleted': {
        const filtered = this.channels.filter((c) => c.id !== name);
        if (filtered.length !== this.channels.length) {
          this.channels = filtered;
        }
        // If the user was viewing the deleted channel, fall back to general.
        if (this.activeChannel === name) {
          this.activeChannel = 'general';
        }
        break;
      }
      default:
        // Unknown event type — ignore. Forward-compat: a newer daemon
        // could add types this web build doesn't recognize.
        break;
    }
  }

  #handleChatMessage(channel, msg) {
    // Deduplicate
    if (this.#seenIds.has(msg.id)) return;
    this.#seenIds.add(msg.id);

    // Bound the seen set
    if (this.#seenIds.size > 10000) {
      const iter = this.#seenIds.values();
      for (let i = 0; i < 1000; i++) {
        this.#seenIds.delete(iter.next().value);
      }
    }

    const message = {
      ...msg,
      channel: channel || msg.conv
    };

    // Immutable reassignment triggers $derived recalculation.
    // NOTE: Do NOT wrap in setTimeout — deferred updates break $derived
    // tracking in Svelte 5 class-based stores, causing messages to not
    // render even though they're in the array.
    this.messages = [...this.messages, message];

    // Cap the messages array to prevent unbounded growth
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }

    // Update unread count if not active channel
    if (channel !== this.activeChannel) {
      const ch = this.channels.find(c => c.id === channel);
      if (ch) ch.unread++;
    }

    // Real-time artifact panel refresh (plan §1): any chat message carrying
    // an artifact_ref for the currently-viewed channel bumps the counter.
    // The panel debounces 150ms and decides (via isOurRecentUpdate) whether
    // to show the remote-update banner. Bumping on every message tick is
    // fine — it's a coalescing signal, not a work unit.
    if (msg.artifact_ref && channel === this.activeChannel) {
      this.artifactsDirty++;
      // Parse out the sender name + version from the system-message body
      // so panel consumers can render the remote-update banner without
      // refetching first. Format per mcp_tools.py:
      //   create: "[artifact] {name} created '{title}' (v1)"
      //   update: "[artifact] {name} updated '{title}' to v{N}[: summary]"
      const parsed = this.#parseArtifactRefBody(msg.body ?? '');
      this.latestArtifactRefNotification = {
        name: msg.artifact_ref,
        version: parsed.version,
        senderName: parsed.senderName,
        // Epoch counter so two back-to-back notifications with identical
        // shape still re-fire subscriber effects.
        epoch: (this.latestArtifactRefNotification?.epoch ?? 0) + 1,
      };
    }
  }

  /**
   * Best-effort parse of an `[artifact] ...` system-message body into the
   * `{ senderName, version }` fragment needed by the remote-update banner.
   * Returns `{ senderName: '', version: null }` if the body does not match
   * either of the known formats.
   * @param {string} body
   * @returns {{ senderName: string, version: number | null }}
   */
  #parseArtifactRefBody(body) {
    // Update format takes precedence — more common post-v1.
    //   [artifact] Phil updated 'Title' to v3: summary
    //   [artifact] Phil updated 'Title' to v3
    let m = body.match(/^\[artifact\]\s+(.+?)\s+updated\s+'.*?'\s+to\s+v(\d+)/);
    if (m) {
      return { senderName: m[1], version: Number(m[2]) };
    }
    // Create format:
    //   [artifact] Phil created 'Title' (v1)
    m = body.match(/^\[artifact\]\s+(.+?)\s+created\s+'.*?'\s+\(v(\d+)\)/);
    if (m) {
      return { senderName: m[1], version: Number(m[2]) };
    }
    return { senderName: '', version: null };
  }

  /**
   * Record that the current user just POSTed a new version of `name` that
   * became version `version`. The entry is kept for 5 seconds so the echoed
   * MQTT message (which will land ~instantly) can be recognised and skip
   * the remote-update banner trigger. Called by the panel editor's
   * save-success handler, before the MQTT echo arrives.
   * @param {string} name - Artifact name.
   * @param {number|string} version - Version number returned by the POST response.
   */
  markSelfUpdate(name, version) {
    this.#recentlySelfUpdated.set(`${name}:${version}`, Date.now() + 5000);
    this.#pruneSelfUpdated();
  }

  /**
   * Return true if a (name, version) pair was recorded by `markSelfUpdate`
   * within the last 5 seconds. Prunes expired entries as a side-effect so
   * the Map stays bounded.
   * @param {string} name
   * @param {number|string} version
   * @returns {boolean}
   */
  isOurRecentUpdate(name, version) {
    this.#pruneSelfUpdated();
    return this.#recentlySelfUpdated.has(`${name}:${version}`);
  }

  /** Drop entries whose expiry timestamp has passed. */
  #pruneSelfUpdated() {
    const now = Date.now();
    for (const [k, e] of this.#recentlySelfUpdated) {
      if (e < now) this.#recentlySelfUpdated.delete(k);
    }
  }

  #handlePresence(msg, conversation = null) {
    const { key, name, type, status, client, instanceId, ts } = msg;

    // Extract base client type and validate
    const baseClient = client;
    if (!baseClient || !CONNECTION_TYPES.includes(baseClient)) return;

    // Build connection key: "web-3f2a" (or bare "web" for legacy messages without instanceId)
    const connKey = instanceId ? baseClient + '-' + instanceId : baseClient;

    // Skip our own web presence instances (self-add handles them)
    if (key === this.userProfile.key && baseClient === 'web'
        && instanceId === this.#instanceId) return;

    if (status === 'online') {
      // Create user if not exists
      if (!this.participants[key]) {
        this.participants[key] = { key, name, type, connections: {}, lastOffline: null };
      }
      // Add/update connection
      this.participants[key].connections[connKey] = {
        client: baseClient,
        instanceId: instanceId || null,
        since: this.participants[key].connections[connKey]?.since || ts,
        lastSeen: ts || new Date().toISOString()
      };
      // Clear offline timestamp since user is now online
      this.participants[key].lastOffline = null;
      // Update name/type in case they changed
      this.participants[key].name = name;
      this.participants[key].type = type;

      // v0.3.2: if this presence arrived on a conv-scoped topic, the
      // sender is a member of that conversation. Record it so the
      // 3-section MemberList can show "in #X" for participants who
      // appear globally but aren't in the active channel.
      if (conversation) {
        if (!this.channelMembers[conversation]) {
          this.channelMembers[conversation] = {};
        }
        this.channelMembers[conversation][key] = ts || new Date().toISOString();
      }
    } else if (status === 'offline') {
      if (this.participants[key]) {
        delete this.participants[key].connections[connKey];
        // If no connections left, mark as offline (keep for display)
        if (Object.keys(this.participants[key].connections).length === 0) {
          this.participants[key].lastOffline = new Date().toISOString();
        }
      }
      // Don't prune channelMembers on offline — membership outlasts
      // a single online/offline cycle. REST poll authoritative.
    }
  }

  #handleTyping(channel, msg) {
    this.typingUsers[msg.key] = {
      typing: msg.typing,
      ts: msg.ts,
      channel
    };

    // Auto-expire typing indicator
    if (msg.typing) {
      if (this.#typingTimers[msg.key]) clearTimeout(this.#typingTimers[msg.key]);
      this.#typingTimers[msg.key] = setTimeout(() => {
        if (this.typingUsers[msg.key]) {
          this.typingUsers[msg.key] = { ...this.typingUsers[msg.key], typing: false };
        }
      }, TYPING_TTL_MS);
    }
  }

  #handleMeta(channelId, msg) {
    const existing = this.channels.find(c => c.id === channelId);
    if (!existing) {
      this.channels = [...this.channels, { id: channelId, topic: msg.topic || '', starred: false, unread: 0 }];
    } else if (msg.topic) {
      existing.topic = msg.topic;
    }
  }

  /**
   * Handle old-style system/participants messages (migration compat).
   * Converts composite key messages into the new connection-aware model.
   */
  #handleParticipantRegistry(msg) {
    if (!msg.key) return;
    const baseClient = msg.client || 'unknown';
    if (!CONNECTION_TYPES.includes(baseClient)) return;

    // Skip own web entries — managed by self-add
    if (msg.key === this.userProfile.key && baseClient === 'web') return;

    const connKey = msg.instanceId ? baseClient + '-' + msg.instanceId : baseClient;

    if (!this.participants[msg.key]) {
      this.participants[msg.key] = {
        key: msg.key,
        name: msg.name,
        type: msg.type,
        connections: {},
        lastOffline: null,
      };
    }

    if (msg.status === 'offline') {
      delete this.participants[msg.key].connections[connKey];
      if (Object.keys(this.participants[msg.key].connections).length === 0) {
        this.participants[msg.key].lastOffline = new Date().toISOString();
      }
    } else {
      const now = new Date().toISOString();
      this.participants[msg.key].connections[connKey] = {
        client: baseClient,
        instanceId: msg.instanceId || null,
        since: this.participants[msg.key].connections[connKey]?.since || now,
        lastSeen: now
      };
      this.participants[msg.key].lastOffline = null;
    }

    // Update name/type
    this.participants[msg.key].name = msg.name;
    this.participants[msg.key].type = msg.type;
  }

  #handleRemoteReaction(channel, msg) {
    // v4 wire format: {message_id, emoji, op, actor_key, ts}
    // Server resolves "toggle" before re-broadcasting, so we only see add/remove here.
    // Tolerate legacy "action" field and "sender.key" actor for clients that haven't
    // upgraded yet — strip after a deprecation window.
    const op = msg.op || msg.action;
    const actorKey = msg.actor_key || msg.sender?.key;

    // Ignore our own broadcasts (we already applied locally via optimistic update)
    if (actorKey === this.userProfile.key) return;

    const target = this.messages.find(m => m.id === msg.message_id);
    if (!target) return;

    if (!target.reactions) target.reactions = [];

    if (op === 'add') {
      const existing = target.reactions.find(r => r.emoji === msg.emoji);
      if (existing) {
        existing.count++;
      } else {
        target.reactions.push({ emoji: msg.emoji, count: 1, active: false });
      }
    } else if (op === 'remove') {
      const existing = target.reactions.find(r => r.emoji === msg.emoji);
      if (existing) {
        existing.count--;
        if (existing.count <= 0) {
          target.reactions = target.reactions.filter(r => r.emoji !== msg.emoji);
        }
      }
    }
  }

  /**
   * Handle a live activity event for a participant in a conversation.
   * Wire format (richer-expression v4, sage's checkpoint #3):
   *   topic:   claude-comms/conv/{conv}/activity (retain=false)
   *   set payload:   {key, name, type, conversation, op:"set",   activity:{label,set_at,expires_at}}
   *   clear payload: {key, name, type, conversation, op:"clear", activity:null}
   *
   * Mutates the matching participant's connection records to reflect the
   * change, so MemberList.getActivity() and store.activeActivities pick up
   * the new state reactively.
   *
   * @param {string} channel - Conversation slug from the topic.
   * @param {object} msg - Decoded activity event payload.
   */
  #handleRemoteActivity(channel, msg) {
    if (!msg || typeof msg.key !== 'string') return;
    const p = this.participants[msg.key];
    // Surface the event even if we don't yet have a participant record:
    // create a minimal stub so the next presence event can fill it in.
    const target = p || (this.participants[msg.key] = {
      key: msg.key,
      name: msg.name || msg.key,
      type: msg.type || 'claude',
      connections: {},
      lastOffline: null,
    });

    const newActivity = msg.op === 'set' && msg.activity ? {
      label: String(msg.activity.label || '').slice(0, 32),
      set_at: msg.activity.set_at || new Date().toISOString(),
      expires_at: msg.activity.expires_at || null,
    } : null;

    // Apply to all known connections of this participant. The server already
    // applied to all of them in mcp_tools.tool_comms_status_set; the wire
    // event just announces the change. If we have no connections (rare race
    // before the participant's presence has arrived), stash on a pending
    // field that the next presence event can roll into a real connection.
    const conns = target.connections || {};
    const connKeys = Object.keys(conns);
    if (connKeys.length === 0) {
      target._pendingActivity = newActivity;
    } else {
      for (const ck of connKeys) {
        if (newActivity) {
          conns[ck].activity = newActivity;
        } else {
          delete conns[ck].activity;
        }
      }
    }

    // Trigger reactivity by re-assigning the participants object.
    this.participants = { ...this.participants };
  }

  #handleRemotePin(channel, msg) {
    if (msg.sender?.key === this.userProfile.key) return;

    if (msg.action === 'pin') {
      // Only add if not already pinned
      if (!this.pinnedMessages.find(m => m.id === msg.message_id)) {
        const target = this.messages.find(m => m.id === msg.message_id);
        if (target) {
          this.pinnedMessages = [...this.pinnedMessages, { ...target, channel }];
        }
      }
    } else if (msg.action === 'unpin') {
      this.pinnedMessages = this.pinnedMessages.filter(m => m.id !== msg.message_id);
    }
  }

  #handleRemoteDeletion(channel, msg) {
    if (msg.sender?.key === this.userProfile.key) return;

    this.messages = this.messages.filter(m => m.id !== msg.message_id);
    // Also remove from pinned if it was pinned
    this.pinnedMessages = this.pinnedMessages.filter(m => m.id !== msg.message_id);
  }

  /**
   * Activate exponential backoff after repeated connection failures.
   * Disconnects the mqtt.js auto-reconnect loop, then schedules a single
   * manual reconnect attempt with increasing delay (up to MAX_RECONNECT_MS).
   * The app remains functional in local-only mode while waiting.
   */
  #activateBackoff() {
    this.#backoffActive = true;

    // Stop mqtt.js's built-in reconnect loop to avoid hammering the broker
    if (this.#client) {
      this.#client.options.reconnectPeriod = 0;
    }

    const attempt = this.#failureCount - BACKOFF_AFTER_ATTEMPTS;
    const delayMs = Math.min(BASE_RECONNECT_MS * Math.pow(2, attempt), MAX_RECONNECT_MS);
    const delaySec = Math.round(delayMs / 1000);

    this.connectionError = 'Broker unreachable after ' + this.#failureCount +
      ' attempts — retrying in ' + delaySec + 's. App works in local-only mode.';

    this.#backoffTimer = setTimeout(() => {
      this.#backoffTimer = null;
      this.#backoffActive = false;
      if (this.#client) {
        // Re-enable reconnect and trigger one attempt
        this.#client.options.reconnectPeriod = BASE_RECONNECT_MS;
        this.connectionError = 'Reconnecting to broker...';
        this.#client.reconnect();
      }
    }, delayMs);
  }

  #publishPresence(status) {
    if (!this.#client) return;
    const connKey = 'web-' + this.#instanceId;
    const topic = TOPIC_PREFIX + '/presence/' + this.userProfile.key + '/' + connKey;
    this.#client.publish(topic, JSON.stringify({
      key: this.userProfile.key,
      name: this.userProfile.name,
      type: this.userProfile.type,
      status,
      client: 'web',
      instanceId: this.#instanceId,
      ts: new Date().toISOString()
    }), { qos: 1, retain: true });
  }

  /** Stop the heartbeat timer. */
  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  /** Stop the TTL cleanup timer. */
  #stopTtlCleanup() {
    if (this.#ttlCleanupTimer) {
      clearInterval(this.#ttlCleanupTimer);
      this.#ttlCleanupTimer = null;
    }
  }

  /**
   * TTL cleanup: remove stale connections (>120s lastSeen) and
   * offline users (>5 min). Publishes empty retained to clean broker
   * for stale connections (handles crash scenarios).
   */
  #runTtlCleanup() {
    const now = Date.now();
    const connKey = 'web-' + this.#instanceId;

    for (const [userKey, participant] of Object.entries(this.participants)) {
      // Check each connection for staleness
      for (const [ck, conn] of Object.entries(participant.connections)) {
        // Don't expire our own connection
        if (userKey === this.userProfile.key && ck === connKey) continue;

        const lastSeen = conn.lastSeen ? new Date(conn.lastSeen).getTime() : 0;
        if (now - lastSeen > CONNECTION_TTL_MS) {
          delete participant.connections[ck];
          // Publish empty retained to clean broker (stale retained cleanup)
          if (this.#client) {
            const staleTopic = TOPIC_PREFIX + '/presence/' + userKey + '/' + ck;
            this.#client.publish(staleTopic, '', { retain: true });
          }
        }
      }

      // If no connections remain, set lastOffline if not already set
      if (Object.keys(participant.connections).length === 0) {
        if (!participant.lastOffline) {
          participant.lastOffline = new Date().toISOString();
        }
        // Remove offline users after 5 minutes
        const offlineSince = new Date(participant.lastOffline).getTime();
        if (now - offlineSince > OFFLINE_DISPLAY_MS) {
          // Don't remove ourselves
          if (userKey !== this.userProfile.key) {
            delete this.participants[userKey];
          }
        }
      }
    }
  }

  #publishTyping(typing) {
    if (!this.#client) return;
    const topic = TOPIC_PREFIX + '/conv/' + this.activeChannel + '/typing/' + this.userProfile.key;
    this.#client.publish(topic, JSON.stringify({
      key: this.userProfile.key,
      typing,
      ts: new Date().toISOString()
    }), { qos: 0 });
  }
}
