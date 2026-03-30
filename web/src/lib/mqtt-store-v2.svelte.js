/**
 * mqtt-store-v2.svelte.js — Module-level runes store (NUCLEAR OPTION)
 *
 * Svelte 5's $state/$derived in class fields has a fundamental issue with
 * async mutation tracking from MQTT callbacks. Two prior attempts using
 * $derived.by(), getters, and setTimeout(0) all failed — messages end up
 * in the array but $derived never recalculates.
 *
 * This version uses MODULE-LEVEL runes (not class fields) which is the
 * pattern every official Svelte 5 example uses. The reactive state lives
 * at the module scope, and we export a getStore() function that returns
 * an object with getters so components see reactive values.
 */
import mqtt from 'mqtt';
import { generateUUID, generateKey } from './utils.js';

const BROKER_URL = 'ws://localhost:9001/mqtt';
const MCP_API_URL = 'http://localhost:9920';
const TOPIC_PREFIX = 'claude-comms';
const TYPING_TTL_MS = 5000;
const BASE_RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;
const BACKOFF_AFTER_ATTEMPTS = 5;

// ── Safe localStorage wrapper ──
const safeStorage = {
  getItem(key) {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch { return null; }
  },
  setItem(key, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch { /* quota exceeded / private browsing */ }
  }
};

// ═══════════════════════════════════════════════════════════
// MODULE-LEVEL $state — NOT in a class
// ═══════════════════════════════════════════════════════════
let messages = $state([]);
let channels = $state([
  { id: 'general', topic: 'Main discussion channel for the team', starred: false, unread: 0 },
  { id: 'project-alpha', topic: 'Project Alpha development', starred: true, unread: 0 },
  { id: 'lora-training', topic: 'LoRA training runs and results', starred: true, unread: 0 },
  { id: 'random', topic: 'Off-topic and fun', starred: false, unread: 0 },
]);
let activeChannel = $state('general');
let participants = $state({});
let connected = $state(false);
let connectionError = $state(null);
let typingUsers = $state({});
let pinnedMessages = $state([]);
let inAppToasts = $state(true);
let userProfile = $state({
  key: '',
  name: 'Phil',
  type: 'human'
});

// ═══════════════════════════════════════════════════════════
// MODULE-LEVEL $derived
// ═══════════════════════════════════════════════════════════
let activeMessages = $derived(messages.filter(m => m.channel === activeChannel));

let activeChannelMeta = $derived(channels.find(c => c.id === activeChannel));

let starredChannels = $derived(channels.filter(c => c.starred));

let onlineParticipants = $derived(Object.values(participants).filter(p => p.status === 'online'));

let offlineParticipants = $derived(Object.values(participants).filter(p => p.status !== 'online'));

let activeTypingUsers = $derived(
  Object.entries(typingUsers)
    .filter(([key, info]) =>
      info.channel === activeChannel
      && info.typing
      && key !== userProfile.key
      && (Date.now() - new Date(info.ts).getTime()) < TYPING_TTL_MS
    )
    .map(([key, info]) => ({
      key,
      name: participants[key]?.name || key
    }))
);

let activePinnedMessages = $derived(pinnedMessages.filter(m => m.channel === activeChannel));

let onlineCount = $derived(Object.values(participants).filter(p => p.status === 'online').length);

let messageCount = $derived(messages.length);

// ═══════════════════════════════════════════════════════════
// Private (non-exported) state
// ═══════════════════════════════════════════════════════════
/** @type {mqtt.MqttClient | null} */
let client = null;
let seenIds = new Set();
let typingTimers = {};
let myTypingTimer = null;
let seenMessageIds = new Set();
let failureCount = 0;
let backoffActive = false;
let participantPollTimer = null;

// ═══════════════════════════════════════════════════════════
// Private helper functions
// ═══════════════════════════════════════════════════════════

async function fetchHistory(channel) {
  try {
    const res = await fetch(`${MCP_API_URL}/api/messages/${encodeURIComponent(channel)}?count=50`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.messages)) return;

    const newMessages = [];
    for (const msg of data.messages) {
      if (!msg.id || seenIds.has(msg.id)) continue;
      seenIds.add(msg.id);
      newMessages.push({ ...msg, channel });
    }
    if (newMessages.length > 0) {
      messages = [...messages, ...newMessages]
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    }
  } catch {
    // History fetch failed — not critical
  }
}

async function fetchParticipants(channel) {
  try {
    const res = await fetch(`${MCP_API_URL}/api/participants/${encodeURIComponent(channel)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.participants)) return;

    let updated = { ...participants };
    for (const p of data.participants) {
      const clientType = p.client || 'mcp';
      const compositeKey = p.key + '-' + clientType;
      if (p.key === userProfile.key && clientType === 'web') continue;
      updated[compositeKey] = {
        ...updated[compositeKey],
        key: p.key,
        name: p.name,
        type: p.type,
        client: clientType,
        status: updated[compositeKey]?.status || 'online',
      };
    }
    participants = updated;
  } catch {
    // Participant fetch failed — not critical
  }
}

function startParticipantPolling() {
  stopParticipantPolling();
  fetchParticipants(activeChannel);
  participantPollTimer = setInterval(() => {
    fetchParticipants(activeChannel);
  }, 30000);
}

function stopParticipantPolling() {
  if (participantPollTimer) {
    clearInterval(participantPollTimer);
    participantPollTimer = null;
  }
}

function subscribeAll() {
  if (!client) return;
  client.subscribe(TOPIC_PREFIX + '/conv/+/messages', { qos: 1 });
  client.subscribe(TOPIC_PREFIX + '/conv/+/presence/+', { qos: 1 });
  client.subscribe(TOPIC_PREFIX + '/conv/+/typing/+', { qos: 0 });
  client.subscribe(TOPIC_PREFIX + '/conv/+/meta', { qos: 1 });
  client.subscribe(TOPIC_PREFIX + '/conv/+/reactions', { qos: 1 });
  client.subscribe(TOPIC_PREFIX + '/conv/+/pins', { qos: 1 });
  client.subscribe(TOPIC_PREFIX + '/conv/+/deletions', { qos: 1 });
  client.subscribe(TOPIC_PREFIX + '/system/participants/+', { qos: 1 });
}

function handleMessage(topic, msg) {
  if (!topic.startsWith(TOPIC_PREFIX + '/')) return;
  const topicParts = topic.slice(TOPIC_PREFIX.length + 1).split('/');

  if (topicParts[0] === 'conv' && topicParts[2] === 'messages') {
    handleChatMessage(topicParts[1], msg);
  } else if (topicParts[0] === 'conv' && topicParts[2] === 'presence') {
    handlePresence(msg);
  } else if (topicParts[0] === 'conv' && topicParts[2] === 'typing') {
    handleTyping(topicParts[1], msg);
  } else if (topicParts[0] === 'conv' && topicParts[2] === 'meta') {
    handleMeta(topicParts[1], msg);
  } else if (topicParts[0] === 'conv' && topicParts[2] === 'reactions') {
    handleRemoteReaction(topicParts[1], msg);
  } else if (topicParts[0] === 'conv' && topicParts[2] === 'pins') {
    handleRemotePin(topicParts[1], msg);
  } else if (topicParts[0] === 'conv' && topicParts[2] === 'deletions') {
    handleRemoteDeletion(topicParts[1], msg);
  } else if (topicParts[0] === 'system' && topicParts[1] === 'participants') {
    handleParticipantRegistry(msg);
  }
}

function handleChatMessage(channel, msg) {
  if (seenIds.has(msg.id)) return;
  seenIds.add(msg.id);

  // Bound the seen set
  if (seenIds.size > 10000) {
    const iter = seenIds.values();
    for (let i = 0; i < 1000; i++) {
      seenIds.delete(iter.next().value);
    }
  }

  const message = { ...msg, channel: channel || msg.conv };

  // IMMUTABLE reassignment — this is the key to module-level $state reactivity
  messages = [...messages, message];

  console.log('[V2 handleChatMessage] channel:', channel, 'activeChannel:', activeChannel, 'match:', channel === activeChannel, 'messages.length:', messages.length, 'activeMessages.length:', activeMessages.length);

  // Update unread count if not active channel
  if (channel !== activeChannel) {
    const ch = channels.find(c => c.id === channel);
    if (ch) {
      // Immutable reassignment for channels too
      channels = channels.map(c =>
        c.id === channel ? { ...c, unread: c.unread + 1 } : c
      );
    }
  }
}

function handlePresence(msg) {
  const clientType = msg.client || 'unknown';
  const participantKey = msg.key + '-' + clientType;

  if (msg.key === userProfile.key && clientType === 'web') return;

  if (msg.status === 'offline' && msg.ts) {
    const age = Date.now() - new Date(msg.ts).getTime();
    if (age > 5 * 60 * 1000) return;
  }
  if (msg.status === 'offline') return;

  // Immutable reassignment
  participants = {
    ...participants,
    [participantKey]: {
      key: msg.key,
      name: msg.name,
      type: msg.type,
      status: msg.status,
      client: clientType,
      ts: msg.ts || new Date().toISOString()
    }
  };
}

function handleTyping(channel, msg) {
  typingUsers = {
    ...typingUsers,
    [msg.key]: { typing: msg.typing, ts: msg.ts, channel }
  };

  if (msg.typing) {
    if (typingTimers[msg.key]) clearTimeout(typingTimers[msg.key]);
    typingTimers[msg.key] = setTimeout(() => {
      if (typingUsers[msg.key]) {
        typingUsers = {
          ...typingUsers,
          [msg.key]: { ...typingUsers[msg.key], typing: false }
        };
      }
    }, TYPING_TTL_MS);
  }
}

function handleMeta(channelId, msg) {
  const existing = channels.find(c => c.id === channelId);
  if (!existing) {
    channels = [...channels, { id: channelId, topic: msg.topic || '', starred: false, unread: 0 }];
  } else if (msg.topic) {
    channels = channels.map(c =>
      c.id === channelId ? { ...c, topic: msg.topic } : c
    );
  }
}

function handleParticipantRegistry(msg) {
  if (msg.key) {
    const clientType = msg.client || 'unknown';
    const participantKey = msg.key + '-' + clientType;
    participants = {
      ...participants,
      [participantKey]: {
        ...participants[participantKey],
        key: msg.key,
        name: msg.name,
        type: msg.type,
        client: clientType,
        status: msg.status || participants[participantKey]?.status || 'offline'
      }
    };
  }
}

function handleRemoteReaction(channel, msg) {
  if (msg.sender?.key === userProfile.key) return;
  const target = messages.find(m => m.id === msg.message_id);
  if (!target) return;

  let reactions = target.reactions ? [...target.reactions] : [];
  if (msg.action === 'add') {
    const existing = reactions.find(r => r.emoji === msg.emoji);
    if (existing) {
      reactions = reactions.map(r => r.emoji === msg.emoji ? { ...r, count: r.count + 1 } : r);
    } else {
      reactions = [...reactions, { emoji: msg.emoji, count: 1, active: false }];
    }
  } else if (msg.action === 'remove') {
    const existing = reactions.find(r => r.emoji === msg.emoji);
    if (existing) {
      if (existing.count <= 1) {
        reactions = reactions.filter(r => r.emoji !== msg.emoji);
      } else {
        reactions = reactions.map(r => r.emoji === msg.emoji ? { ...r, count: r.count - 1 } : r);
      }
    }
  }

  messages = messages.map(m => m.id === msg.message_id ? { ...m, reactions } : m);
}

function handleRemotePin(channel, msg) {
  if (msg.sender?.key === userProfile.key) return;
  if (msg.action === 'pin') {
    if (!pinnedMessages.find(m => m.id === msg.message_id)) {
      const target = messages.find(m => m.id === msg.message_id);
      if (target) {
        pinnedMessages = [...pinnedMessages, { ...target, channel }];
      }
    }
  } else if (msg.action === 'unpin') {
    pinnedMessages = pinnedMessages.filter(m => m.id !== msg.message_id);
  }
}

function handleRemoteDeletion(channel, msg) {
  if (msg.sender?.key === userProfile.key) return;
  messages = messages.filter(m => m.id !== msg.message_id);
  pinnedMessages = pinnedMessages.filter(m => m.id !== msg.message_id);
}

function publishPresence(status) {
  if (!client) return;
  const topic = TOPIC_PREFIX + '/conv/' + activeChannel + '/presence/' + userProfile.key;
  client.publish(topic, JSON.stringify({
    key: userProfile.key,
    name: userProfile.name,
    type: userProfile.type,
    status,
    client: 'web',
    ts: new Date().toISOString()
  }), { qos: 1, retain: true });
}

function publishTyping(typing) {
  if (!client) return;
  const topic = TOPIC_PREFIX + '/conv/' + activeChannel + '/typing/' + userProfile.key;
  client.publish(topic, JSON.stringify({
    key: userProfile.key,
    typing,
    ts: new Date().toISOString()
  }), { qos: 0 });
}

function activateBackoff() {
  backoffActive = true;
  if (client) {
    client.options.reconnectPeriod = 0;
  }
  const attempt = failureCount - BACKOFF_AFTER_ATTEMPTS;
  const delayMs = Math.min(BASE_RECONNECT_MS * Math.pow(2, attempt), MAX_RECONNECT_MS);
  const delaySec = Math.round(delayMs / 1000);

  connectionError = 'Broker unreachable after ' + failureCount +
    ' attempts — retrying in ' + delaySec + 's. App works in local-only mode.';

  setTimeout(() => {
    backoffActive = false;
    if (client) {
      client.options.reconnectPeriod = BASE_RECONNECT_MS;
      connectionError = 'Reconnecting to broker...';
      client.reconnect();
    }
  }, delayMs);
}

// ═══════════════════════════════════════════════════════════
// Exported functions (replace class methods)
// ═══════════════════════════════════════════════════════════

export async function connect() {
  // Fetch identity from daemon
  try {
    const res = await fetch(MCP_API_URL + '/api/identity');
    if (res.ok) {
      const identity = await res.json();
      userProfile = { ...userProfile, key: identity.key, name: identity.name, type: identity.type };
      safeStorage.setItem('claude-comms-user-key', identity.key);
      safeStorage.setItem('claude-comms-user-name', identity.name);
    }
  } catch {
    // Daemon not running — fall back to localStorage
  }

  // localStorage fallback
  if (!userProfile.key) {
    const stored = safeStorage.getItem('claude-comms-user-key');
    if (stored) {
      userProfile = { ...userProfile, key: stored };
    } else {
      const newKey = generateKey();
      userProfile = { ...userProfile, key: newKey };
      safeStorage.setItem('claude-comms-user-key', newKey);
    }
  }

  if (!userProfile.name || userProfile.name === 'Phil') {
    const storedName = safeStorage.getItem('claude-comms-user-name');
    if (storedName) userProfile = { ...userProfile, name: storedName };
  }

  const clientId = 'claude-comms-web-' + userProfile.key + '-' + Math.random().toString(16).slice(2, 6);

  client = mqtt.connect(BROKER_URL, {
    clientId,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 3000,
    will: {
      topic: TOPIC_PREFIX + '/system/participants/' + userProfile.key + '-web',
      payload: JSON.stringify({
        key: userProfile.key,
        name: userProfile.name,
        type: userProfile.type,
        status: 'offline',
        client: 'web',
      }),
      qos: 1,
      retain: true
    }
  });

  client.on('connect', () => {
    connected = true;
    connectionError = null;
    failureCount = 0;
    backoffActive = false;
    subscribeAll();
    publishPresence('online');
    // Add ourselves to participants
    participants = {
      ...participants,
      [userProfile.key + '-web']: {
        key: userProfile.key,
        name: userProfile.name,
        type: userProfile.type,
        status: 'online',
        client: 'web',
      }
    };
    fetchHistory(activeChannel);
    startParticipantPolling();
  });

  client.on('error', (err) => {
    failureCount++;
    if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
      connectionError = 'Broker unavailable — is "claude-comms start" running? (expected at ' + BROKER_URL + ')';
    } else if (err.message?.includes('WebSocket')) {
      connectionError = 'WebSocket connection failed — is "claude-comms start" running? Check broker WebSocket listener on ' + BROKER_URL + '.';
    } else {
      connectionError = 'MQTT error: ' + (err.message || String(err));
    }

    if (failureCount >= BACKOFF_AFTER_ATTEMPTS && !backoffActive) {
      activateBackoff();
    }
  });

  client.on('close', () => {
    connected = false;
  });

  client.on('offline', () => {
    connected = false;
    failureCount++;
    if (!connectionError) {
      connectionError = 'Connection lost — waiting to reconnect...';
    }
    if (failureCount >= BACKOFF_AFTER_ATTEMPTS && !backoffActive) {
      activateBackoff();
    }
  });

  client.on('reconnect', () => {
    if (backoffActive) return;
    connectionError = 'Reconnecting to broker...';
  });

  client.on('message', (topic, payload) => {
    try {
      const msg = JSON.parse(payload.toString());
      handleMessage(topic, msg);
    } catch (e) {
      console.error('Failed to parse MQTT message:', e);
    }
  });
}

export function disconnect() {
  stopParticipantPolling();
  if (client) {
    publishPresence('offline');
    client.end();
    client = null;
    connected = false;
  }
}

export function sendMessage(body, replyTo = null) {
  if (!body.trim()) return;

  const msg = {
    id: generateUUID(),
    ts: new Date().toISOString(),
    sender: {
      key: userProfile.key,
      name: userProfile.name,
      type: userProfile.type
    },
    recipients: null,
    body: body.trim(),
    reply_to: replyTo,
    conv: activeChannel
  };

  const topic = TOPIC_PREFIX + '/conv/' + activeChannel + '/messages';

  // Local echo
  handleChatMessage(activeChannel, msg);

  if (client && connected) {
    client.publish(topic, JSON.stringify(msg), { qos: 1 });
  }

  publishTyping(false);
}

export function switchChannel(channelId) {
  if (channelId === activeChannel) return;

  // Clear unread for target channel
  channels = channels.map(c =>
    c.id === channelId ? { ...c, unread: 0 } : c
  );

  activeChannel = channelId;

  if (client && connected) {
    subscribeAll();
  }

  fetchHistory(channelId);
  fetchParticipants(channelId);
}

export function createChannel(id, topic = '') {
  if (channels.find(c => c.id === id)) return;

  channels = [...channels, { id, topic, starred: false, unread: 0 }];

  if (client) {
    const metaTopic = TOPIC_PREFIX + '/conv/' + id + '/meta';
    client.publish(metaTopic, JSON.stringify({
      conv_id: id,
      created_by: userProfile.key,
      created_at: new Date().toISOString(),
      topic
    }), { qos: 1, retain: true });
  }

  switchChannel(id);
}

export function toggleStar(channelId) {
  channels = channels.map(c =>
    c.id === channelId ? { ...c, starred: !c.starred } : c
  );
}

export function notifyTyping() {
  if (myTypingTimer) clearTimeout(myTypingTimer);
  publishTyping(true);
  myTypingTimer = setTimeout(() => {
    publishTyping(false);
  }, 3000);
}

export function markUnread(message) {
  const chId = message.channel || message.conv || activeChannel;
  channels = channels.map(c =>
    c.id === chId ? { ...c, unreadFrom: message.id, unread: Math.max(c.unread, 1) } : c
  );
}

export function markSeen(messageId) {
  if (seenMessageIds.has(messageId)) return;
  seenMessageIds.add(messageId);
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return;
  if (msg.sender?.key === userProfile.key) return;
  messages = messages.map(m =>
    m.id === messageId ? { ...m, read_by: (m.read_by || 0) + 1 } : m
  );
}

export function deleteMessage(messageId) {
  const msg = messages.find(m => m.id === messageId);
  const channel = msg?.channel || msg?.conv || activeChannel;
  messages = messages.filter(m => m.id !== messageId);

  if (client && connected) {
    const topic = TOPIC_PREFIX + '/conv/' + channel + '/deletions';
    client.publish(topic, JSON.stringify({
      message_id: messageId,
      sender: { key: userProfile.key, name: userProfile.name, type: userProfile.type }
    }), { qos: 1 });
  }
}

export function muteChannel(channelId) {
  channels = channels.map(c =>
    c.id === channelId ? { ...c, muted: !c.muted } : c
  );
}

export function forwardMessage(message, targetChannelId) {
  const msg = {
    id: generateUUID(),
    ts: new Date().toISOString(),
    sender: { key: userProfile.key, name: userProfile.name, type: userProfile.type },
    recipients: null,
    body: message.body,
    reply_to: null,
    conv: targetChannelId,
    forwarded_from: message.id
  };

  const topic = TOPIC_PREFIX + '/conv/' + targetChannelId + '/messages';
  handleChatMessage(targetChannelId, msg);

  if (client && connected) {
    client.publish(topic, JSON.stringify(msg), { qos: 1 });
  }
}

export function searchMessages(query) {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  return messages.filter(m => m.body.toLowerCase().includes(q));
}

export function addReaction(messageId, emoji) {
  const msg = messages.find(m => m.id === messageId);
  if (!msg) return;

  let reactions = msg.reactions ? [...msg.reactions] : [];
  const existing = reactions.find(r => r.emoji === emoji);
  let action;

  if (existing) {
    if (existing.active) {
      // Remove our reaction
      if (existing.count <= 1) {
        reactions = reactions.filter(r => r.emoji !== emoji);
      } else {
        reactions = reactions.map(r =>
          r.emoji === emoji ? { ...r, count: r.count - 1, active: false } : r
        );
      }
      action = 'remove';
    } else {
      reactions = reactions.map(r =>
        r.emoji === emoji ? { ...r, count: r.count + 1, active: true } : r
      );
      action = 'add';
    }
  } else {
    reactions = [...reactions, { emoji, count: 1, active: true }];
    action = 'add';
  }

  messages = messages.map(m => m.id === messageId ? { ...m, reactions } : m);

  if (client && connected) {
    const channel = msg.channel || msg.conv || activeChannel;
    const topic = TOPIC_PREFIX + '/conv/' + channel + '/reactions';
    client.publish(topic, JSON.stringify({
      message_id: messageId,
      emoji,
      action,
      sender: { key: userProfile.key, name: userProfile.name, type: userProfile.type }
    }), { qos: 1 });
  }
}

export function togglePin(message) {
  const idx = pinnedMessages.findIndex(m => m.id === message.id);
  const channel = message.channel || message.conv || activeChannel;
  let action;

  if (idx >= 0) {
    pinnedMessages = pinnedMessages.filter(m => m.id !== message.id);
    action = 'unpin';
  } else {
    pinnedMessages = [...pinnedMessages, { ...message, channel }];
    action = 'pin';
  }

  if (client && connected) {
    const topic = TOPIC_PREFIX + '/conv/' + channel + '/pins';
    client.publish(topic, JSON.stringify({
      message_id: message.id,
      action,
      sender: { key: userProfile.key, name: userProfile.name, type: userProfile.type }
    }), { qos: 1 });
  }
}

export function getChannelById(id) {
  return channels.find(c => c.id === id);
}

export function getParticipantByKey(key) {
  return participants[key];
}

// ═══════════════════════════════════════════════════════════
// getStore() — returns an object with GETTERS for reactive reads
// ═══════════════════════════════════════════════════════════
export function getStore() {
  return {
    // Reactive state via getters — each read triggers Svelte 5 tracking
    get messages() { return messages; },
    get channels() { return channels; },
    get activeChannel() { return activeChannel; },
    get participants() { return participants; },
    get connected() { return connected; },
    get connectionError() { return connectionError; },
    get typingUsers() { return typingUsers; },
    get pinnedMessages() { return pinnedMessages; },
    get inAppToasts() { return inAppToasts; },
    set inAppToasts(v) { inAppToasts = v; },
    get userProfile() { return userProfile; },
    set userProfile(v) { userProfile = v; },

    // Derived state via getters
    get activeMessages() { return activeMessages; },
    get activeChannelMeta() { return activeChannelMeta; },
    get starredChannels() { return starredChannels; },
    get onlineParticipants() { return onlineParticipants; },
    get offlineParticipants() { return offlineParticipants; },
    get activeTypingUsers() { return activeTypingUsers; },
    get activePinnedMessages() { return activePinnedMessages; },
    get onlineCount() { return onlineCount; },
    get messageCount() { return messageCount; },

    // Methods
    connect,
    disconnect,
    sendMessage,
    switchChannel,
    createChannel,
    toggleStar,
    notifyTyping,
    markUnread,
    markSeen,
    deleteMessage,
    muteChannel,
    forwardMessage,
    searchMessages,
    addReaction,
    togglePin,
    getChannelById,
    getParticipantByKey,
  };
}
