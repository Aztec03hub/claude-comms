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

  /**
   * Connect to the MQTT broker.
   */
  connect() {
    // Generate a client key if not set
    if (!this.userProfile.key) {
      this.userProfile.key = generateKey();
    }

    const clientId = 'claude-comms-web-' + generateKey();

    this.#client = mqtt.connect(BROKER_URL, {
      clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      will: {
        topic: TOPIC_PREFIX + '/conv/' + this.activeChannel + '/presence/' + this.userProfile.key,
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
      this.connectionError = err.message;
    });

    this.#client.on('close', () => {
      this.connected = false;
    });

    this.#client.on('reconnect', () => {
      this.connectionError = 'Reconnecting...';
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
   * Disconnect from the broker.
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
   * @param {string} body
   * @param {string|null} replyTo
   */
  sendMessage(body, replyTo = null) {
    if (!body.trim() || !this.#client) return;

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
    this.#client.publish(topic, JSON.stringify(msg), { qos: 1 });

    // Stop typing indicator
    this.#publishTyping(false);
  }

  /**
   * Switch to a different channel.
   * @param {string} channelId
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
   * Create a new channel / conversation.
   * @param {string} id
   * @param {string} topic
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
   * Toggle starred status on a channel.
   * @param {string} channelId
   */
  toggleStar(channelId) {
    const ch = this.channels.find(c => c.id === channelId);
    if (ch) ch.starred = !ch.starred;
  }

  /**
   * Notify broker that user is typing.
   */
  notifyTyping() {
    if (this.#myTypingTimer) clearTimeout(this.#myTypingTimer);
    this.#publishTyping(true);
    this.#myTypingTimer = setTimeout(() => {
      this.#publishTyping(false);
    }, 3000);
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
   * Pin or unpin a message.
   * @param {object} message
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
    const parts = topic.split('/');

    // claude-comms/conv/{channel}/messages
    if (parts[2] === 'conv' || parts[1] === 'conv') {
      const topicParts = topic.replace(TOPIC_PREFIX + '/', '').split('/');

      if (topicParts[0] === 'conv' && topicParts[2] === 'messages') {
        this.#handleChatMessage(topicParts[1], msg);
      } else if (topicParts[0] === 'conv' && topicParts[2] === 'presence') {
        this.#handlePresence(msg);
      } else if (topicParts[0] === 'conv' && topicParts[2] === 'typing') {
        this.#handleTyping(msg);
      } else if (topicParts[0] === 'conv' && topicParts[2] === 'meta') {
        this.#handleMeta(topicParts[1], msg);
      } else if (topicParts[0] === 'system' && topicParts[1] === 'participants') {
        this.#handleParticipantRegistry(msg);
      }
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

  #handleTyping(msg) {
    this.typingUsers[msg.key] = {
      typing: msg.typing,
      ts: msg.ts,
      channel: this.activeChannel
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
