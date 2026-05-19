import mqtt from 'mqtt';
import { generateUUID, generateKey } from './utils.js';
import { API_BASE, apiGet, apiPost, mcpCall } from './api.js';

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

/**
 * v0.4.0 Step 2.6 — destructive channel-lifecycle methods (``archiveChannel``,
 * ``leaveChannel``) return ``{ done, cancel }`` and give the caller this
 * many milliseconds to abort the underlying MCP call. Matches the Design
 * Spec §10 "Undo" toast affordance. Exported only via the test seam to
 * keep the public surface trim.
 */
const UNDO_WINDOW_MS = 15_000;

/**
 * Allowed mute levels per Design Spec §8.2. ``"off"`` is the default
 * (no mute). ``"all"`` suppresses every notification including mentions;
 * ``"mentions"`` only fires on @mentions. Q4 lock keeps mute persistence
 * client-side (localStorage) in v0.4.0 — no MCP tool involved.
 */
const MUTE_LEVELS = ['off', 'mentions', 'all'];

/** localStorage key prefix for per-channel star state (Q4-adjacent local lock). */
const STAR_STORAGE_PREFIX = 'claude-comms.star.';

/** localStorage key prefix for per-channel mute level (Q4 lock — local only). */
const MUTE_STORAGE_PREFIX = 'claude-comms.mute.';

/**
 * v0.4.2 Step 3.9 (Wave G) — per-channel notification policy localStorage
 * key prefix. Stores a JSON-encoded `{policy, highlightWords}` blob keyed
 * by channel id. Defaults (when no entry exists) are
 * ``{policy: 'All', highlightWords: []}``. Policy strings are
 * capitalized (``'All' | 'Mentions' | 'Off'``) to keep this surface
 * distinct from the legacy ``muteLevel`` strings (lowercase
 * ``'off' | 'mentions' | 'all'``); the two are independent — legacy
 * mute drives the row's opacity reducer, the new policy drives the
 * toast handler's gate (App.svelte) + the SidebarChannelRow bell-icon
 * variant. Q7 (highlight-words) lives in the same blob so a single
 * read/write round-trip covers both.
 */
const NOTIF_POLICY_STORAGE_PREFIX = 'cc:notif-policy:';

/** Valid policy strings for the v0.4.2 Step 3.9 per-channel notification policy. */
const NOTIF_POLICIES = ['All', 'Mentions', 'Off'];

/** Cycle order for Q8 kebab quickview 1-click cycle (All → Mentions → Off → All). */
const NOTIF_POLICY_CYCLE = {
  All: 'Mentions',
  Mentions: 'Off',
  Off: 'All',
};

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
   * Channel map keyed by channel id. v0.4.0 Step 2.6: the array shape from
   * Step 2.5 is now backed by a map so lookups are O(1) and the per-row
   * shape can carry the full ChannelRow data contract (Design Spec §13.4)
   * without scanning a list. The legacy ``channels`` array surface stays
   * as a ``$derived`` view (insertion-order ``Object.values``) so existing
   * consumers (``Sidebar.svelte`` / ``ForwardPicker.svelte`` /
   * ``ConversationBrowser.svelte`` / ``App.svelte``) continue to compile
   * unchanged until Step 2.12 rewrites the sidebar.
   *
   * ChannelRow fields per Design Spec §13.4 (no ``undefined`` leaks):
   *   - ``id``, ``name``, ``topic``: identity + UX labels
   *   - ``member`` (bool): is the caller a member?
   *   - ``memberCount`` (int): total members
   *   - ``lastActivity`` (ISO string | null)
   *   - ``mode``: ``"public" | "private"``
   *   - ``visibility``: ``"public" | "private"`` (v0.4.2 Step 3.6b pinned
   *     these as the wire-side values; the legacy ``"listed"``/
   *     ``"unlisted"`` strings were retired in Wave C's frontend
   *     reconciliation step alongside the renameChannel display_name shift)
   *   - ``starred``, ``muted``, ``unread``, ``unreadHasMention``: caller's
   *     per-row personalization
   *   - ``unreadFrom`` (legacy v0.3.x marker, kept for back-compat)
   *   - ``muteLevel``: ``"off" | "mentions" | "all"`` (Q4 lock — local)
   *   - ``createdAt``, ``createdBy``
   *   - ``archived`` (bool), ``archived_at``, ``archived_by`` (v0.4.0)
   *
   * Wire-side rename (Step 2.1 contract): ``myUnread``/``myStarred``/
   * ``myMuted`` lose the ``my`` prefix in the store-internal shape; see
   * ``#channelRowFromPayload``.
   *
   * @type {Record<string, object>}
   */
  channelsById = $state({});

  /**
   * Back-compat array view of ``channelsById``. Preserves insertion order
   * (``Object.values`` of a non-frozen object). Pre-Step-2.12 consumers
   * call ``store.channels.filter(...)`` / ``.find(...)`` / ``.map(...)``;
   * those continue to work unchanged here. Step 2.12's sidebar rewrite
   * will switch to the four section ``$derived`` projections below.
   *
   * @type {object[]}
   */
  channels = $derived(Object.values(this.channelsById));
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
   * v0.4.2 Step 3.9 (Wave G) — reactive per-channel notification-policy
   * cache. Keyed by channel id; values shape ``{policy, highlightWords}``
   * with policy in ``'All' | 'Mentions' | 'Off'`` and highlightWords as a
   * lowercased string[]. Populated lazily by ``getNotificationPolicy``
   * from localStorage on first read, then in-memory for the lifetime of
   * the session. Writes go through ``setNotificationPolicy`` which
   * re-encodes to localStorage AND replaces the map entry so $derived
   * consumers (NotificationPolicyMenu, ChannelContextMenu quickview,
   * SidebarChannelRow bell variant, App.svelte toast gate) re-render.
   * @type {Record<string, {policy: 'All' | 'Mentions' | 'Off', highlightWords: string[]}>}
   */
  notificationPolicies = $state({});
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
    type: 'human',
    /**
     * Profile status (UX G-24, v0.4.2 Step 3.13). Either ``null`` ("no
     * status set") OR an object with the three Wave A2 keys verbatim:
     *   { emoji: string|null, text: string|null, expires_at: string|null }
     * Snake-case ``expires_at`` mirrors the MCP boundary so wire-state
     * round-trips don't need a key-rename layer.
     */
    profileStatus: null,
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

  /**
   * Reactive single-slot payload describing the latest channel-lifecycle
   * event the user should see as a toast. Set by ``#emitChannelLifecycleToast``
   * when a ``deleted`` or ``archived`` event lands on
   * ``system/conversations`` (v0.4.0 Step 2.7); App.svelte subscribes via
   * a ``$effect`` and renders a transient pill ("#<name> was deleted by
   * <user>" / "#<name> was archived by <user>").
   *
   * Shape:
   *   `{ kind: 'deleted' | 'archived',
   *      channelId: string,
   *      channelName: string,
   *      by: string | null,
   *      epoch: number,
   *      ts: string }`
   *
   * The `epoch` mirrors the pattern used by `latestArtifactRefNotification`
   * so two back-to-back toasts with otherwise identical payloads still
   * re-fire the consumer's effect. Suppressed entirely when
   * `inAppToasts === false` (Settings opt-out).
   *
   * @type {{
   *   kind: 'deleted' | 'archived',
   *   channelId: string,
   *   channelName: string,
   *   by: string | null,
   *   epoch: number,
   *   ts: string,
   * } | null}
   */
  latestChannelLifecycleToast = $state(null);

  /**
   * v0.4.2 Step 3.6 (expanded): reactive cache of per-channel role
   * lookups consumed by ``ChannelAdminPanel`` (and Wave E's future
   * ``MemberContextMenu``). Keys are channel ids; values are
   * ``'owner' | 'admin' | 'member' | null`` per the Q6 role lattice
   * locked in by v0.4.2 Step 3.0a (architecture spec §III.4).
   *
   * Hydration path (Wave B [VERIFY], see worklog):
   *   - There is NO backend MCP wrapper that exposes
   *     ``RegistryStore.get_channel_role`` yet. Until a Wave C / Wave B.5
   *     step lands ``comms_get_channel_role``, ``getChannelRole`` uses
   *     CLIENT-SIDE INFERENCE only:
   *       * ``channel.createdBy === userProfile.key`` (or legacy
   *         display-name match per 3.0a's grandfather backfill)
   *         → ``'owner'``
   *       * any other caller → ``'member'``
   *       * ``'admin'`` is never synthesized client-side
   *   - When the MCP wrapper lands, ``getChannelRole`` will hydrate this
   *     cache async on bootstrap + channel-join; consumers already
   *     subscribed via ``$state`` reactivity will re-render without
   *     prop changes.
   *
   * Plain ``$state`` object (NOT ``$state.raw``) so per-channel writes
   * via ``cache[id] = role`` trigger reactivity on consumers reading
   * ``cache[id]``, same model the bootstrap uses for
   * ``channelsById``.
   *
   * @type {Record<string, 'owner' | 'admin' | 'member' | null>}
   */
  channelRoles = $state({});

  /**
   * v0.4.2 Step 3.5b (Wave E.4): reactive in-memory mirror of the
   * per-user global-mute localStorage state. Keyed by participant key
   * (8 hex chars); values are ``true`` when muted, absent otherwise.
   *
   * Source of truth across reloads is localStorage under
   * ``cc:user-muted:{targetKey}``; this $state map is the reactive
   * view so components reading ``isUserGloballyMuted`` re-render on
   * toggles without polling. The localStorage round-trip happens
   * inside ``muteUserGlobally`` so callers don't have to choose
   * between session and persistent state.
   *
   * Per Q4 (Phil's localStorage-only pattern for personal-preference
   * state, matching the per-channel mute precedent from v0.4.0): the
   * global-user-mute state intentionally does NOT go over MQTT or MCP.
   *
   * Plain ``$state`` object (NOT ``$state.raw``) so per-key writes
   * trigger reactivity on consumers reading ``userMutes[key]``.
   *
   * @type {Record<string, boolean>}
   */
  userMutes = $state({});

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
  /**
   * v0.4.2 Step 3.8 (UX G-18): per-channel set of message ids the local
   * user has actually viewed (dwell-confirmed via IntersectionObserver in
   * ChatView). Distinct from ``#seenMessageIds`` which feeds the
   * ReadReceipt counter without any unread-clearing semantics.
   *
   * Shape: ``{ [channelId: string]: Set<string> }``. Idempotent: adding
   * a message id twice is a no-op. Drives the new "all unread messages
   * have been viewed → zero the channel's unread count" behavior that
   * replaces the previous "switching channels auto-clears unread"
   * shortcut (which violated UX G-18: unread should mean "stuff you
   * haven't actually viewed", matching Slack/Discord/Teams semantics).
   *
   * Not persisted across reloads — viewing is a session-local concept.
   * On reload, unread comes from ``comms_check`` (server-authoritative).
   */
  #viewedMessageIdsByChannel = {};
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
   * v0.4.2 Step 3.6 (expanded): pending admin-action queue used by
   * ``renameChannel`` / ``setVisibility`` / ``setMode`` /
   * ``transferOwnership`` when the broker is unreachable. Each entry is
   * a closure that re-issues the MCP call on reconnect; the optimistic
   * local update has ALREADY been applied at enqueue time, so a drain
   * only needs to fire the wire call (and roll the local update back on
   * rejection). Parallels ``#pendingSends`` (which queues MQTT broker
   * publishes) but exists as a separate slot because the shape is
   * different: admin actions are MCP/HTTP RPC, not topic+payload
   * publishes.
   *
   * Cap = 50 entries; drop-oldest semantics mirror ``#pendingSends`` so
   * a long offline session prefers the user's most-recent admin intent.
   * Drained on the ``'connect'`` event alongside ``#drainPendingSends``.
   *
   * @type {Array<{ kind: string, channelId: string, run: () => Promise<{success: boolean, error?: string}>, rollback: () => void }>}
   */
  #pendingAdminActions = [];
  /** Hard cap on ``#pendingAdminActions`` queue length. */
  static #PENDING_ADMIN_ACTIONS_CAP = 50;

  /**
   * v0.4.2 Step 3.6: monotonic-ms timestamp of the most recent
   * ``checkChannels()`` call. ``#maybeCheckChannels()`` consults this to
   * enforce the 30s throttle on the ``visibilitychange`` re-fire path
   * (UX G-11: avoid hammering the daemon when the user thrashes browser
   * focus). The initial ``connect`` call ignores the throttle by
   * resetting this slot to 0 so the very first fetch always runs.
   * @type {number}
   */
  #lastCommsCheckAt = 0;
  /** Throttle window for ``visibilitychange``-triggered ``comms_check`` (ms). */
  static #COMMS_CHECK_THROTTLE_MS = 30_000;

  /**
   * v0.4.2 Step 3.6: bound reference to the ``visibilitychange`` event
   * listener installed on ``document`` so ``disconnect()`` (and the
   * tests' teardown seam) can detach it without leaking a global handler
   * across page navigations in dev. ``null`` while no listener is
   * attached.
   * @type {((this: Document, ev: Event) => void) | null}
   */
  #visibilityHandler = null;

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
      this.channelsById = {};
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
      this.channelsById = {};
      this.serverUnreachable = false;
      this.#resetActiveChannelIfStale();
      return;
    }

    // v0.4.0 Step 2.6: build a fresh map keyed by id. Preserves the order
    // of the payload so `Object.values` (the back-compat `channels` array
    // surface) maintains insertion order, matching pre-Step-2.6 behavior.
    const nextMap = {};
    for (const row of list) {
      const ch = this.#channelRowFromPayload(row);
      // Use the row's own id; collisions overwrite (later wins, matches
      // the historical ``find``-based replacement pattern).
      nextMap[ch.id] = ch;
    }
    this.channelsById = nextMap;
    this.serverUnreachable = false;
    // Overlay local-only state (starred / muted level) so the user's
    // page-refresh-persistent decorations survive bootstrap. Daemon-side
    // ``myStarred`` / ``myMuted`` remain authoritative when present; this
    // overlay only fills in when the daemon hasn't surfaced them yet
    // (Q4 lock — mute is local-only in v0.4.0; star personalization lands
    // server-side in v0.4.1).
    this.#restoreLocalChannelState();
    this.#resetActiveChannelIfStale();
  }

  /**
   * Overlay localStorage-persisted ``starred`` and ``muted`` decorations
   * onto the freshly bootstrapped channels map. Idempotent — safe to call
   * multiple times. Uses the same per-id keys ``setStar`` / ``setMute``
   * write to (``claude-comms.star.{id}`` / ``claude-comms.mute.{id}``)
   * so the round-trip is symmetric.
   *
   * Bootstrap-time payload values (``myStarred`` / ``myMuted`` per the
   * Step 2.1 contract) take precedence ONLY when they're explicitly
   * ``true`` — a daemon emitting ``false`` does not clobber a stored
   * local star. This is intentional: until per-user state lands
   * server-side (v0.4.1), localStorage is the user's actual source of
   * truth for these decorations.
   */
  #restoreLocalChannelState() {
    for (const ch of Object.values(this.channelsById)) {
      // Star: localStorage value of ``'true'`` flips the in-memory flag.
      // Anything else (missing, ``'false'``, malformed) leaves the
      // payload-derived value in place.
      const starRaw = safeStorage.getItem(STAR_STORAGE_PREFIX + ch.id);
      if (starRaw === 'true') {
        ch.starred = true;
      } else if (starRaw === 'false' && !ch.starred) {
        // Explicit false survives only if the daemon didn't assert true.
        ch.starred = false;
      }
      // Mute: levels are strings; map ``'off'`` → bool false, anything
      // else (``'mentions'`` / ``'all'``) → bool true.
      const muteRaw = safeStorage.getItem(MUTE_STORAGE_PREFIX + ch.id);
      if (muteRaw && MUTE_LEVELS.includes(muteRaw)) {
        ch.muteLevel = muteRaw;
        ch.muted = muteRaw !== 'off';
      }
    }
  }

  /**
   * After bootstrap, if ``activeChannel`` no longer corresponds to a real
   * row in the map, fall back to the first member channel (alpha-sorted
   * by name). Returns ``null`` when there are no member channels at all
   * — the chat pane consumer renders an empty-state in that case.
   *
   * Fixes the Step 2.5 surfaced follow-up: ``activeChannel = $state('general')``
   * default survives even when ``/api/conversations`` returns no row
   * called ``general``; without this reset the chat pane stayed blank
   * forever.
   */
  #resetActiveChannelIfStale() {
    if (this.activeChannel && this.channelsById[this.activeChannel]) return;
    const members = Object.values(this.channelsById)
      .filter((c) => c.member)
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || ''));
    this.activeChannel = members.length > 0 ? members[0].id : null;
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
    const muted = r.myMuted === true;
    return {
      id: typeof r.id === 'string' ? r.id : '',
      name: typeof r.name === 'string' ? r.name : (typeof r.id === 'string' ? r.id : ''),
      topic: typeof r.topic === 'string' ? r.topic : '',
      member: r.member === true,
      memberCount: typeof r.memberCount === 'number' ? r.memberCount : 0,
      lastActivity: r.lastActivity ?? null,
      mode: typeof r.mode === 'string' ? r.mode : 'public',
      // v0.4.2 Wave C frontend reconciliation [VERIFY-3.6b-2]: default to
      // the pinned ``'public'`` value (Step 3.6b backend contract), not the
      // legacy ``'listed'`` string. The old default was kept while the wire
      // shape was in flux; 3.6b's tightening makes ``'public'``/``'private'``
      // the only accepted values.
      visibility: typeof r.visibility === 'string' ? r.visibility : 'public',
      createdAt: r.createdAt ?? null,
      createdBy: r.createdBy ?? null,
      // my-prefix → unprefixed rename (architecture spec §III.4 preamble)
      unread: typeof r.myUnread === 'number' ? r.myUnread : 0,
      // Per-thread mention dot. Daemon emits this in v0.4.1; default
      // false until then so the ChannelRow shape carries no undefined.
      unreadHasMention: r.unreadHasMention === true,
      // Legacy v0.3.x per-channel "first unread message id" cursor.
      // Persisted in localStorage by ``#saveUnreadMarkers``; restored by
      // ``#restoreUnreadMarkers``. Keep null by default.
      unreadFrom: r.unreadFrom ?? null,
      starred: r.myStarred === true,
      muted,
      // Mute LEVEL: ``"off" | "mentions" | "all"``. Default tracks ``muted``
      // (true → ``"all"``, false → ``"off"``). Real level overrides this
      // when the user picks one via ``setMute``; ``#restoreLocalChannelState``
      // pulls it out of localStorage on bootstrap.
      muteLevel: muted ? 'all' : 'off',
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
   * Test-only seam: dispatch a synthetic ``claude-comms/system/conversations``
   * event through ``#handleSystemConversation`` without standing up an
   * MQTT broker. Mirrors what ``_bootstrapChannelsForTest`` does for the
   * REST bootstrap path. Used by ``tests/mqtt-store-channels.spec.js``
   * and ``tests/mqtt-store-system-events.spec.js`` to exercise the full
   * Step 2.7 event taxonomy: ``created`` / ``conversation_created`` /
   * ``topic_changed`` / ``conversation_topic_changed`` / ``renamed`` /
   * ``deleted`` / ``conversation_deleted`` / ``archived`` /
   * ``unarchived`` / ``member_joined`` / ``member_left``.
   *
   * @param {object} msg - System-event payload.
   */
  _handleSystemEventForTest(msg) {
    this.#handleSystemConversation(msg);
  }

  /**
   * Test-only seam: dispatch a synthetic chat-message into
   * ``#handleChatMessage`` without standing up an MQTT broker. Mirrors
   * what the production MQTT dispatch path does when a
   * ``claude-comms/conv/{id}/messages`` frame arrives. Used by
   * ``tests/mention-dot.spec.js`` (v0.4.2 Step 3.10) to pin the
   * Design Spec §8.2 invariant: live mention messages raise
   * ``unreadHasMention`` so the sidebar mention dot fires even on
   * muted channels.
   *
   * @param {string} channel - Target conversation id.
   * @param {object} msg - Wire message payload.
   */
  _handleChatMessageForTest(channel, msg) {
    this.#handleChatMessage(channel, msg);
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

  activeChannelMeta = $derived(this.channelsById[this.activeChannel]);

  /**
   * v0.4.0 Step 2.6 — three-section sidebar projections (Design Spec §13).
   *
   * Each section is alpha-sorted by ``name`` (SORT-LOCK; Phil's hard
   * constraint per architecture spec §III.4 preamble). Falls back to ``id``
   * when ``name`` is missing so legacy meta-only rows still sort
   * deterministically. The sort comparator is locale-aware
   * (``localeCompare``) so accent-bearing names alphabetize the way users
   * expect them to.
   *
   * Sections (per architecture spec §III.4 step 2.6):
   *   - ``starredChannels``   : ``member && starred``
   *   - ``activeChannels``    : ``member && !starred && !archived``
   *   - ``availableChannels`` : ``!member && visibility === 'public' &&
   *                              !archived`` (v0.4.2 Step 3.6b pinned
   *                              ``'public'`` over the legacy ``'listed'``)
   *   - ``archivedChannels``  : ``archived === true`` (drives the
   *                             directory modal's Archived sub-tab in
   *                             Step 2.13)
   *
   * Step 2.12's sidebar rewrite consumes these directly. The legacy
   * insertion-ordered ``channels`` array view above stays for back-compat
   * (``Sidebar.svelte`` / ``ForwardPicker.svelte`` /
   * ``ConversationBrowser.svelte`` / ``App.svelte`` haven't been migrated
   * yet).
   */
  starredChannels = $derived(
    Object.values(this.channelsById)
      .filter((c) => c.member && c.starred)
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '')),
  );

  activeChannels = $derived(
    Object.values(this.channelsById)
      .filter((c) => c.member && !c.starred && !c.archived)
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '')),
  );

  availableChannels = $derived(
    Object.values(this.channelsById)
      // v0.4.2 Step 3.6b backend pinned ``'public'`` / ``'private'`` as
      // the canonical wire values; ``'listed'`` is the legacy synonym
      // accepted here for back-compat (older daemons + fixtures may
      // still emit the v0.3 string). Newly-created rows + outgoing
      // ``setVisibility`` calls only ever use the canonical pair.
      .filter((c) => !c.member && (c.visibility === 'public' || c.visibility === 'listed') && !c.archived)
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '')),
  );

  archivedChannels = $derived(
    Object.values(this.channelsById)
      .filter((c) => c.archived === true)
      .sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '')),
  );

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
    return this.channelsById[id];
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

      // v0.4.2 Step 3.6 (expanded): flush any admin actions queued
      // while we were offline (renameChannel / setVisibility / setMode
      // / transferOwnership). Each entry's ``run`` closure re-issues
      // the MCP call; failed runs fire their ``rollback`` to undo the
      // optimistic local update. Fire-and-forget so the rest of the
      // connect handshake doesn't block on the daemon round-trip.
      this.#drainPendingAdminActions().catch(() => {
        /* best-effort; rollbacks fire per-entry on failure */
      });

      // v0.4.2 Step 3.6, UX G-10/G-11: hydrate unread counts from
      // the server. Reset the throttle slot so the very first call
      // always fires (the throttle gate only protects the
      // ``visibilitychange`` re-fire path). Fire-and-forget; the
      // helper swallows its own errors.
      this.#lastCommsCheckAt = 0;
      this.checkChannels().catch(() => {
        /* best-effort */
      });
      // Install the visibilitychange listener so subsequent tab-
      // visibility regains re-fire ``comms_check`` (subject to the
      // 30s throttle).
      this.#attachVisibilityListener();

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
    // v0.4.2 Step 3.6: detach the visibilitychange listener so we
    // don't leak a global handler across page navigations in dev.
    this.#detachVisibilityListener();

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
   * Switch the active channel.
   *
   * v0.4.2 Step 3.8 (UX G-18): switching no longer auto-clears unread.
   * Previously the act of clicking into a channel zeroed its ``unread``
   * counter even if the user immediately switched back out without
   * actually reading anything. The new semantics — matching Slack /
   * Discord / Teams — require viewport-confirmed reads: each message
   * bubble in ChatView is observed via IntersectionObserver, and
   * ``markMessageViewed(channelId, messageId)`` is called after a
   * dwell window. Unread zeroes out only when every previously-unread
   * message has been viewed (or the user explicitly clicks "Mark all
   * as read" via Step 3.7's path through ``markAllRead``).
   *
   * No-op if already viewing the target channel.
   * @param {string} channelId - The channel to switch to.
   */
  switchChannel(channelId) {
    if (channelId === this.activeChannel) return;

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
    if (this.channelsById[id]) return;

    // v0.4.0 Step 2.6 — populate the full ChannelRow shape on local
    // create. ``member`` defaults true because the creator implicitly
    // joins. ``visibility`` defaults ``'public'`` so the new channel
    // surfaces in the directory's Browse tab for other users (v0.4.2
    // Step 3.6b pinned ``'public'`` over the legacy ``'listed'``).
    this.channelsById[id] = this.#channelRowFromPayload({
      id,
      name: id,
      topic,
      member: true,
      memberCount: 1,
      lastActivity: new Date().toISOString(),
      mode: 'public',
      visibility: 'public',
      createdAt: new Date().toISOString(),
      createdBy: this.userProfile.key,
      myUnread: 0,
      myStarred: false,
      myMuted: false,
    });

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
   * v0.4.0 Step 2.6 — back-compat shim that delegates to ``setStar``, which
   * also handles the localStorage round-trip (Q4-adjacent local lock).
   * @param {string} channelId - The channel to star/unstar.
   */
  toggleStar(channelId) {
    const ch = this.channelsById[channelId];
    if (!ch) return;
    this.setStar(channelId, !ch.starred);
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
    const targetId = message.channel || message.conv || this.activeChannel;
    const ch = this.channelsById[targetId];
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
   * v0.4.2 Step 3.8 (UX G-18) — viewport-confirmed read tracker.
   *
   * Called by ChatView's IntersectionObserver after a message bubble has
   * been visible in the viewport for the spec-pinned dwell window
   * (≥ 1 second). Records the (channelId, messageId) pair in the per-
   * channel viewed-id set. Idempotent: re-observing an already-viewed
   * message is a no-op.
   *
   * Unread-clearing semantics:
   *   - Each call recomputes whether the channel's currently-loaded
   *     messages from other users are all in the viewed set.
   *   - If they are, the channel's ``unread`` count zeroes and
   *     ``unreadHasMention`` clears, AND ``lastReadAt`` advances to
   *     the current ISO timestamp (mirroring ``markAllRead``).
   *   - The legacy ``unreadFrom`` cursor clears alongside so v0.4.2
   *     Step 3.7's UnreadDivider rebaselines to the new read line.
   *   - Self-authored messages are skipped (they're never unread to
   *     begin with).
   *
   * Distinct from ``markSeen`` (which only bumps a local read_by
   * counter for ReadReceipt UI). Both can fire from the same observer
   * callback without stepping on each other; ``markSeen`` was deliberately
   * left at its 1-arg signature so existing test fakes that mock it as
   * ``vi.fn()`` keep passing untouched.
   *
   * No-op when:
   *   - ``channelId`` is missing or unknown
   *   - ``messageId`` is missing
   *   - the (channel, message) pair has already been recorded as viewed
   *
   * @param {string} channelId - Channel id the message belongs to.
   * @param {string} messageId - Message id observed in the viewport.
   */
  markMessageViewed(channelId, messageId) {
    if (typeof channelId !== 'string' || !channelId) return;
    if (typeof messageId !== 'string' || !messageId) return;

    let viewed = this.#viewedMessageIdsByChannel[channelId];
    if (!viewed) {
      viewed = new Set();
      this.#viewedMessageIdsByChannel[channelId] = viewed;
    }
    if (viewed.has(messageId)) return;
    viewed.add(messageId);

    const ch = this.channelsById[channelId];
    if (!ch) return;

    // Recompute unread: a channel is fully read iff every other-user
    // message currently loaded for that channel is in the viewed set.
    // Self-authored messages are excluded because they're never unread.
    const selfKey = this.userProfile?.key;
    let unreadRemaining = 0;
    for (const m of this.messages) {
      const mChannel = m.channel || m.conv;
      if (mChannel !== channelId) continue;
      if (m.sender?.key === selfKey) continue;
      if (m.sender?.type === 'system') continue;
      if (!viewed.has(m.id)) unreadRemaining++;
    }

    // Bound the optimistic clear by the server-authoritative unread
    // count: never make ``ch.unread`` larger than it already was, and
    // never set it negative.
    if (unreadRemaining === 0) {
      ch.unread = 0;
      ch.unreadHasMention = false;
      ch.unreadFrom = null;
      ch.lastReadAt = new Date().toISOString();
      this.#saveUnreadMarkers();
    }
  }

  /**
   * Test-only seam: introspect the per-channel viewed-id set. Lets
   * specs assert that viewport observations were recorded idempotently
   * without exposing the private field.
   * @param {string} channelId
   * @returns {string[]}
   */
  _viewedMessageIdsForTest(channelId) {
    const s = this.#viewedMessageIdsByChannel[channelId];
    return s ? Array.from(s) : [];
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
   * v0.4.0 Step 2.6 — back-compat shim that delegates to ``setMute`` so
   * the localStorage round-trip stays consistent. Flips between
   * ``"off"`` and ``"all"`` levels; the new directory-modal context menu
   * exposes the finer ``"mentions"`` level directly via ``setMute``.
   * @param {string} channelId - The channel to mute/unmute.
   */
  muteChannel(channelId) {
    const ch = this.channelsById[channelId];
    if (!ch) return;
    const nextLevel = ch.muted ? 'off' : 'all';
    this.setMute(channelId, nextLevel);
  }

  /**
   * Forward a message to a different channel.
   * Creates a new message with the same body and a `forwarded_from` reference.
   *
   * Polish wave P6 (v0.4.2 Wave 0): extends the v0.3.3 G-62 pending-
   * sends queue to cover the forward path. Previously, a forward
   * issued while disconnected would local-echo into the target
   * channel but silently never publish, leaving the bubble in an
   * indeterminate state. Now the bubble carries a ``status`` field
   * (``'sending' | 'sent' | 'failed'`` matching ``sendMessage``) and
   * disconnected forwards land on ``#pendingSends`` for drain on
   * reconnect. The drain is topic-agnostic, so no change to
   * ``#drainPendingSends`` is required — every queue entry already
   * carries its own ``(messageId, topic, payload)`` snapshot.
   *
   * @param {object} message - The original message object to forward.
   * @param {string} targetChannelId - The channel to forward the message to.
   */
  forwardMessage(message, targetChannelId) {
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
      forwarded_from: message.id,
      // Per-message delivery status (UX G-62, extended for forward path
      // in Polish P6). Mirrors ``sendMessage`` so MessageBubble can
      // render the same sending/sent/failed affordances on forwarded
      // local-echoes that it does on direct sends.
      status: 'sending',
    };

    const topic = TOPIC_PREFIX + '/conv/' + targetChannelId + '/messages';
    const payload = JSON.stringify(msg);

    // Local echo: add the forwarded message immediately so it appears
    // in the target channel without waiting for the broker round-trip.
    this.#handleChatMessage(targetChannelId, msg);

    if (this.#client && this.connected) {
      this.#publishOutgoing(msg.id, topic, payload);
    } else {
      // Disconnected — queue instead of silently dropping. The bubble
      // stays in 'sending' until the queue drains on reconnect.
      this.#queuePendingSend(msg.id, topic, payload);
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

  // ── v0.4.0 Step 2.6 — channel lifecycle methods ──
  //
  // Eight methods per architecture spec §III.4 step 2.6. Each is async
  // (except the local-only ``setStar`` / ``setMute``), wraps the
  // corresponding REST/MCP call, optimistically updates ``channelsById``,
  // and reverts on error. ``archiveChannel`` and ``leaveChannel`` each
  // return ``{ done, cancel }`` so the sidebar context-menu invoker
  // (Step 2.12) can wire a 15-second undo toast.

  /**
   * Join a conversation. Calls ``comms_join`` over the MCP transport;
   * on success, optimistically flips ``member = true`` and bumps
   * ``memberCount``, then hydrates the last-N message history via the
   * existing ``#fetchHistory`` helper so the chat pane is populated
   * before the user even switches. On failure, reverts the optimistic
   * state.
   *
   * Idempotent at the row level — a second call against the same id is a
   * no-op if ``member`` is already true. (The MCP tool itself is also
   * idempotent server-side; this guard just avoids the wasted round-trip.)
   *
   * @param {string} id - Channel id to join.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async joinChannel(id) {
    if (typeof id !== 'string' || !id) {
      return { success: false, error: 'Missing channel id.' };
    }
    const ch = this.channelsById[id];
    if (!ch) return { success: false, error: 'Unknown channel.' };
    if (ch.member) return { success: true };

    // Optimistic: flip member + bump count BEFORE the call so the
    // sidebar updates immediately.
    const prevMember = ch.member;
    const prevCount = ch.memberCount;
    ch.member = true;
    ch.memberCount = prevCount + 1;

    const result = await mcpCall('comms_join', {
      key: this.userProfile.key,
      conversation: id,
      name: this.userProfile.name,
    });
    if (!result.success) {
      // Roll back optimistic update.
      ch.member = prevMember;
      ch.memberCount = prevCount;
      return { success: false, error: result.error };
    }

    // Hydrate last-N history so the chat pane has content the moment the
    // user switches to this channel.
    this.#fetchHistory(id);
    return { success: true };
  }

  /**
   * Leave a conversation. Returns ``{ done, cancel }`` so the caller can
   * wire a 15-second Undo toast (Design Spec §10): if ``cancel()`` fires
   * within the window the MCP call never goes out + local state stays
   * unchanged. After the window the MCP call commits and ``cancel()``
   * becomes a no-op.
   *
   * Side effects on the commit path:
   *   - Optimistic ``member = false`` happens BEFORE the call so the
   *     sidebar updates instantly.
   *   - On MCP error, ``member`` flips back.
   *   - On success, the local message buffer for that channel is cleared
   *     (architecture spec §III.4 step 2.6: "clears local message buffer
   *     for that channel").
   *   - Auto-unstars per SORT-LOCK / Design Spec §2.6.
   *
   * @param {string} id - Channel id to leave.
   * @returns {{ done: Promise<{success: boolean, error?: string, cancelled?: boolean}>, cancel: () => void }}
   */
  leaveChannel(id) {
    const ch = this.channelsById[id];
    if (!ch) {
      // No channel to leave — return a settled-rejected envelope that
      // matches the {done, cancel} shape so callers don't have to special-
      // case the missing-id path.
      return {
        done: Promise.resolve({ success: false, error: 'Unknown channel.', cancelled: false }),
        cancel: () => ({ tooLate: true }),
      };
    }

    // Snapshot pre-change state for rollback on cancel OR MCP error.
    const prevMember = ch.member;
    const prevStarred = ch.starred;
    const prevActiveChannel = this.activeChannel;

    return this.#scheduleUndoable(
      // optimistic: apply immediately so the row disappears from Active.
      () => {
        ch.member = false;
        // Auto-unstar (Design Spec §2.6: star is a member-only decoration).
        if (ch.starred) {
          this.setStar(id, false);
        }
      },
      // rollback (on cancel): restore the pre-change snapshot.
      () => {
        ch.member = prevMember;
        if (prevStarred && !ch.starred) {
          this.setStar(id, true);
        }
      },
      // commitMcp (after 15s): fire the actual MCP call + finish local
      // side effects, or roll back on MCP error.
      async () => {
        const result = await mcpCall('comms_leave', {
          key: this.userProfile.key,
          conversation: id,
        });
        if (!result.success) {
          ch.member = prevMember;
          if (prevStarred && !ch.starred) {
            this.setStar(id, true);
          }
          return { success: false, error: result.error };
        }
        // Clear local message buffer for this channel.
        this.messages = this.messages.filter((m) => m.channel !== id);
        // If we were viewing this channel, pick a new active.
        if (prevActiveChannel === id) {
          this.activeChannel = null;
          this.#resetActiveChannelIfStale();
        }
        return { success: true };
      },
    );
  }

  /**
   * Archive a conversation (Q1 lock — "Close = archive + kick"). Returns
   * ``{ done, cancel }`` for the 15-second Undo toast.
   *
   * Side effects on the commit path:
   *   - Optimistic ``archived = true`` + ``member = false`` BEFORE the
   *     call (the daemon will eject all members on commit anyway).
   *   - On MCP error, both flags flip back.
   *   - On success, the row stays in the map (so the directory's
   *     Archived sub-tab can still surface it) but is removed from the
   *     three live sections via the ``archived`` filter on each
   *     ``$derived``.
   *   - Stamps ``archived_at`` + ``archived_by`` locally so the row
   *     surfaces the correct provenance even before the next bootstrap.
   *
   * @param {string} id - Channel id to archive.
   * @returns {{ done: Promise<{success: boolean, error?: string, cancelled?: boolean}>, cancel: () => void }}
   */
  archiveChannel(id) {
    const ch = this.channelsById[id];
    if (!ch) {
      return {
        done: Promise.resolve({ success: false, error: 'Unknown channel.', cancelled: false }),
        cancel: () => ({ tooLate: true }),
      };
    }

    const prev = {
      archived: ch.archived,
      archived_at: ch.archived_at,
      archived_by: ch.archived_by,
      member: ch.member,
      memberCount: ch.memberCount,
    };
    const prevActiveChannel = this.activeChannel;

    return this.#scheduleUndoable(
      // optimistic
      () => {
        ch.archived = true;
        ch.archived_at = new Date().toISOString();
        ch.archived_by = this.userProfile.key;
        ch.member = false;
      },
      // rollback
      () => {
        ch.archived = prev.archived;
        ch.archived_at = prev.archived_at;
        ch.archived_by = prev.archived_by;
        ch.member = prev.member;
        ch.memberCount = prev.memberCount;
      },
      // commitMcp
      async () => {
        const result = await mcpCall('comms_conversation_archive', {
          key: this.userProfile.key,
          conversation: id,
          confirm: true,
        });
        if (!result.success) {
          ch.archived = prev.archived;
          ch.archived_at = prev.archived_at;
          ch.archived_by = prev.archived_by;
          ch.member = prev.member;
          ch.memberCount = prev.memberCount;
          return { success: false, error: result.error };
        }
        if (prevActiveChannel === id) {
          this.activeChannel = null;
          this.#resetActiveChannelIfStale();
        }
        return { success: true };
      },
    );
  }

  /**
   * Delete a conversation. Destructive — no undo (per architecture spec
   * §III.4 step 2.6: "destructive; no undo"). Wraps
   * ``comms_conversation_delete`` with ``confirm=True``; the caller is
   * expected to have already gated this behind the type-name
   * confirmation modal (Design Spec §4.5).
   *
   * Local side effects: row removed from the map outright; clears the
   * local message buffer for that channel; if it was the active channel,
   * the active is reset to the first member channel.
   *
   * @param {string} id - Channel id to delete.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async deleteChannel(id) {
    if (typeof id !== 'string' || !id) {
      return { success: false, error: 'Missing channel id.' };
    }
    const ch = this.channelsById[id];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    // Snapshot for rollback in case the MCP call fails.
    const snapshot = { ...ch };
    delete this.channelsById[id];

    const result = await mcpCall('comms_conversation_delete', {
      key: this.userProfile.key,
      conversation: id,
      confirm: true,
    });
    if (!result.success) {
      // Re-insert at the same spot. Object.keys preserves the original
      // insertion order; reinserting puts it at the end, which is
      // acceptable for a rare error path (alpha sort on the section
      // projections normalises the visible order anyway).
      this.channelsById[id] = snapshot;
      return { success: false, error: result.error };
    }

    this.messages = this.messages.filter((m) => m.channel !== id);
    if (this.activeChannel === id) {
      this.activeChannel = null;
      this.#resetActiveChannelIfStale();
    }
    return { success: true };
  }

  /**
   * "Close" is Phil's vocabulary in the context menu. Per the Q1 lock
   * (Archive + kick), it delegates to ``archiveChannel``. If the project
   * ever flips Q1 to Delete, swap the body — the sidebar consumer's
   * contract stays the same.
   *
   * Returns the same ``{ done, cancel }`` envelope ``archiveChannel``
   * does so the 15-second Undo toast wiring is transparent.
   *
   * @param {string} id - Channel id to close.
   * @returns {{ done: Promise<{success: boolean, error?: string, cancelled?: boolean}>, cancel: () => void }}
   */
  closeChannel(id) {
    return this.archiveChannel(id);
  }

  /**
   * Update a channel's topic. Optimistic local update happens BEFORE the
   * MCP call so the header line refreshes instantly; on error the prior
   * topic is restored.
   *
   * @param {string} id - Channel id whose topic to update.
   * @param {string} newTopic - The new topic string (server enforces its
   *   own length cap — we don't pre-truncate here).
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async setTopic(id, newTopic) {
    if (typeof id !== 'string' || !id) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (typeof newTopic !== 'string') {
      return { success: false, error: 'Missing topic.' };
    }
    const ch = this.channelsById[id];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    const prevTopic = ch.topic;
    ch.topic = newTopic;

    const result = await mcpCall('comms_conversation_update', {
      key: this.userProfile.key,
      conversation: id,
      topic: newTopic,
    });
    if (!result.success) {
      ch.topic = prevTopic;
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  // ── v0.4.2 Step 3.6 (expanded): admin-action accessors ──
  //
  // Per Q6 lock-in (architecture spec §III.4 + 3.0a role lattice),
  // ChannelAdminPanel issues four admin actions: rename, toggle
  // visibility, toggle mode, transfer ownership. Each is wired through
  // a typeof-guard on main today (`da2fb9a`) so the panel ships
  // visually-functional but persistence-no-op; Wave B Step 3.6 lands
  // the store side so the typeof guards engage.
  //
  // [VERIFY surfaced 2026-05-18 by Wave B implementer]: the backend
  // ``comms_conversation_update`` MCP tool currently accepts ONLY
  // ``topic`` (verified at mcp_tools.py:2210-2273). The four new
  // accessors below issue the wire call with the spec-pinned field
  // names anyway (``name`` / ``visibility`` / ``mode`` / ``created_by``)
  // so the wiring is correct when a future step extends the backend
  // accept-list. Until then the backend will reject the unknown fields
  // and the optimistic local update rolls back (matching ``setTopic``'s
  // rollback shape). The local optimistic update STILL makes the panel
  // visually functional today; the round-trip just doesn't persist
  // until the backend lands the extra fields. A follow-up Wave B.5 /
  // Wave C step should expand ``tool_comms_conversation_update`` to
  // accept these four fields (and add the corresponding system-message
  // shapes for each).

  /**
   * Rename a channel. Optimistic local update of ``channel.name``
   * happens BEFORE the MCP call so the sidebar + header refresh
   * instantly; on error the previous name is restored. Disconnected
   * calls queue on ``#pendingAdminActions`` for drain on the next
   * ``'connect'`` event.
   *
   * Wire shape (v0.4.2 Step 3.6b pinned [VERIFY-3.6b-3]):
   * ``comms_conversation_update`` with payload
   * ``{ key, conversation, display_name }``. The slug (``conversation``)
   * is immutable; only the human-readable display name is mutable. The
   * legacy ``name`` field was rejected by 3.6b's tightened
   * ``tool_comms_conversation_update`` validator, so Wave C swapped to
   * ``display_name``. External method signature is unchanged so consumers
   * (ChannelAdminPanel.commitRename, sidebar context menus) carry no
   * patch. Frontend display reads ``displayName ?? name`` with
   * display_name precedence + slug fallback.
   *
   * @param {string} channelId - Channel id to rename.
   * @param {string} newDisplayName - The desired human-readable display name.
   * @returns {Promise<{ success: boolean, error?: string, queued?: boolean }>}
   */
  async renameChannel(channelId, newDisplayName) {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (typeof newDisplayName !== 'string' || !newDisplayName.trim()) {
      return { success: false, error: 'Missing channel name.' };
    }
    const ch = this.channelsById[channelId];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    const prevName = ch.name;
    ch.name = newDisplayName;

    // Disconnected: queue the wire call + the rollback closure so the
    // local update stays visible while we wait for reconnect.
    if (!this.connected) {
      this.#queueAdminAction({
        kind: 'rename',
        channelId,
        run: () =>
          mcpCall('comms_conversation_update', {
            key: this.userProfile.key,
            conversation: channelId,
            display_name: newDisplayName,
          }),
        rollback: () => {
          const live = this.channelsById[channelId];
          if (live) live.name = prevName;
        },
      });
      return { success: true, queued: true };
    }

    const result = await mcpCall('comms_conversation_update', {
      key: this.userProfile.key,
      conversation: channelId,
      display_name: newDisplayName,
    });
    if (!result.success) {
      ch.name = prevName;
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  /**
   * Set a channel's visibility (Listed / Unlisted per Design Spec
   * §13.4; the panel today passes the lowercase ``'public'`` /
   * ``'private'`` legacy strings; see [VERIFY] in the worklog about
   * value-casing reconciliation). Optimistic local update + rollback
   * on error; queues on disconnect.
   *
   * @param {string} channelId
   * @param {string} level - Visibility level (panel-driven; passed
   *   through to the backend verbatim so future expansions of the
   *   accepted set don't need a client patch).
   * @returns {Promise<{ success: boolean, error?: string, queued?: boolean }>}
   */
  async setVisibility(channelId, level) {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (typeof level !== 'string' || !level) {
      return { success: false, error: 'Missing visibility level.' };
    }
    const ch = this.channelsById[channelId];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    const prevVisibility = ch.visibility;
    ch.visibility = level;

    if (!this.connected) {
      this.#queueAdminAction({
        kind: 'setVisibility',
        channelId,
        run: () =>
          mcpCall('comms_conversation_update', {
            key: this.userProfile.key,
            conversation: channelId,
            visibility: level,
          }),
        rollback: () => {
          const live = this.channelsById[channelId];
          if (live) live.visibility = prevVisibility;
        },
      });
      return { success: true, queued: true };
    }

    const result = await mcpCall('comms_conversation_update', {
      key: this.userProfile.key,
      conversation: channelId,
      visibility: level,
    });
    if (!result.success) {
      ch.visibility = prevVisibility;
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  /**
   * Set a channel's mode (open vs invite per Design Spec §13.4; the
   * panel today passes ``'open'`` / ``'invite'``). Optimistic local
   * update + rollback on error; queues on disconnect. Wire shape
   * mirrors ``setVisibility``; see the admin-action [VERIFY] block.
   *
   * @param {string} channelId
   * @param {string} mode - Mode value (panel-driven; passed through
   *   verbatim to the backend).
   * @returns {Promise<{ success: boolean, error?: string, queued?: boolean }>}
   */
  async setMode(channelId, mode) {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (typeof mode !== 'string' || !mode) {
      return { success: false, error: 'Missing mode.' };
    }
    const ch = this.channelsById[channelId];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    const prevMode = ch.mode;
    ch.mode = mode;

    if (!this.connected) {
      this.#queueAdminAction({
        kind: 'setMode',
        channelId,
        run: () =>
          mcpCall('comms_conversation_update', {
            key: this.userProfile.key,
            conversation: channelId,
            mode,
          }),
        rollback: () => {
          const live = this.channelsById[channelId];
          if (live) live.mode = prevMode;
        },
      });
      return { success: true, queued: true };
    }

    const result = await mcpCall('comms_conversation_update', {
      key: this.userProfile.key,
      conversation: channelId,
      mode,
    });
    if (!result.success) {
      ch.mode = prevMode;
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  /**
   * Transfer ownership of a channel to a different participant.
   *
   * The spec-pinned signature is ``(channelId, newOwnerKey)``;
   * ChannelAdminPanel on main (``da2fb9a``) currently invokes the
   * 1-arg form ``store.transferOwnership(channel.id)`` because the
   * new-owner picker hasn't shipped (verified at
   * ChannelAdminPanel.svelte:200). When ``newOwnerKey`` is missing we
   * return a structured error so the panel's typeof-guard call
   * resolves cleanly without firing a wire call that would always
   * fail; once the picker lands and supplies the key, the same
   * accessor handles the 2-arg path.
   *
   * Optimistic local update of ``channel.createdBy`` happens BEFORE
   * the MCP call; on error the previous creator is restored. Also
   * patches ``channelRoles[channelId]`` so the panel's role gating
   * reflects the demotion (owner → member from this side) immediately.
   *
   * @param {string} channelId
   * @param {string} [newOwnerKey] - New owner's participant key. When
   *   omitted, returns a ``{ success: false, error: 'New-owner key
   *   required.' }`` envelope without touching local state.
   * @returns {Promise<{ success: boolean, error?: string, queued?: boolean }>}
   */
  async transferOwnership(channelId, newOwnerKey) {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (typeof newOwnerKey !== 'string' || !newOwnerKey) {
      // Panel's 1-arg call path: surface the picker gap without
      // firing a doomed wire call. The brief explicitly defers the
      // new-owner picker to a follow-up step.
      return { success: false, error: 'New-owner key required.' };
    }
    const ch = this.channelsById[channelId];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    const prevCreatedBy = ch.createdBy;
    const prevRole = this.channelRoles[channelId] ?? null;
    ch.createdBy = newOwnerKey;
    // Demote from owner to member on this side so the role-gated UI
    // immediately reflects the post-transfer state. The next
    // bootstrap (or a future ``comms_get_channel_role`` MCP wrapper)
    // will reconcile the authoritative role.
    this.channelRoles[channelId] = 'member';

    if (!this.connected) {
      this.#queueAdminAction({
        kind: 'transferOwnership',
        channelId,
        run: () =>
          mcpCall('comms_conversation_update', {
            key: this.userProfile.key,
            conversation: channelId,
            created_by: newOwnerKey,
          }),
        rollback: () => {
          const live = this.channelsById[channelId];
          if (live) live.createdBy = prevCreatedBy;
          this.channelRoles[channelId] = prevRole;
        },
      });
      return { success: true, queued: true };
    }

    const result = await mcpCall('comms_conversation_update', {
      key: this.userProfile.key,
      conversation: channelId,
      created_by: newOwnerKey,
    });
    if (!result.success) {
      ch.createdBy = prevCreatedBy;
      this.channelRoles[channelId] = prevRole;
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  // ── v0.4.2 Step 3.5b (Wave E.4): member-context-menu accessors ──
  //
  // Three frontend store methods that wire the new MemberContextMenu UI
  // (kick / start DM / global mute) to Wave E.3's backend MCP tools.
  // `kickMember` + `startDM` round-trip `/mcp`; `muteUserGlobally` +
  // `isUserGloballyMuted` are localStorage-only per Q4's pattern (same
  // model as per-channel mute, which keeps an axis of personal user
  // preference off the wire).
  //
  // Disconnected-state semantics (mirror Wave B):
  //   - kickMember: direct-reject when disconnected. Kicks are
  //     authoritative server actions; queuing them while offline would
  //     accept stale role state. The UI re-fires after reconnect.
  //   - startDM:   direct-reject when disconnected. DM creation is
  //     server-deterministic via _dm_slug; the UI prompts a retry.
  //   - muteUserGlobally / isUserGloballyMuted: localStorage-only,
  //     always available, no wire round-trip.

  /**
   * Eject a participant from a channel via Wave E.3's ``comms_kick``
   * MCP tool. Owner or admin only — the backend enforces the role gate
   * via ``RegistryStore.get_channel_role`` (mcp_tools.py:2664). The UI
   * is also expected to hide the affordance for non-owner/non-admin
   * callers via ``getChannelRole``, but the server is the
   * authoritative gate; clients that bypass the visibility check still
   * hit the role check and get an error envelope back.
   *
   * Disconnected: rejects immediately with
   * ``{ success: false, error: 'Not connected.' }`` rather than queuing
   * — kicks reflect ephemeral role state and shouldn't replay across
   * a reconnect window that may have shifted ownership.
   *
   * Wire shape (Wave E.3 pinned):
   *   ``comms_kick`` with payload
   *   ``{ key, conversation, target_key }``. Response on success:
   *   ``{ status: 'kicked', target_key, conversation }``.
   *
   * @param {string} channelId - Channel id to kick from.
   * @param {string} targetKey - 8-hex-char participant key to eject.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async kickMember(channelId, targetKey) {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (typeof targetKey !== 'string' || !targetKey) {
      return { success: false, error: 'Missing target key.' };
    }
    if (!this.connected) {
      return { success: false, error: 'Not connected.' };
    }

    const result = await mcpCall('comms_kick', {
      key: this.userProfile.key,
      conversation: channelId,
      target_key: targetKey,
    });
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  /**
   * Open (or look up) a deterministic two-party DM channel via Wave
   * E.3's ``comms_dm_open`` MCP tool. Idempotent on the backend:
   * a second call for the same pair returns ``status='existed'`` and
   * the existing slug. On success, this accessor also navigates the UI
   * into the DM via ``switchChannel`` so the caller doesn't have to
   * juggle a second store call.
   *
   * Disconnected: rejects immediately with
   * ``{ success: false, error: 'Not connected.' }``. The DM slug is
   * deterministic so a retry after reconnect is equivalent; we don't
   * queue because the round-trip is what produces the slug we need to
   * switch into.
   *
   * Wire shape (Wave E.3 pinned):
   *   ``comms_dm_open`` with payload ``{ key, target_key }``.
   *   Response on success: ``{ status: 'opened'|'existed', conversation }``.
   *
   * @param {string} targetKey - 8-hex-char participant key to DM.
   * @returns {Promise<{ success: boolean, conversation?: string, status?: string, error?: string }>}
   */
  async startDM(targetKey) {
    if (typeof targetKey !== 'string' || !targetKey) {
      return { success: false, error: 'Missing target key.' };
    }
    if (!this.connected) {
      return { success: false, error: 'Not connected.' };
    }

    const result = await mcpCall('comms_dm_open', {
      key: this.userProfile.key,
      target_key: targetKey,
    });
    if (!result.success) {
      return { success: false, error: result.error };
    }
    const payload = result.payload || {};
    const conversation = payload.conversation;
    if (typeof conversation !== 'string' || !conversation) {
      return { success: false, error: 'DM open returned no conversation slug.' };
    }
    // Navigate into the DM. ``switchChannel`` is a no-op if we are
    // already viewing it (e.g. `status === 'existed'` and the user
    // re-clicked from a profile card).
    this.switchChannel(conversation);
    return { success: true, conversation, status: payload.status };
  }

  /**
   * Invite a participant into a channel via Wave A's POST ``/api/invite``
   * REST surface (v0.4.2 Step 3.3, Wave F). Bridges the daemon-side
   * ``tool_comms_invite`` flow without the browser having to speak MCP
   * JSON-RPC directly — the daemon's identity is the inviter (configured
   * via ``identity.key``), so this surface implicitly authenticates the
   * caller as whoever the daemon is configured as.
   *
   * Wire shape (Wave A 3.4 pinned, commit ``16013e2``):
   *   POST ``/api/invite`` with body
   *   ``{ conversation_id, invitee_key, note? }``. Response on success:
   *   ``{ invited: true, invitee_key, conversation_id }``. Errors:
   *     400 → malformed body / missing fields / unknown invitee
   *     403 → daemon's identity is not a member of the conversation
   *     404 → conversation does not exist
   *     409 → already a member (idempotency conflict)
   *
   * Disconnected: rejects immediately with
   * ``{ success: false, error: 'Not connected.' }``. Invites are
   * authoritative server actions tied to live registry membership;
   * queuing while offline could fire a stale or duplicate invite once
   * the caller's role state has shifted, so we direct-reject (matching
   * ``kickMember`` / ``startDM``).
   *
   * Caller's note is forwarded verbatim; the server treats it as opaque
   * text and surfaces it via the system message ``tool_comms_invite``
   * publishes. Empty / missing note is fine — defaults to empty string
   * on the server.
   *
   * @param {string} channelId - Target conversation id.
   * @param {string} inviteeKey - 8-hex-char participant key to invite.
   * @param {string} [note] - Optional note included in the invite
   *   system message. Defaults to empty string.
   * @returns {Promise<{ success: boolean, invited?: boolean, invitee_key?: string, conversation_id?: string, status?: number, error?: string }>}
   */
  async inviteParticipant(channelId, inviteeKey, note) {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (typeof inviteeKey !== 'string' || !inviteeKey) {
      return { success: false, error: 'Missing invitee key.' };
    }
    if (!this.connected) {
      return { success: false, error: 'Not connected.' };
    }

    const body = {
      conversation_id: channelId,
      invitee_key: inviteeKey,
    };
    if (typeof note === 'string' && note.length > 0) body.note = note;

    try {
      const payload = await apiPost('/api/invite', body);
      // Server returns ``{ invited: true, invitee_key, conversation_id }``
      // on the 200 path. We pass through the truthy ``invited`` flag so
      // the caller can branch on fresh-invite vs already-member without
      // duplicating server-shape knowledge.
      return {
        success: true,
        invited: payload?.invited !== false,
        invitee_key: payload?.invitee_key ?? inviteeKey,
        conversation_id: payload?.conversation_id ?? channelId,
      };
    } catch (err) {
      // ``apiPost`` throws ``Error`` with ``.status`` set on non-2xx
      // (including the 409 already-member idempotency conflict). We
      // surface the status code so the UI can render a tailored toast
      // per failure mode (403 = no permission, 404 = unknown channel,
      // 409 = already a member, 400 = bad input).
      const status = err && typeof err === 'object' && typeof err.status === 'number'
        ? err.status
        : undefined;
      const message = err && err.message ? err.message : 'Invite failed.';
      return { success: false, status, error: message };
    }
  }

  /**
   * Toggle a global per-user mute (localStorage-only, per Q4 pattern).
   * Storage key: ``cc:user-muted:{targetKey}`` value ``'1'`` when
   * muted, absent otherwise. Mirrors the per-channel mute precedent
   * from v0.4.0: personal-preference state stays client-side, never
   * touches MQTT or MCP.
   *
   * Also writes through to ``this.userMutes`` (a reactive ``$state``
   * map) so any component reading ``isUserGloballyMuted`` re-renders
   * without prop wiring. The localStorage write is the source of
   * truth across reloads; the in-memory map is the reactive view.
   *
   * @param {string} targetKey - 8-hex-char participant key.
   * @param {boolean} [muted=true] - True to mute, false to unmute.
   * @returns {void}
   */
  muteUserGlobally(targetKey, muted = true) {
    if (typeof targetKey !== 'string' || !targetKey) return;
    const storageKey = `cc:user-muted:${targetKey}`;
    if (muted) {
      this.userMutes[targetKey] = true;
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(storageKey, '1');
        } catch {
          // localStorage may be unavailable (private mode / quota); the
          // in-memory map still drives the session-local reactive view.
        }
      }
    } else {
      delete this.userMutes[targetKey];
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          // ditto.
        }
      }
    }
  }

  /**
   * Read the global per-user mute state. Returns true when
   * ``cc:user-muted:{targetKey}`` is present in localStorage OR the
   * in-memory ``userMutes`` map has the key — the map mirrors the
   * persistent store so components reading this in a $derived block
   * re-run on mute toggles without a page reload.
   *
   * @param {string} targetKey
   * @returns {boolean}
   */
  isUserGloballyMuted(targetKey) {
    if (typeof targetKey !== 'string' || !targetKey) return false;
    if (this.userMutes[targetKey] === true) return true;
    if (typeof localStorage === 'undefined') return false;
    try {
      return localStorage.getItem(`cc:user-muted:${targetKey}`) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Resolve the caller's role on a channel.
   *
   * [VERIFY surfaced 2026-05-18 by Wave B implementer]: there is NO
   * MCP wrapper that exposes 3.0a's ``RegistryStore.get_channel_role``
   * (verified by grep against ``src/claude_comms/mcp_tools.py`` +
   * ``mcp_server.py``). A follow-up Wave B.5 / Wave C step should add
   * ``comms_get_channel_role`` so this accessor can hydrate the
   * ``channelRoles`` cache async on bootstrap + channel-join.
   *
   * Until then, this returns a role via CLIENT-SIDE INFERENCE:
   *   - If the caller's key matches ``channel.createdBy`` (or, for
   *     pre-3.0a grandfather rows, their display name matches the
   *     legacy ``createdBy`` text per 3.0a's backfill semantics)
   *     → ``'owner'``
   *   - Otherwise → ``'member'``
   *   - ``'admin'`` is never synthesized client-side; that role
   *     requires the future ``comms_get_channel_role`` wrapper.
   *
   * The resolved role is also written to ``this.channelRoles`` so
   * consumers can subscribe to the reactive cache (Svelte $state)
   * instead of polling this method. Future async hydration via the
   * MCP wrapper will write the same cache.
   *
   * @param {string} channelId
   * @returns {'owner' | 'admin' | 'member' | null}
   */
  getChannelRole(channelId) {
    if (typeof channelId !== 'string' || !channelId) return null;
    const ch = this.channelsById[channelId];
    if (!ch) return null;

    const selfKey = this.userProfile?.key ?? '';
    const selfName = this.userProfile?.name ?? '';
    const creator = ch.createdBy ?? '';

    let role;
    if (selfKey && creator && creator === selfKey) {
      role = 'owner';
    } else if (selfName && creator && creator === selfName) {
      // 3.0a grandfather backfill: legacy rows persist createdBy as
      // the display name instead of the key. Match defensively so
      // owners aren't silently demoted to member when their channel
      // pre-dates the schema migration.
      role = 'owner';
    } else {
      role = 'member';
    }

    this.channelRoles[channelId] = role;
    return role;
  }

  /**
   * v0.4.2 Step 3.6: ``comms_check`` hydration for all joined channels
   * (UX G-10/G-11).
   *
   * Issues a single ``comms_check`` MCP call (no ``conversation`` arg
   * → server scans every conversation the caller is a member of,
   * verified at mcp_tools.py:1030-1034). For each entry in the
   * response's ``unread_summary``:
   *
   *   - ``channels[id].unread`` ← ``unread_count``
   *   - ``channels[id].lastActivity`` ← ``latest.ts`` (when present)
   *   - ``channels[id].unreadHasMention`` ← true iff ``latest.mentions``
   *     includes the caller's key (best-effort; the v0.4.0 wire
   *     ``latest`` may not include the full mention list, in which
   *     case the field is left untouched so a previous bootstrap value
   *     survives).
   *
   * Channels NOT present in the response are zeroed (server confirms
   * they have no unread). This matches the design-spec invariant: the
   * server is authoritative for unread counts after ``comms_check``.
   *
   * Best-effort: any error (network down, daemon refused,
   * malformed response) is swallowed so the connect path doesn't
   * fail on a transient daemon hiccup. The local state stays
   * unchanged until the next successful call.
   *
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async checkChannels() {
    // Record the attempt timestamp UP FRONT so the throttle gate
    // engages even if the call itself rejects; we don't want a
    // hammering loop on a flaky daemon.
    this.#lastCommsCheckAt = Date.now();

    if (!this.userProfile?.key) {
      return { success: false, error: 'No participant key.' };
    }
    if (typeof mcpCall !== 'function') {
      return { success: false, error: 'mcpCall unavailable.' };
    }

    let result;
    try {
      result = await mcpCall('comms_check', {
        key: this.userProfile.key,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return { success: false, error: msg };
    }
    if (!result || !result.success) {
      return { success: false, error: result?.error || 'comms_check failed.' };
    }

    const payload = result.payload || {};
    const summary = Array.isArray(payload.unread_summary)
      ? payload.unread_summary
      : [];
    // Build a set of channels the server confirmed have unread so we
    // can zero everything else after the loop (server-authoritative).
    const hydrated = new Set();
    for (const entry of summary) {
      if (!entry || typeof entry.conversation !== 'string') continue;
      const ch = this.channelsById[entry.conversation];
      if (!ch) continue;
      hydrated.add(entry.conversation);
      if (typeof entry.unread_count === 'number') {
        ch.unread = entry.unread_count;
      }
      const latest = entry.latest;
      if (latest && typeof latest === 'object') {
        if (typeof latest.ts === 'string' && latest.ts) {
          ch.lastActivity = latest.ts;
        }
        // Best-effort mention detection: only set true when the wire
        // ``latest`` carries an explicit mentions list including the
        // caller. Otherwise leave the field untouched so a prior
        // value (e.g. from a previous comms_check) survives.
        if (Array.isArray(latest.mentions) && this.userProfile?.key) {
          if (latest.mentions.includes(this.userProfile.key)) {
            ch.unreadHasMention = true;
          }
        }
      }
    }
    // Zero unread on every joined channel the server didn't surface.
    // Skips non-member rows (those don't carry unread anyway) so the
    // directory's Browse tab doesn't get its unread badges blown away.
    for (const ch of Object.values(this.channelsById)) {
      if (!ch.member) continue;
      if (hydrated.has(ch.id)) continue;
      ch.unread = 0;
      ch.unreadHasMention = false;
    }
    return { success: true };
  }

  /**
   * Throttle-aware wrapper around ``checkChannels``. Used by the
   * ``visibilitychange`` re-fire path so a user thrashing browser
   * focus doesn't issue a flood of ``comms_check`` calls. The
   * ``'connect'`` callback skips this wrapper and calls
   * ``checkChannels`` directly so the very first fetch always runs.
   *
   * Throttle window: ``MqttChatStore.#COMMS_CHECK_THROTTLE_MS`` (30s).
   *
   * @returns {Promise<{ success: boolean, error?: string, throttled?: boolean }>}
   */
  async #maybeCheckChannels() {
    const elapsed = Date.now() - this.#lastCommsCheckAt;
    if (elapsed < MqttChatStore.#COMMS_CHECK_THROTTLE_MS) {
      return { success: true, throttled: true };
    }
    return this.checkChannels();
  }

  /**
   * Enqueue a disconnected admin action for drain-on-reconnect.
   * Mirrors ``#queuePendingSend`` but for MCP RPC calls. When the cap
   * is hit, drops the OLDEST entry and fires its rollback closure so
   * the optimistic local update doesn't linger forever on a stale
   * intent.
   *
   * @param {{ kind: string, channelId: string, run: () => Promise<{success: boolean, error?: string}>, rollback: () => void }} action
   */
  #queueAdminAction(action) {
    if (this.#pendingAdminActions.length >= MqttChatStore.#PENDING_ADMIN_ACTIONS_CAP) {
      const dropped = this.#pendingAdminActions.shift();
      if (dropped && typeof dropped.rollback === 'function') {
        try {
          dropped.rollback();
        } catch {
          // Rollback errors are best-effort; the queue overflow is
          // already a degraded path.
        }
      }
    }
    this.#pendingAdminActions.push(action);
  }

  /**
   * Drain the pending admin-action queue in FIFO order. Called from
   * the ``'connect'`` callback alongside ``#drainPendingSends``. Each
   * entry's ``run`` is awaited so a rejection (or non-success
   * envelope) fires the matching ``rollback`` synchronously, keeping
   * the local state honest with the wire state. Failures don't abort
   * the drain; remaining actions still get their shot.
   */
  async #drainPendingAdminActions() {
    if (this.#pendingAdminActions.length === 0) return;
    const queue = this.#pendingAdminActions;
    this.#pendingAdminActions = [];
    for (const action of queue) {
      let result;
      try {
        result = await action.run();
      } catch (err) {
        result = {
          success: false,
          error: err && err.message ? err.message : String(err),
        };
      }
      if (!result || !result.success) {
        try {
          action.rollback();
        } catch {
          // Best-effort.
        }
      }
    }
  }

  /**
   * Attach the ``document.visibilitychange`` listener so the store
   * re-fires ``comms_check`` (subject to the 30s throttle) whenever
   * the tab regains visibility. Idempotent: calling twice replaces
   * the previous listener so a reconnect doesn't accumulate handlers.
   *
   * No-op in non-DOM environments (e.g. SSR / vitest without jsdom's
   * document); the test harness exercises the path through the
   * ``_simulateVisibilityChangeForTest`` seam.
   */
  #attachVisibilityListener() {
    if (typeof document === 'undefined') return;
    this.#detachVisibilityListener();
    const handler = () => {
      // ``visibilityState`` is the spec-blessed source of truth
      // (``hidden`` getter is deprecated). Skip ``hidden`` transitions
      // entirely. Only re-fire when the user comes BACK to the tab.
      if (document.visibilityState !== 'visible') return;
      // Throttle internally; swallow rejections so a listener never
      // surfaces an unhandled-rejection warning.
      this.#maybeCheckChannels().catch(() => {
        /* best-effort */
      });
    };
    this.#visibilityHandler = handler;
    document.addEventListener('visibilitychange', handler);
  }

  /**
   * Detach the ``visibilitychange`` listener installed by
   * ``#attachVisibilityListener``. Safe to call when no listener is
   * attached.
   */
  #detachVisibilityListener() {
    if (typeof document === 'undefined') return;
    if (!this.#visibilityHandler) return;
    document.removeEventListener('visibilitychange', this.#visibilityHandler);
    this.#visibilityHandler = null;
  }

  // ── v0.4.2 Step 3.6: test seams ──

  /**
   * Test-only seam: run the throttle-aware wrapper directly so specs
   * can assert the 30s gate without standing up a real document
   * listener.
   */
  async _maybeCheckChannelsForTest() {
    return this.#maybeCheckChannels();
  }

  /** Test-only seam: read the throttle timestamp. */
  _lastCommsCheckAtForTest() {
    return this.#lastCommsCheckAt;
  }

  /** Test-only seam: force the throttle timestamp (e.g. to reset to 0). */
  _setLastCommsCheckAtForTest(value) {
    this.#lastCommsCheckAt = value;
  }

  /** Test-only seam: queue size for the admin-action queue. */
  _pendingAdminActionsLengthForTest() {
    return this.#pendingAdminActions.length;
  }

  /** Test-only seam: drain the admin-action queue without standing up a broker. */
  async _drainPendingAdminActionsForTest() {
    await this.#drainPendingAdminActions();
  }

  /**
   * Test-only seam: simulate a ``visibilitychange`` transition to
   * ``visible``. Drives the same code path the production listener
   * does so the throttle + ``checkChannels`` wiring is exercised
   * without a jsdom dispatch. Returns the result envelope so specs
   * can assert on the ``throttled`` flag.
   */
  async _simulateVisibilityRegainForTest() {
    return this.#maybeCheckChannels();
  }

  /**
   * Set the local user's profile status (UX G-24, v0.4.2 Step 3.13).
   * Calls Wave A2's ``comms_profile_status_set`` MCP tool. The MCP-boundary
   * arg names are snake_case (``emoji``, ``text``, ``expires_at``) — do
   * not rename without coordinating with Step 3.14's backend wrapper.
   *
   * Optimistic local update: the caller's ``userProfile.profileStatus``
   * is rewritten BEFORE the MCP call lands so the Sidebar status row
   * refreshes instantly. On failure the previous status is restored.
   *
   * Disconnected-state behaviour: mirrors the Wave B admin accessors
   * (``setTopic``, ``deleteChannel``, ``renameChannel``) — they fire the
   * MCP HTTP request regardless of MQTT broker connection state and
   * surface ``{ success: false, error }`` if it fails. The
   * ``#pendingSends`` queue is reserved for outgoing MQTT chat messages
   * (UX G-62), not for MCP admin calls.
   *
   * @param {string|null} emoji - Single emoji glyph or null to omit.
   * @param {string|null} text - Status text (server enforces a 60-char
   *   cap — we don't pre-truncate here, but the StatusEditor UI does).
   * @param {string|null} [expiresAt=null] - ISO-8601 expiry timestamp
   *   ("never expires" if null). Forwarded to the MCP tool's
   *   ``expires_at`` arg.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async setProfileStatus(emoji, text, expiresAt = null) {
    // Both emoji + text being absent is treated as a "clear" request;
    // the explicit clear accessor is preferred but tolerate this here.
    if (emoji == null && text == null) {
      return this.clearProfileStatus();
    }

    const prevStatus = this.userProfile.profileStatus
      ? { ...this.userProfile.profileStatus }
      : null;
    this.userProfile.profileStatus = {
      emoji: emoji ?? null,
      text: text ?? null,
      expires_at: expiresAt ?? null,
    };

    const result = await mcpCall('comms_profile_status_set', {
      key: this.userProfile.key,
      emoji: emoji ?? null,
      text: text ?? null,
      expires_at: expiresAt ?? null,
    });
    if (!result.success) {
      this.userProfile.profileStatus = prevStatus;
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  /**
   * Clear the local user's profile status (UX G-24, v0.4.2 Step 3.13).
   * Calls Wave A2's ``comms_profile_status_clear`` MCP tool (no args
   * beyond ``key``). Optimistic local clear with rollback on failure.
   *
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async clearProfileStatus() {
    const prevStatus = this.userProfile.profileStatus
      ? { ...this.userProfile.profileStatus }
      : null;
    this.userProfile.profileStatus = null;

    const result = await mcpCall('comms_profile_status_clear', {
      key: this.userProfile.key,
    });
    if (!result.success) {
      this.userProfile.profileStatus = prevStatus;
      return { success: false, error: result.error };
    }
    return { success: true };
  }

  /**
   * Set the mute level for a channel. Q4 lock (v0.4.0) — local only;
   * writes to ``localStorage['claude-comms.mute.{id}']`` and updates the
   * in-memory ``muteLevel`` + ``muted`` (bool) fields. No MCP call goes
   * out. Server-side per-user mute persistence is v0.4.1 work.
   *
   * Valid levels: ``"off" | "mentions" | "all"`` (Design Spec §8.2).
   * Anything else is rejected.
   *
   * @param {string} id - Channel id.
   * @param {"off"|"mentions"|"all"} level - Desired mute level.
   * @returns {{ success: boolean, error?: string }}
   */
  setMute(id, level) {
    if (typeof id !== 'string' || !id) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (!MUTE_LEVELS.includes(level)) {
      return { success: false, error: 'Invalid mute level.' };
    }
    const ch = this.channelsById[id];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    ch.muteLevel = level;
    ch.muted = level !== 'off';
    safeStorage.setItem(MUTE_STORAGE_PREFIX + id, level);
    return { success: true };
  }

  // ──────────────────────────────────────────────────────────────────
  // v0.4.2 Step 3.9 (Wave G) — per-channel notification policy +
  // highlight words. Pinned cross-edge contract:
  //
  //   getNotificationPolicy(id)     → {policy, highlightWords}
  //   setNotificationPolicy(id, p, w?)
  //   cycleNotificationPolicy(id)   → next policy string
  //
  // Storage: localStorage key ``cc:notif-policy:{id}`` carrying a
  // JSON-encoded ``{policy, highlightWords}`` blob. Default for any id
  // with no stored value is ``{policy: 'All', highlightWords: []}``.
  // Reactive cache: ``this.notificationPolicies`` ($state map) is
  // populated lazily on the first ``getNotificationPolicy`` call so
  // consumers can read via ``$derived`` and re-render on every write.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Get the per-channel notification policy + highlight-words pair.
   *
   * Lazy localStorage read: if the in-memory cache entry doesn't exist,
   * decode it from localStorage and populate the cache so consumers
   * subscribed via ``$derived`` re-render on subsequent ``setNotificationPolicy``
   * writes without a second round-trip. Missing / malformed entries
   * fall back to ``{policy: 'All', highlightWords: []}``.
   *
   * @param {string} channelId
   * @returns {{policy: 'All' | 'Mentions' | 'Off', highlightWords: string[]}}
   */
  getNotificationPolicy(channelId) {
    if (typeof channelId !== 'string' || !channelId) {
      return { policy: 'All', highlightWords: [] };
    }
    const cached = this.notificationPolicies[channelId];
    if (cached) return cached;

    const raw = safeStorage.getItem(NOTIF_POLICY_STORAGE_PREFIX + channelId);
    let decoded = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const policy = NOTIF_POLICIES.includes(parsed.policy) ? parsed.policy : 'All';
          const words = Array.isArray(parsed.highlightWords)
            ? parsed.highlightWords
                .filter((w) => typeof w === 'string' && w.length > 0)
                .map((w) => w.toLowerCase())
            : [];
          decoded = { policy, highlightWords: words };
        }
      } catch {
        // Malformed JSON in localStorage — fall through to defaults.
      }
    }
    const entry = decoded ?? { policy: 'All', highlightWords: [] };
    // Populate the reactive cache so subsequent reads are O(1) and
    // writes flow through the $state mutation.
    this.notificationPolicies = { ...this.notificationPolicies, [channelId]: entry };
    return entry;
  }

  /**
   * Set the per-channel notification policy. If ``highlightWords`` is
   * omitted (undefined), preserves the existing list — callers that
   * only want to change the policy radio don't have to re-pass the
   * full words array. Empty string entries are filtered; words are
   * lowercased on write so the case-insensitive substring match in
   * ``#handleChatMessage`` is a plain ``.includes()`` against an
   * already-normalized input.
   *
   * @param {string} channelId
   * @param {'All' | 'Mentions' | 'Off'} policy
   * @param {string[]} [highlightWords]
   * @returns {{success: boolean, error?: string}}
   */
  setNotificationPolicy(channelId, policy, highlightWords) {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channel id.' };
    }
    if (!NOTIF_POLICIES.includes(policy)) {
      return { success: false, error: 'Invalid notification policy.' };
    }
    const existing = this.getNotificationPolicy(channelId);
    let nextWords;
    if (highlightWords === undefined) {
      nextWords = existing.highlightWords;
    } else if (Array.isArray(highlightWords)) {
      nextWords = highlightWords
        .filter((w) => typeof w === 'string' && w.trim().length > 0)
        .map((w) => w.trim().toLowerCase());
    } else {
      nextWords = [];
    }
    const entry = { policy, highlightWords: nextWords };
    // Immutable map replacement so $derived consumers re-fire.
    this.notificationPolicies = {
      ...this.notificationPolicies,
      [channelId]: entry,
    };
    safeStorage.setItem(
      NOTIF_POLICY_STORAGE_PREFIX + channelId,
      JSON.stringify(entry),
    );
    return { success: true };
  }

  /**
   * Q8 kebab quickview 1-click helper. Cycles ``All → Mentions → Off →
   * All`` and returns the new policy string so the caller (the
   * ChannelContextMenu quickview row) can show it without a follow-up
   * read.
   *
   * @param {string} channelId
   * @returns {'All' | 'Mentions' | 'Off'} The new policy after cycling.
   */
  cycleNotificationPolicy(channelId) {
    const current = this.getNotificationPolicy(channelId);
    const next = NOTIF_POLICY_CYCLE[current.policy] ?? 'All';
    this.setNotificationPolicy(channelId, next);
    return next;
  }

  /**
   * Set the starred flag for a channel. v0.4.0 Q4-adjacent local lock —
   * writes to ``localStorage['claude-comms.star.{id}']`` and updates the
   * in-memory ``starred`` field. No MCP call. Server-side star
   * personalization is v0.4.1 work.
   *
   * Auto-unstar invariant (Design Spec §2.6): if the caller passes
   * ``starred = true`` for a non-member channel, it still flips the
   * local flag — but the ``starredChannels`` projection requires
   * ``member && starred`` so the row stays out of the Starred section
   * anyway. ``leaveChannel`` flips this back to ``false`` on commit so
   * the localStorage state matches the user-visible state.
   *
   * @param {string} id - Channel id.
   * @param {boolean} starred - Desired starred state.
   * @returns {{ success: boolean, error?: string }}
   */
  setStar(id, starred) {
    if (typeof id !== 'string' || !id) {
      return { success: false, error: 'Missing channel id.' };
    }
    const ch = this.channelsById[id];
    if (!ch) return { success: false, error: 'Unknown channel.' };

    ch.starred = !!starred;
    safeStorage.setItem(STAR_STORAGE_PREFIX + id, ch.starred ? 'true' : 'false');
    return { success: true };
  }

  /**
   * Mark all unread messages in a channel as read.
   *
   * Polish wave P1 (v0.4.2 Wave 0): the v0.4.0 Sidebar context menu's
   * "Mark all as read" action was wired but the store method was a
   * no-op stub (Step 2.12 surfaced this as a follow-up). The Sidebar
   * handler short-circuits with a TODO comment pointing at this
   * method's absence. This implementation closes the gap.
   *
   * Local read-cursor advances first (zero ``unread`` + clear the
   * mention dot) so the sidebar updates immediately without waiting
   * for the broker. ``lastReadAt`` is stamped as a fresh ISO timestamp
   * so any incoming message can compare its ``ts`` against the right
   * baseline (the v0.4.2 unread-divider work in Phase 3 will read this
   * field). Then a best-effort ``comms_check`` ack fires through
   * ``mcpCall`` to inform the server-side authoritative state; the
   * server's response is NOT awaited — the local update is what the
   * user sees, and the next ``comms_check`` on reconnect / visibility-
   * regain (v0.4.1's existing pattern) will reconcile any drift.
   *
   * No-op when ``channelId`` is missing or unknown (matches the
   * defensive style of ``setStar`` / ``setMute``).
   *
   * @param {string} channelId - The channel to mark fully read.
   */
  markAllRead(channelId) {
    if (typeof channelId !== 'string' || !channelId) return;
    const ch = this.channelsById?.[channelId];
    if (!ch) return;
    // Local clear — zero the unread counter + mention-dot flag so the
    // sidebar updates immediately. The server-side authoritative state
    // catches up on the next comms_check.
    ch.unread = 0;
    ch.unreadHasMention = false;
    // Drop the legacy v0.3.x "first unread message id" cursor too so
    // the per-channel unread divider lands at the new baseline rather
    // than re-anchoring to a stale id.
    ch.unreadFrom = null;
    // Stamp the read cursor so v0.4.2's unread-divider work has a
    // baseline for comparing incoming message timestamps.
    ch.lastReadAt = new Date().toISOString();
    // Persist the cleared unread state so a page refresh doesn't
    // resurrect the cleared markers from localStorage.
    this.#saveUnreadMarkers();
    // Best-effort comms_check ack via mcpCall; swallow errors (the
    // local state is already correct; this just keeps the daemon in
    // sync sooner than the next reconnect would).
    if (typeof mcpCall === 'function' && this.userProfile?.key) {
      try {
        const result = mcpCall('comms_check', {
          key: this.userProfile.key,
          conversation: channelId,
        });
        if (result && typeof result.catch === 'function') {
          result.catch(() => { /* best-effort; local state already correct */ });
        }
      } catch {
        /* best-effort; local state already correct */
      }
    }
  }

  /**
   * Generic 15-second-undo wrapper used by ``leaveChannel`` and
   * ``archiveChannel``. Returns ``{ done, cancel }``:
   *
   *   - ``done``  — Promise resolved to either:
   *       * ``{ success, error?, cancelled: false }`` after the
   *         ``commitMcp`` fn fires (post-15s window)
   *       * ``{ success: true, cancelled: true }`` if ``cancel()``
   *         was called inside the window
   *   - ``cancel()`` — abort the pending commit:
   *       * Inside the window: runs ``rollback``, prevents
   *         ``commitMcp``, resolves ``done`` with
   *         ``{ cancelled: true }``. Returns ``{ tooLate: false }``.
   *       * After the window (commit already fired): no-op,
   *         returns ``{ tooLate: true }`` so the caller can show
   *         a "Too late to undo" toast.
   *
   * The three callbacks split responsibility cleanly so the row
   * visually updates the moment the user clicks (optimistic), the
   * MCP call is deferred (commitMcp), and the user has 15s to revert
   * (rollback). Architecture spec §III.4 step 2.6 mandates the
   * deferred-call behaviour: "If `cancel()` fires within 15s, the
   * underlying MCP call is aborted."
   *
   * @param {() => void} optimisticFn - Apply the local visual change
   *   immediately (sync). Runs before the 15s timer starts.
   * @param {() => void} rollbackFn - Revert the optimistic change.
   *   Runs when ``cancel()`` fires inside the window.
   * @param {() => Promise<{success: boolean, error?: string}>} commitMcpFn -
   *   Fire the actual MCP call. Runs after the 15s window if no cancel.
   *   Responsible for its own error-path rollback.
   * @returns {{ done: Promise<{success: boolean, error?: string, cancelled?: boolean}>, cancel: () => ({tooLate: boolean}) }}
   */
  #scheduleUndoable(optimisticFn, rollbackFn, commitMcpFn) {
    // Optimistic side-effects happen synchronously so the caller's row
    // visibly leaves the section the moment they click.
    try {
      optimisticFn();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return {
        done: Promise.resolve({ success: false, error: msg, cancelled: false }),
        cancel: () => ({ tooLate: true }),
      };
    }

    let cancelled = false;
    let committed = false;
    let timer = null;
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    timer = setTimeout(async () => {
      timer = null;
      if (cancelled) return;
      committed = true;
      try {
        const result = await commitMcpFn();
        resolveDone({ ...result, cancelled: false });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        resolveDone({ success: false, error: msg, cancelled: false });
      }
    }, UNDO_WINDOW_MS);

    const cancel = () => {
      if (committed) return { tooLate: true };
      if (cancelled) return { tooLate: false };
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Roll back the optimistic change. Don't let a thrown rollback
      // corrupt the resolved value — log + carry on.
      try {
        rollbackFn();
      } catch (err) {
        console.error('[claude-comms] undo rollback threw', err);
      }
      resolveDone({ success: true, cancelled: true });
      return { tooLate: false };
    };

    return { done, cancel };
  }

  /**
   * Test-only seam: shorten the undo window so vitest specs don't have
   * to literally wait 15 seconds for the commit timer. Mirrors
   * ``_drainPendingSendsForTest`` / ``_bootstrapChannelsForTest`` —
   * private slot wrapper for tests, not part of the production surface.
   *
   * @returns {Promise<void>} Resolves when any pending undoable commits
   *   have finished (the next microtask, plus any pending timers).
   */
  async _flushUndoableCommitsForTest() {
    // Bump the timer by faking the clock isn't possible without a vi.mock
    // setup; instead, tests inject their own timer via vi.useFakeTimers
    // and call vi.runAllTimers() before awaiting the done promise. This
    // seam exists for any future test path that wants a sync flush hook.
    await Promise.resolve();
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
    for (const ch of Object.values(this.channelsById)) {
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
        for (const ch of Object.values(this.channelsById)) {
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
   * Wire format (set by ``publish_conversation_event`` and
   * ``_publish_archive_event`` in mcp_server.py, plus the direct
   * ``conversation_deleted`` publish in ``mcp_tools.tool_comms_conversation_delete``)::
   *
   *     // v0.3.2 create / topic_changed (key field: ``name``)
   *     { type: "conversation_created"
   *             | "conversation_topic_changed"
   *             | "conversation_deleted",
   *       name: "<conv-id>",
   *       topic: "<optional>",                # create / topic_changed
   *       creator_key: "<8-hex>",             # create
   *       deleted_by: "<actor-name>",         # delete (v0.4.0 extension)
   *       ts: "<ISO8601>" }
   *
   *     // v0.4.0 Step 2.2 — alternate "deleted" alias (key field: ``id``)
   *     { type: "deleted", id, deletedBy, timestamp }
   *
   *     // v0.4.0 Step 2.3 — archive lifecycle (key field: ``id``)
   *     { type: "archived" | "unarchived", id, archivedBy?, timestamp }
   *
   *     // Forward-compat — types the backend may publish in v0.4.x
   *     { type: "renamed", id, name, renamedBy?, timestamp }
   *     { type: "member_joined" | "member_left", id, key, timestamp }
   *
   * Updates the in-store ``channels`` map so the left sidebar reflects
   * remote conversation mutations live, instead of waiting for the next
   * page reload. The REST snapshot remains the authoritative source on
   * page bootstrap; this handler is the live-delta layer on top.
   *
   * v0.4.0 Step 2.7 design notes:
   *   - **Dual id field**: the daemon publishes some events with ``msg.id``
   *     (Steps 2.2 / 2.3) and others with ``msg.name`` (v0.3.2 originals).
   *     We accept either and prefer ``id`` if present.
   *   - **Deletion + archive while viewing**: if the active channel is the
   *     one being deleted/archived, switch via ``#resetActiveChannelIfStale``
   *     and clear the local message buffer for that channel so a re-join
   *     later starts clean.
   *   - **Lifecycle toast**: writes a single-slot reactive payload to
   *     ``latestChannelLifecycleToast`` so the App can surface
   *     "#<name> was deleted by <user>" / "#<name> was archived by <user>"
   *     without a polling loop. Toast is suppressed when
   *     ``inAppToasts === false`` (Settings opt-out).
   *   - **Unknown ``type``**: logs structured context + bumps the parse-
   *     failure rate (mirrors v0.3.1's ``#receiveMqttFrame`` discipline)
   *     and skips. Never throws — one rogue type can't freeze the stream.
   */
  #handleSystemConversation(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this.#logSystemConversationParseFailure('non-object or missing type', msg);
      return;
    }
    // Dual-format id resolution — Steps 2.2 / 2.3 events carry ``id``,
    // v0.3.2 events carry ``name``. Prefer id; fall back to name.
    const id =
      typeof msg.id === 'string' && msg.id.length > 0
        ? msg.id
        : typeof msg.name === 'string' && msg.name.length > 0
          ? msg.name
          : null;
    if (id === null) {
      this.#logSystemConversationParseFailure('missing both id and name', msg);
      return;
    }
    switch (msg.type) {
      case 'created':
      case 'conversation_created': {
        // Insert if not present. Don't clobber unread / starred state if
        // the user had previously cached this channel locally.
        if (!this.channelsById[id]) {
          // v0.4.0 Step 2.6 — populate the full ChannelRow shape so the
          // new row carries all the fields the 3-section sidebar
          // ($derived projections) needs. The lifecycle event only
          // carries ``name``, ``topic``, ``creator_key``, ``ts`` — defaults
          // fill the rest. ``member`` defaults FALSE (the creator's row
          // gets flipped to true once their own ``comms_join`` confirms;
          // before that, this row surfaces in Available for everyone
          // including the creator, matching server-truth).
          this.channelsById[id] = this.#channelRowFromPayload({
            id,
            name: id,
            topic: typeof msg.topic === 'string' ? msg.topic : '',
            member: false,
            memberCount: 0,
            lastActivity: this.#extractEventTimestamp(msg),
            mode: 'public',
            visibility: 'public',
            createdAt: this.#extractEventTimestamp(msg),
            createdBy: typeof msg.creator_key === 'string' ? msg.creator_key : null,
            myUnread: 0,
            myStarred: false,
            myMuted: false,
          });
        }
        break;
      }
      case 'topic_changed':
      case 'conversation_topic_changed': {
        const existing = this.channelsById[id];
        if (existing && typeof msg.topic === 'string') {
          existing.topic = msg.topic;
        }
        break;
      }
      case 'renamed': {
        // v0.4.x forward-compat — the daemon does not publish this yet
        // as of v0.4.0 Step 2.7. When it does, ``msg.name`` carries the
        // NEW name (distinct from the id field, which is the immutable
        // conversation id used as the routing key).
        const existing = this.channelsById[id];
        if (existing && typeof msg.name === 'string' && msg.name.length > 0) {
          existing.name = msg.name;
        }
        break;
      }
      case 'deleted':
      case 'conversation_deleted': {
        // Snapshot the row name + actor BEFORE we remove the entry so
        // the toast can render "#<name> was deleted by <user>" even
        // though the row is about to disappear.
        const removedRow = this.channelsById[id];
        const removedName = removedRow ? (removedRow.name || id) : id;
        const wasActive = this.activeChannel === id;
        if (removedRow) {
          delete this.channelsById[id];
        }
        // Clear local message buffer for this channel so a future re-
        // join doesn't surface stale messages from before the delete.
        this.messages = this.messages.filter((m) => m.channel !== id);
        // If the user was viewing the deleted channel, fall back to the
        // first member channel (alpha-sorted) per the post-Step-2.5
        // follow-up. ``#resetActiveChannelIfStale`` finds a sensible
        // target or leaves ``activeChannel = null`` for the empty-state.
        if (wasActive) {
          this.activeChannel = null;
          this.#resetActiveChannelIfStale();
        }
        // Surface a lifecycle toast — only when there was actually
        // something to remove or the user was viewing it. Avoids
        // spamming a toast for a redundant delete echo.
        if (removedRow || wasActive) {
          this.#emitChannelLifecycleToast({
            kind: 'deleted',
            channelId: id,
            channelName: removedName,
            by: this.#extractEventActor(msg, ['deletedBy', 'deleted_by']),
          });
        }
        break;
      }
      case 'archived': {
        const existing = this.channelsById[id];
        const wasActive = this.activeChannel === id;
        if (existing) {
          existing.archived = true;
          existing.archived_at = this.#extractEventTimestamp(msg);
          existing.archived_by = this.#extractEventActor(msg, ['archivedBy', 'archived_by']);
        }
        // Clear local message buffer so a future unarchive + re-view
        // re-fetches fresh history rather than reading the stale buffer.
        this.messages = this.messages.filter((m) => m.channel !== id);
        if (wasActive) {
          this.activeChannel = null;
          this.#resetActiveChannelIfStale();
        }
        if (existing || wasActive) {
          this.#emitChannelLifecycleToast({
            kind: 'archived',
            channelId: id,
            channelName: existing ? (existing.name || id) : id,
            by: this.#extractEventActor(msg, ['archivedBy', 'archived_by']),
          });
        }
        break;
      }
      case 'unarchived': {
        const existing = this.channelsById[id];
        if (existing) {
          existing.archived = false;
          existing.archived_at = null;
          existing.archived_by = null;
        }
        // No toast on unarchive — non-destructive, the row re-appearing
        // in Available is sufficient visual feedback.
        break;
      }
      case 'member_joined': {
        // Forward-compat: the daemon does not yet publish this on
        // ``system/conversations`` as of v0.4.0 Step 2.7 (member
        // presence is fanned out on per-conv presence topics handled
        // elsewhere). When the daemon adds it, this branch will
        // increment the local member counter without waiting for the
        // next REST poll.
        const existing = this.channelsById[id];
        if (existing) {
          existing.memberCount = (existing.memberCount || 0) + 1;
          const ts = this.#extractEventTimestamp(msg);
          if (ts) existing.lastActivity = ts;
          // If the join is for ME and I wasn't a member yet, flip the
          // flag so the row moves into the Active section.
          const selfKey = this.userProfile?.key;
          if (
            selfKey &&
            typeof msg.key === 'string' &&
            msg.key === selfKey &&
            !existing.member
          ) {
            existing.member = true;
          }
        }
        break;
      }
      case 'member_left': {
        // Forward-compat companion to member_joined. Decrements the
        // counter without going below 0 (defensive — a duplicate left
        // event should not produce a negative count).
        const existing = this.channelsById[id];
        if (existing) {
          existing.memberCount = Math.max(0, (existing.memberCount || 0) - 1);
          const ts = this.#extractEventTimestamp(msg);
          if (ts) existing.lastActivity = ts;
          const selfKey = this.userProfile?.key;
          if (
            selfKey &&
            typeof msg.key === 'string' &&
            msg.key === selfKey &&
            existing.member
          ) {
            existing.member = false;
            // Auto-unstar on self-leave (Design Spec §2.6 — star is a
            // member-only decoration).
            if (existing.starred) {
              existing.starred = false;
            }
          }
        }
        break;
      }
      default:
        // Unknown event type — log structured context and bump the
        // parse-failure rate so the App's "decoding errors detected"
        // banner can surface a spike. NEVER throw.
        this.#logSystemConversationParseFailure(
          `unknown type ${JSON.stringify(msg.type)}`,
          msg,
        );
        break;
    }
  }

  /**
   * Extract a usable ISO timestamp from a system-conversations event
   * payload. Daemon publishes ``ts`` (v0.3.2 events) or ``timestamp``
   * (v0.4.0 Steps 2.2 / 2.3 events). Returns the first non-empty
   * string match or ``null`` if neither is present.
   * @param {object} msg
   * @returns {string | null}
   */
  #extractEventTimestamp(msg) {
    if (typeof msg.ts === 'string' && msg.ts.length > 0) return msg.ts;
    if (typeof msg.timestamp === 'string' && msg.timestamp.length > 0) {
      return msg.timestamp;
    }
    return null;
  }

  /**
   * Extract the actor name from a system-conversations event using a
   * prioritized list of candidate field names. Lets the handler accept
   * both ``camelCase`` (Steps 2.2 / 2.3) and ``snake_case`` (v0.3.2)
   * conventions in one call.
   * @param {object} msg
   * @param {string[]} candidateFields
   * @returns {string | null}
   */
  #extractEventActor(msg, candidateFields) {
    for (const field of candidateFields) {
      const value = msg[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  }

  /**
   * Emit a single-slot reactive payload describing a channel-lifecycle
   * event the App should surface as a toast. Suppressed when the user
   * has toggled in-app toasts off in Settings. The ``epoch`` counter
   * ensures two back-to-back toasts with identical payload still re-
   * fire the consumer's ``$effect`` (mirrors ``latestArtifactRefNotification``).
   *
   * @param {object} toast
   * @param {'deleted' | 'archived'} toast.kind
   * @param {string} toast.channelId
   * @param {string} toast.channelName
   * @param {string | null} toast.by
   */
  #emitChannelLifecycleToast({ kind, channelId, channelName, by }) {
    if (!this.inAppToasts) return;
    this.latestChannelLifecycleToast = {
      kind,
      channelId,
      channelName,
      by: by ?? null,
      epoch: (this.latestChannelLifecycleToast?.epoch ?? 0) + 1,
      ts: new Date().toISOString(),
    };
  }

  /**
   * Log a parse failure on a ``system/conversations`` payload with the
   * same structured-context discipline as ``#receiveMqttFrame``'s JSON-
   * parse failure path. Bumps ``parseFailureRate`` so the App banner
   * surfaces a spike if multiple bad payloads land in quick succession.
   * @param {string} reason
   * @param {*} msg
   */
  #logSystemConversationParseFailure(reason, msg) {
    let payloadPreview;
    try {
      const serialized = JSON.stringify(msg);
      const PREVIEW_LIMIT = 500;
      payloadPreview =
        typeof serialized === 'string' && serialized.length > PREVIEW_LIMIT
          ? serialized.slice(0, PREVIEW_LIMIT) + `... [truncated, total=${serialized.length}]`
          : serialized;
    } catch {
      payloadPreview = '<unserializable>';
    }
    console.error('[claude-comms] system/conversations event rejected', {
      topic: 'claude-comms/system/conversations',
      reason,
      payloadPreview,
      timestamp: new Date().toISOString(),
    });
    this.#recordParseFailure();
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
      const ch = this.channelsById[channel];
      if (ch) {
        ch.unread++;
        // v0.4.2 Step 3.10: propagate mention dot from live messages.
        // Mirrors the bootstrap path in ``checkChannels`` (line ~2824):
        // when ``msg.mentions`` is an explicit list including the
        // caller's participant key, raise ``unreadHasMention`` so the
        // sidebar's mention-dot variant fires even while the channel
        // is muted (Design Spec §8.2 invariant). Pre-3.10, only the
        // bootstrap fetch surfaced this flag; live messages silently
        // bumped ``unread`` without ever flipping the mention bit.
        if (
          Array.isArray(msg.mentions) &&
          this.userProfile?.key &&
          msg.mentions.includes(this.userProfile.key)
        ) {
          ch.unreadHasMention = true;
        }
        // v0.4.2 Step 3.9 (Wave G) — Q7 highlight-word match. After the
        // formal @-mention derivation, ALSO raise ``unreadHasMention``
        // when the message body case-insensitive-substring-matches any
        // of the channel's configured highlight words. Words are
        // pre-lowercased at store time (``setNotificationPolicy``), so
        // the match is a plain ``.includes()`` against a lowercased
        // body. An empty / unset words list short-circuits without a
        // localStorage read because the in-memory cache already returns
        // ``{policy: 'All', highlightWords: []}`` from
        // ``getNotificationPolicy``.
        if (!ch.unreadHasMention) {
          const { highlightWords } = this.getNotificationPolicy(channel);
          if (highlightWords.length > 0) {
            const body = typeof msg.body === 'string' ? msg.body.toLowerCase() : '';
            if (body.length > 0 && highlightWords.some((w) => body.includes(w))) {
              ch.unreadHasMention = true;
            }
          }
        }
      }
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
    const existing = this.channelsById[channelId];
    if (!existing) {
      // v0.4.0 Step 2.6 — populate the full ChannelRow shape so the new
      // row plays nicely with the 3-section sidebar projections.
      // ``member`` defaults FALSE — a meta broadcast doesn't imply
      // membership; the row appears in Available until the user joins.
      this.channelsById[channelId] = this.#channelRowFromPayload({
        id: channelId,
        name: channelId,
        topic: typeof msg.topic === 'string' ? msg.topic : '',
        member: false,
        memberCount: 0,
        mode: 'public',
        visibility: 'public',
        createdAt: msg.created_at || null,
        createdBy: msg.created_by || null,
        myUnread: 0,
        myStarred: false,
        myMuted: false,
      });
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
