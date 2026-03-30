import mqtt from 'mqtt';
import { generateUUID, generateKey } from './utils.js';

const BROKER_URL = 'ws://localhost:9001/mqtt';
const MCP_API_URL = 'http://localhost:9920';
const TOPIC_PREFIX = 'claude-comms';
const TYPING_TTL_MS = 5000;
const BASE_RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;
const BACKOFF_AFTER_ATTEMPTS = 5;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_CHANNEL_NAME_LENGTH = 50;
const MAX_DISPLAY_NAME_LENGTH = 50;

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

  /** @type {mqtt.MqttClient | null} */
  #client = null;
  #seenIds = new Set();
  #typingTimers = {};
  #myTypingTimer = null;
  #seenMessageIds = new Set();
  #failureCount = 0;
  #backoffActive = false;

  /**
   * Fetch message history from the REST API for a given channel.
   * Messages are deduplicated against the seen-ID set so live MQTT
   * messages that arrived before the history response don't appear twice.
   * @param {string} channel - The channel to fetch history for.
   */
  async #fetchHistory(channel) {
    try {
      const res = await fetch(`${MCP_API_URL}/api/messages/${encodeURIComponent(channel)}?count=50`);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.messages)) return;

      let added = 0;
      for (const msg of data.messages) {
        if (!msg.id || this.#seenIds.has(msg.id)) continue;
        this.#seenIds.add(msg.id);
        this.messages.push({
          ...msg,
          channel: channel,
        });
        added++;
      }
      if (added > 0) {
        // Sort messages chronologically after loading history
        this.messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));
        console.log(`[claude-comms] Loaded ${added} historical messages for #${channel}`);
      }
    } catch {
      // History fetch failed — not critical, live messages still work
    }
  }

  // ── Derived State ──
  activeMessages = $derived(
    this.messages.filter(m => m.channel === this.activeChannel)
  );

  activeChannelMeta = $derived(
    this.channels.find(c => c.id === this.activeChannel)
  );

  starredChannels = $derived(
    this.channels.filter(c => c.starred)
  );

  onlineParticipants = $derived(
    Object.values(this.participants).filter(p => p.status === 'online')
  );

  offlineParticipants = $derived(
    Object.values(this.participants).filter(p => p.status !== 'online')
  );

  activeTypingUsers = $derived(
    Object.entries(this.typingUsers)
      .filter(([key, info]) => {
        return info.channel === this.activeChannel
          && info.typing
          && key !== this.userProfile.key
          && (Date.now() - new Date(info.ts).getTime()) < TYPING_TTL_MS;
      })
      .map(([key, info]) => ({
        key,
        name: this.participants[key]?.name || key
      }))
  );

  activePinnedMessages = $derived(
    this.pinnedMessages.filter(m => m.channel === this.activeChannel)
  );

  onlineCount = $derived(
    Object.values(this.participants).filter(p => p.status === 'online').length
  );

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
  connect() {
    // Persist user key in localStorage so sessions reuse the same identity.
    // Without this, every page load creates a new retained presence message
    // on the broker, causing phantom participant accumulation.
    if (!this.userProfile.key) {
      const stored = safeStorage.getItem('claude-comms-user-key');
      if (stored) {
        this.userProfile.key = stored;
      } else {
        this.userProfile.key = generateKey();
        safeStorage.setItem('claude-comms-user-key', this.userProfile.key);
      }
    }

    // Also persist user name
    const storedName = safeStorage.getItem('claude-comms-user-name');
    if (storedName) this.userProfile.name = storedName;

    const clientId = 'claude-comms-web-' + this.userProfile.key + '-' + Math.random().toString(16).slice(2, 6);

    this.#client = mqtt.connect(BROKER_URL, {
      clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      will: {
        topic: TOPIC_PREFIX + '/system/participants/' + this.userProfile.key,
        payload: JSON.stringify({
          key: this.userProfile.key,
          name: this.userProfile.name,
          type: this.userProfile.type,
          status: 'offline'
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
      // Add ourselves to the participant list so we appear in the member sidebar
      this.participants[this.userProfile.key] = {
        key: this.userProfile.key,
        name: this.userProfile.name,
        type: this.userProfile.type,
        status: 'online',
      };
      // Fetch message history from the REST API so messages survive page refresh
      this.#fetchHistory(this.activeChannel);
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
    if (this.#client) {
      this.#publishPresence('offline');
      this.#client.end();
      this.#client = null;
      this.connected = false;
    }
  }

  /**
   * Send a chat message to the active channel.
   * The message is echoed locally before publishing to the broker,
   * so it appears immediately even on slow connections.
   * @param {string} body - The message text (whitespace-only bodies are ignored).
   * @param {string|null} replyTo - Optional ID of the message being replied to.
   */
  sendMessage(body, replyTo = null) {
    if (!body.trim()) return;

    const msg = {
      id: generateUUID(),
      ts: new Date().toISOString(),
      sender: {
        key: this.userProfile.key,
        name: this.userProfile.name,
        type: this.userProfile.type
      },
      recipients: null,
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
    if (ch) ch.unread = 0;

    this.activeChannel = channelId;

    // Re-subscribe to new channel topics if needed
    if (this.#client && this.connected) {
      this.#subscribeAll();
    }

    // Fetch history for the new channel
    this.#fetchHistory(channelId);
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

    this.channels.push({
      id,
      topic,
      starred: false,
      unread: 0
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
    }
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
   * Triggers reactivity via array spread.
   * @param {string} messageId - The message to react to.
   * @param {string} emoji - The emoji character to toggle.
   */
  addReaction(messageId, emoji) {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) {
      msg.reactions = [];
    }

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

    // Determine action for broadcast
    const action = existing && !existing.active ? 'remove' : 'add';

    // Trigger reactivity by reassigning
    this.messages = [...this.messages];

    // Broadcast reaction to other clients
    if (this.#client && this.connected) {
      const channel = msg.channel || msg.conv || this.activeChannel;
      const topic = TOPIC_PREFIX + '/conv/' + channel + '/reactions';
      this.#client.publish(topic, JSON.stringify({
        message_id: messageId,
        emoji,
        action,
        sender: {
          key: this.userProfile.key,
          name: this.userProfile.name,
          type: this.userProfile.type
        }
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
      this.pinnedMessages.splice(idx, 1);
      action = 'unpin';
    } else {
      this.pinnedMessages.push({ ...message, channel });
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

  #subscribeAll() {
    if (!this.#client) return;

    // Subscribe to all conversations
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/messages', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/presence/+', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/typing/+', { qos: 0 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/meta', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/reactions', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/pins', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/conv/+/deletions', { qos: 1 });
    this.#client.subscribe(TOPIC_PREFIX + '/system/participants/+', { qos: 1 });
  }

  #handleMessage(topic, msg) {
    if (!topic.startsWith(TOPIC_PREFIX + '/')) return;
    const topicParts = topic.slice(TOPIC_PREFIX.length + 1).split('/');
    // Debug: log all incoming MQTT messages (remove after verifying broker bridging)
    console.debug('[claude-comms] MQTT ←', topic, msg?.id || '(no id)');

    if (topicParts[0] === 'conv' && topicParts[2] === 'messages') {
      this.#handleChatMessage(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'presence') {
      this.#handlePresence(msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'typing') {
      this.#handleTyping(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'meta') {
      this.#handleMeta(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'reactions') {
      this.#handleRemoteReaction(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'pins') {
      this.#handleRemotePin(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'deletions') {
      this.#handleRemoteDeletion(topicParts[1], msg);
    } else if (topicParts[0] === 'system' && topicParts[1] === 'participants') {
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

    this.messages.push(message);
    console.log('[claude-comms] handleChatMessage: pushed to messages, total:', this.messages.length, 'channel:', channel, 'activeChannel:', this.activeChannel, 'activeMessages:', this.activeMessages.length);

    // Update unread count if not active channel
    if (channel !== this.activeChannel) {
      const ch = this.channels.find(c => c.id === channel);
      if (ch) ch.unread++;
    }
  }

  #handlePresence(msg) {
    // Skip our own presence messages — we manage our own status locally.
    if (msg.key === this.userProfile.key) return;

    // Skip stale offline presence (retained LWT from old sessions)
    // Only add offline participants if they were seen recently (5 min)
    if (msg.status === 'offline' && msg.ts) {
      const age = Date.now() - new Date(msg.ts).getTime();
      if (age > 5 * 60 * 1000) return; // Older than 5 min, skip
    }

    // Skip if key looks like a random old session key and status is offline
    if (msg.status === 'offline') return; // Don't track offline strangers at all

    this.participants[msg.key] = {
      key: msg.key,
      name: msg.name,
      type: msg.type,
      status: msg.status,
      ts: msg.ts || new Date().toISOString()
    };
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
      this.channels.push({
        id: channelId,
        topic: msg.topic || '',
        starred: false,
        unread: 0
      });
    } else if (msg.topic) {
      existing.topic = msg.topic;
    }
  }

  #handleParticipantRegistry(msg) {
    if (msg.key) {
      this.participants[msg.key] = {
        ...this.participants[msg.key],
        key: msg.key,
        name: msg.name,
        type: msg.type,
        status: msg.status || this.participants[msg.key]?.status || 'offline'
      };
    }
  }

  #handleRemoteReaction(channel, msg) {
    // Ignore our own broadcasts (we already applied locally)
    if (msg.sender?.key === this.userProfile.key) return;

    const target = this.messages.find(m => m.id === msg.message_id);
    if (!target) return;

    if (!target.reactions) target.reactions = [];

    if (msg.action === 'add') {
      const existing = target.reactions.find(r => r.emoji === msg.emoji);
      if (existing) {
        existing.count++;
      } else {
        target.reactions.push({ emoji: msg.emoji, count: 1, active: false });
      }
    } else if (msg.action === 'remove') {
      const existing = target.reactions.find(r => r.emoji === msg.emoji);
      if (existing) {
        existing.count--;
        if (existing.count <= 0) {
          target.reactions = target.reactions.filter(r => r.emoji !== msg.emoji);
        }
      }
    }

    // Trigger reactivity
    this.messages = [...this.messages];
  }

  #handleRemotePin(channel, msg) {
    if (msg.sender?.key === this.userProfile.key) return;

    if (msg.action === 'pin') {
      // Only add if not already pinned
      if (!this.pinnedMessages.find(m => m.id === msg.message_id)) {
        const target = this.messages.find(m => m.id === msg.message_id);
        if (target) {
          this.pinnedMessages.push({ ...target, channel });
        }
      }
    } else if (msg.action === 'unpin') {
      const idx = this.pinnedMessages.findIndex(m => m.id === msg.message_id);
      if (idx >= 0) {
        this.pinnedMessages.splice(idx, 1);
      }
    }
  }

  #handleRemoteDeletion(channel, msg) {
    if (msg.sender?.key === this.userProfile.key) return;

    this.messages = this.messages.filter(m => m.id !== msg.message_id);
    // Also remove from pinned if it was pinned
    const pinIdx = this.pinnedMessages.findIndex(m => m.id === msg.message_id);
    if (pinIdx >= 0) {
      this.pinnedMessages.splice(pinIdx, 1);
    }
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

    setTimeout(() => {
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
    const topic = TOPIC_PREFIX + '/conv/' + this.activeChannel + '/presence/' + this.userProfile.key;
    this.#client.publish(topic, JSON.stringify({
      key: this.userProfile.key,
      name: this.userProfile.name,
      type: this.userProfile.type,
      status,
      ts: new Date().toISOString()
    }), { qos: 1, retain: true });
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
