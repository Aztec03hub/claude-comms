import mqtt from 'mqtt';
import { generateUUID, generateKey } from './utils.js';
import { API_BASE } from './api.js';

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
  channels = $state([
    { id: 'general', topic: 'Main discussion channel for the team', starred: false, unread: 0 },
    { id: 'project-alpha', topic: 'Project Alpha development', starred: true, unread: 0 },
    { id: 'lora-training', topic: 'LoRA training runs and results', starred: true, unread: 0 },
    { id: 'random', topic: 'Off-topic and fun', starred: false, unread: 0 },
  ]);
  activeChannel = $state('general');
  participants = $state({});
  connected = $state(false);
  connectionError = $state(null);
  typingUsers = $state({});
  pinnedMessages = $state([]);
  inAppToasts = $state(true);
  userProfile = $state({
    key: '',
    name: 'Phil',
    type: 'human'
  });

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
      // active channel. The server's participant list is the source of truth
      // for this channel's membership — any local-only MQTT presence state is
      // from a previous session (typical cause: daemon restart leaves retained
      // presence messages on the broker, which the web client sees on
      // reconnect and ghosts as "offline" forever).
      //
      // Pruning here removes the participant entry entirely. We also publish
      // an empty retained presence for any of their stale MQTT connections so
      // the broker's retained store gets cleaned up too — otherwise the next
      // page load would re-ghost the same key.
      //
      // Guards: only prune when polling for the active channel, and never the
      // local user's own entry. Unlike the previous version, we DO prune even
      // when local connections are non-empty — those connections are stale
      // retained-presence messages, not live participants.
      if (channel === this.activeChannel) {
        for (const localKey of Object.keys(this.participants)) {
          if (localKey === this.userProfile.key) continue;
          if (serverKeys.has(localKey)) continue;
          const local = this.participants[localKey];
          if (!local) continue;
          // Clean up any retained presence on the broker for this ghost.
          if (this.#client && local.connections) {
            for (const ck of Object.keys(local.connections)) {
              const staleTopic = TOPIC_PREFIX + '/presence/' + localKey + '/' + ck;
              this.#client.publish(staleTopic, '', { retain: true });
            }
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
  // $derived.by() with explicit dependency reads to ensure Svelte 5
  // tracks mutations from async MQTT callbacks (Bug #4 fix).
  activeMessages = $derived.by(() => {
    // Read .length to ensure proxy dependency is registered
    const _len = this.messages.length;
    const _ch = this.activeChannel;
    const _cursors = this.threadSeenCursors;
    // Top-level only: thread replies (reply_to !== null) live in the right-
    // side ThreadPanel data source (`activeChannelReplies` below), not the
    // main timeline. Plan §5 — channel feed is roots only; chip on the root
    // (MessageBubble.thread-indicator) signals reply count.
    //
    // Splice `thread_unread_count` onto each root from the per-thread seen-
    // cursor (client-side, mirrors the per-conv `ch.unreadFrom` / `ch.unread`
    // pattern at this:782,991-1015). Phoenix's `comms_check.thread_unread`
    // MCP field serves non-web clients; web computes the same shape locally.
    const roots = this.messages.filter(m => m.channel === _ch && !m.reply_to);
    const replies = this.messages.filter(m => m.channel === _ch && m.reply_to);
    return roots.map(root => {
      if (!root.thread_reply_count) return root;
      const cursorTs = _cursors[root.id] || null;
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
  activeChannelReplies = $derived.by(() => {
    const _len = this.messages.length;
    const _ch = this.activeChannel;
    return this.messages.filter(m => m.channel === _ch && m.reply_to);
  });

  activeChannelMeta = $derived.by(() => {
    const _len = this.channels.length;
    const _ch = this.activeChannel;
    return this.channels.find(c => c.id === _ch);
  });

  starredChannels = $derived.by(() => {
    const _len = this.channels.length;
    return this.channels.filter(c => c.starred);
  });

  onlineParticipants = $derived.by(() => {
    const _p = this.participants;
    return Object.values(_p).filter(p => Object.keys(p.connections).length > 0);
  });

  // Offline = entry exists but connections is empty (kept briefly for display)
  offlineParticipants = $derived.by(() => {
    const _p = this.participants;
    return Object.values(_p).filter(p => Object.keys(p.connections).length === 0);
  });

  activeTypingUsers = $derived.by(() => {
    const _t = this.typingUsers;
    const _ch = this.activeChannel;
    const _key = this.userProfile.key;
    return Object.entries(_t)
      .filter(([key, info]) => {
        return info.channel === _ch
          && info.typing
          && key !== _key
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
    const _p = this.participants;
    const _ch = this.activeChannel;
    const _key = this.userProfile.key;
    const now = Date.now();
    const out = [];
    for (const [key, p] of Object.entries(_p)) {
      if (key === _key) continue;
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
    return _ch ? out : out;
  });

  activePinnedMessages = $derived.by(() => {
    const _len = this.pinnedMessages.length;
    const _ch = this.activeChannel;
    return this.pinnedMessages.filter(m => m.channel === _ch);
  });

  onlineCount = $derived.by(() => {
    return this.onlineParticipants.length;
  });

  /** Total number of messages across all channels. */
  messageCount = $derived.by(() => {
    return this.messages.length;
  });

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
    // Falls back to localStorage if the daemon is not running.
    try {
      const res = await fetch(API_BASE + '/api/identity');
      if (res.ok) {
        const identity = await res.json();
        this.userProfile.key = identity.key;
        this.userProfile.name = identity.name;
        this.userProfile.type = identity.type;
      }
    } catch {
      console.error('[claude-comms] Failed to fetch identity from', API_BASE + '/api/identity');
    }

    // If identity fetch failed (shouldn't happen — daemon serves this page),
    // generate a temporary key. No localStorage caching — the daemon config
    // is the single source of truth for identity.
    if (!this.userProfile.key) {
      this.userProfile.key = generateKey();
      this.userProfile.name = 'Anonymous';
    }

    // Restore user name from localStorage only (not key — key comes from daemon)
    if (!this.userProfile.name || this.userProfile.name === 'Phil') {
      const storedName = safeStorage.getItem('claude-comms-user-name');
      if (storedName) this.userProfile.name = storedName;
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
      try {
        const msg = JSON.parse(payload.toString());
        this.#handleMessage(topic, msg);
      } catch (e) {
        console.error('Failed to parse MQTT message:', e);
      }
    });
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
      conv: this.activeChannel
    };

    const topic = TOPIC_PREFIX + '/conv/' + this.activeChannel + '/messages';

    // Local echo: add message immediately so it appears even without broker
    this.#handleChatMessage(this.activeChannel, msg);

    if (this.#client && this.connected) {
      this.#client.publish(topic, JSON.stringify(msg), { qos: 1 });
    }

    // Stop typing indicator
    this.#publishTyping(false);
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
   * Triggers reactivity via self-assignment.
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

    // Trigger reactivity via self-assignment (avoids O(n) array copy)
    this.messages = this.messages;

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
      // New global presence: presence/{key}/{client}-{instanceId}
      this.#handlePresence(msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'presence') {
      // Old per-conversation presence (migration compat)
      this.#handlePresence(msg);
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

  #handlePresence(msg) {
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
    } else if (status === 'offline') {
      if (this.participants[key]) {
        delete this.participants[key].connections[connKey];
        // If no connections left, mark as offline (keep for display)
        if (Object.keys(this.participants[key].connections).length === 0) {
          this.participants[key].lastOffline = new Date().toISOString();
        }
      }
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

    // Trigger reactivity via self-assignment (avoids O(n) array copy)
    this.messages = this.messages;
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
