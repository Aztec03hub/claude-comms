import mqtt from 'mqtt';
import { generateUUID, generateKey } from './utils.js';

const BROKER_URL = 'ws://localhost:9001/mqtt';
const TOPIC_PREFIX = 'claude-comms';
const TYPING_TTL_MS = 5000;

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
      const stored = typeof localStorage !== 'undefined'
        ? localStorage.getItem('claude-comms-user-key')
        : null;
      if (stored) {
        this.userProfile.key = stored;
      } else {
        this.userProfile.key = generateKey();
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('claude-comms-user-key', this.userProfile.key);
        }
      }
    }

    // Also persist user name
    if (typeof localStorage !== 'undefined') {
      const storedName = localStorage.getItem('claude-comms-user-name');
      if (storedName) this.userProfile.name = storedName;
    }

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
      this.#subscribeAll();
      this.#publishPresence('online');
    });

    this.#client.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
        this.connectionError = 'Broker unavailable — is amqtt running on ' + BROKER_URL + '?';
      } else if (err.message?.includes('WebSocket')) {
        this.connectionError = 'WebSocket connection failed — check broker WebSocket listener.';
      } else {
        this.connectionError = 'MQTT error: ' + (err.message || String(err));
      }
    });

    this.#client.on('close', () => {
      this.connected = false;
    });

    this.#client.on('offline', () => {
      this.connected = false;
      if (!this.connectionError) {
        this.connectionError = 'Connection lost — waiting to reconnect...';
      }
    });

    this.#client.on('reconnect', () => {
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
   * Delete a message by ID.
   * Replaces the messages array (immutable update) to trigger Svelte 5 reactivity.
   * @param {string} messageId - The ID of the message to remove.
   */
  deleteMessage(messageId) {
    this.messages = this.messages.filter(m => m.id !== messageId);
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

    // Trigger reactivity by reassigning
    this.messages = [...this.messages];
  }

  /**
   * Pin or unpin a message in its channel.
   * Pinned messages appear in the pinned-messages panel.
   * @param {object} message - The message object to pin/unpin.
   */
  togglePin(message) {
    const idx = this.pinnedMessages.findIndex(m => m.id === message.id);
    if (idx >= 0) {
      this.pinnedMessages.splice(idx, 1);
    } else {
      this.pinnedMessages.push({ ...message, channel: message.conv || this.activeChannel });
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
    this.#client.subscribe(TOPIC_PREFIX + '/system/participants/+', { qos: 1 });
  }

  #handleMessage(topic, msg) {
    if (!topic.startsWith(TOPIC_PREFIX + '/')) return;
    const topicParts = topic.slice(TOPIC_PREFIX.length + 1).split('/');

    if (topicParts[0] === 'conv' && topicParts[2] === 'messages') {
      this.#handleChatMessage(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'presence') {
      this.#handlePresence(msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'typing') {
      this.#handleTyping(topicParts[1], msg);
    } else if (topicParts[0] === 'conv' && topicParts[2] === 'meta') {
      this.#handleMeta(topicParts[1], msg);
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

    // Update unread count if not active channel
    if (channel !== this.activeChannel) {
      const ch = this.channels.find(c => c.id === channel);
      if (ch) ch.unread++;
    }
  }

  #handlePresence(msg) {
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
