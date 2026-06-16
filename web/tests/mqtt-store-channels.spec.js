// v0.4.0 Step 2.6 — channel shape + lifecycle methods + 15s undo.
//
// Covers the surface added in `mqtt-store.svelte.js` for the headline
// v0.4.0 feature set: full ChannelRow shape, four $derived projections
// for the 3-section sidebar (starred / active / available / archived),
// eight lifecycle methods (joinChannel, leaveChannel, archiveChannel,
// deleteChannel, closeChannel, setTopic, setMute, setStar), and the
// 15-second undo machinery used by destructive flows.
//
// The MCP transport (`mcpCall`) and the bootstrap fetch (`apiGet`) are
// both mocked so these specs run without a daemon. Fake timers drive
// the 15s undo window so vitest doesn't literally sleep.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted mocks for the api module. apiGet drives bootstrap; mcpCall
// drives the lifecycle methods.
const apiGetMock = vi.fn();
const mcpCallMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: (...args) => apiGetMock(...args),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
  mcpCall: (...args) => mcpCallMock(...args),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

// Re-usable wire-row builder. Defaults match the Step 2.1 contract.
function row(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: '',
    member: false,
    memberCount: 0,
    lastActivity: null,
    mode: 'public',
    visibility: 'listed',
    createdAt: null,
    createdBy: null,
    myUnread: 0,
    myStarred: false,
    myMuted: false,
    ...overrides,
  };
}

async function bootstrapWith(store, rows) {
  apiGetMock.mockResolvedValueOnce(rows);
  await store._bootstrapChannelsForTest();
}

beforeEach(() => {
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  // Reset localStorage between specs so star/mute state from one test
  // can't leak into the next.
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    /* jsdom may not provide localStorage in some environments */
  }
});

// ── Shape: ChannelRow contract ────────────────────────────────────────────

describe('MqttChatStore — Step 2.6 ChannelRow shape', () => {
  it('channelsById is the source-of-truth map; channels is the derived array view', async () => {
    const store = new MqttChatStore();
    expect(store.channelsById).toEqual({});
    expect(store.channels).toEqual([]);

    await bootstrapWith(store, [row({ id: 'a' }), row({ id: 'b' })]);

    // Map has both ids.
    expect(Object.keys(store.channelsById).sort()).toEqual(['a', 'b']);
    // Derived array preserves insertion order from the payload.
    expect(store.channels.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('every row carries the full ChannelRow contract with no undefined leaks', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'general', member: true })]);

    const ch = store.channelsById.general;
    // Every field per Design Spec §13.4 (+ v0.4.0 archive additions +
    // local-only muteLevel).
    const requiredKeys = [
      'id', 'name', 'topic',
      'member', 'memberCount', 'lastActivity',
      'mode', 'visibility',
      'starred', 'muted', 'muteLevel',
      'unread', 'unreadHasMention', 'unreadFrom',
      'createdAt', 'createdBy',
      'archived', 'archived_at', 'archived_by',
    ];
    for (const k of requiredKeys) {
      expect(ch).toHaveProperty(k);
      expect(ch[k]).not.toBeUndefined();
    }
  });

  it('muteLevel defaults track muted boolean from the payload', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'quiet', myMuted: true }),
      row({ id: 'loud', myMuted: false }),
    ]);
    expect(store.channelsById.quiet.muteLevel).toBe('all');
    expect(store.channelsById.loud.muteLevel).toBe('off');
  });
});

// ── Projections: $derived sections ────────────────────────────────────────

describe('MqttChatStore — Step 2.6 $derived projections', () => {
  it('starredChannels = member && starred, alpha by name', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'zeta', name: 'zeta', member: true, myStarred: true }),
      row({ id: 'alpha', name: 'alpha', member: true, myStarred: true }),
      row({ id: 'gamma', name: 'gamma', member: false, myStarred: true }),
      row({ id: 'delta', name: 'delta', member: true, myStarred: false }),
    ]);
    expect(store.starredChannels.map((c) => c.id)).toEqual(['alpha', 'zeta']);
  });

  it('activeChannels = member && !starred && !archived, alpha by name', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'b', name: 'b', member: true }),
      row({ id: 'a', name: 'a', member: true }),
      row({ id: 'c', name: 'c', member: true, myStarred: true }),
      row({ id: 'd', name: 'd', member: true, archived: true }),
      row({ id: 'e', name: 'e', member: false }),
    ]);
    expect(store.activeChannels.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('availableChannels = !member && visibility listed && !archived, alpha by name', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'pub-z', name: 'pub-z', member: false, visibility: 'listed' }),
      row({ id: 'pub-a', name: 'pub-a', member: false, visibility: 'listed' }),
      row({ id: 'unlisted', name: 'unlisted', member: false, visibility: 'unlisted' }),
      row({ id: 'arch', name: 'arch', member: false, visibility: 'listed', archived: true }),
      row({ id: 'in', name: 'in', member: true }),
    ]);
    expect(store.availableChannels.map((c) => c.id)).toEqual(['pub-a', 'pub-z']);
  });

  it('archivedChannels = archived === true, alpha by name', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'old-z', name: 'old-z', archived: true }),
      row({ id: 'old-a', name: 'old-a', archived: true }),
      row({ id: 'live', name: 'live' }),
    ]);
    expect(store.archivedChannels.map((c) => c.id)).toEqual(['old-a', 'old-z']);
  });
});

// ── activeChannel default-reset ───────────────────────────────────────────

describe('MqttChatStore — Step 2.6 activeChannel post-bootstrap reset', () => {
  it('keeps a real activeChannel if it survives bootstrap', async () => {
    const store = new MqttChatStore();
    store.activeChannel = 'general';
    await bootstrapWith(store, [row({ id: 'general', member: true })]);
    expect(store.activeChannel).toBe('general');
  });

  it('falls back to first member channel (alpha) when default missing', async () => {
    const store = new MqttChatStore();
    expect(store.activeChannel).toBe('general'); // sentinel default
    await bootstrapWith(store, [
      row({ id: 'zulu', name: 'zulu', member: true }),
      row({ id: 'alpha', name: 'alpha', member: true }),
      row({ id: 'mike', name: 'mike', member: false }),
    ]);
    expect(store.activeChannel).toBe('alpha');
  });

  it('falls back to null when there are no member channels', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'browse-only', member: false }),
    ]);
    expect(store.activeChannel).toBeNull();
  });
});

// ── #handleSystemConversation conversation_created full row ───────────────

describe('MqttChatStore — Step 2.6 system event populates full ChannelRow', () => {
  it('conversation_created lands a row with all ChannelRow fields populated', () => {
    const store = new MqttChatStore();
    store._handleSystemEventForTest({
      type: 'conversation_created',
      name: 'new-chan',
      topic: 'tk',
      creator_key: 'phil-mcp',
      ts: '2026-05-12T15:00:00Z',
    });
    const ch = store.channelsById['new-chan'];
    expect(ch).toBeTruthy();
    // Sanity: all ChannelRow keys present, no undefined leaks.
    for (const k of ['id', 'name', 'topic', 'member', 'memberCount', 'mode', 'visibility', 'starred', 'muted', 'unread', 'unreadHasMention', 'archived', 'archived_at', 'archived_by']) {
      expect(ch).toHaveProperty(k);
      expect(ch[k]).not.toBeUndefined();
    }
    expect(ch.topic).toBe('tk');
    expect(ch.createdBy).toBe('phil-mcp');
    expect(ch.member).toBe(false); // creator's own row only flips to true after join lands
  });
});

// ── joinChannel ───────────────────────────────────────────────────────────

describe('MqttChatStore — joinChannel', () => {
  it('happy path: flips member, bumps memberCount, calls comms_join', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'general', member: false, memberCount: 2 })]);
    store.userProfile.key = 'phil-key';
    store.userProfile.name = 'Phil';
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: { status: 'joined' } });

    const res = await store.joinChannel('general');

    expect(res.success).toBe(true);
    expect(mcpCallMock).toHaveBeenCalledWith('comms_join', {
      key: 'phil-key',
      conversation: 'general',
      name: 'Phil',
    });
    expect(store.channelsById.general.member).toBe(true);
    expect(store.channelsById.general.memberCount).toBe(3);
  });

  it('error path: reverts optimistic flip on MCP failure', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'general', member: false, memberCount: 2 })]);
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'broker offline' });

    const res = await store.joinChannel('general');

    expect(res.success).toBe(false);
    expect(res.error).toBe('broker offline');
    expect(store.channelsById.general.member).toBe(false);
    expect(store.channelsById.general.memberCount).toBe(2);
  });

  it('idempotent: no-op if already a member', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'general', member: true })]);
    const res = await store.joinChannel('general');
    expect(res.success).toBe(true);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });
});

// ── leaveChannel + 15s undo ───────────────────────────────────────────────

describe('MqttChatStore — leaveChannel (15s undo)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits after 15s: calls comms_leave, clears message buffer, auto-unstars', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true, myStarred: true })]);
    store.userProfile.key = 'phil-key';
    // Add a fake message in that channel
    store.messages = [
      { id: 'm1', channel: 'gen', ts: '2026-05-12T00:00:00Z' },
      { id: 'm2', channel: 'other', ts: '2026-05-12T00:00:01Z' },
    ];
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: { status: 'left' } });

    const { done } = store.leaveChannel('gen');
    // Optimistic: member=false + auto-unstar already applied.
    expect(store.channelsById.gen.member).toBe(false);
    expect(store.channelsById.gen.starred).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    const res = await done;

    expect(res.success).toBe(true);
    expect(res.cancelled).toBe(false);
    expect(mcpCallMock).toHaveBeenCalledWith('comms_leave', {
      key: 'phil-key',
      conversation: 'gen',
    });
    // Local buffer cleared for this channel only.
    expect(store.messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('cancel() within window: MCP never called, member stays true', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);

    const { done, cancel } = store.leaveChannel('gen');
    // Optimistic flip already happened.
    expect(store.channelsById.gen.member).toBe(false);

    // Caller decides to undo before the window elapses. We need the
    // commit fn (which would re-flip on rollback) NOT to run.
    await vi.advanceTimersByTimeAsync(5_000);
    const cancelResult = cancel();

    const res = await done;
    expect(cancelResult.tooLate).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('error path: MCP failure rolls back member and re-stars', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true, myStarred: true })]);
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'timeout' });

    const { done } = store.leaveChannel('gen');
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await done;

    expect(res.success).toBe(false);
    expect(res.error).toBe('timeout');
    expect(store.channelsById.gen.member).toBe(true);
    expect(store.channelsById.gen.starred).toBe(true);
  });

  it('cancel() after commit returns tooLate=true (no-op)', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);
    mcpCallMock.mockResolvedValueOnce({ success: true });

    const { done, cancel } = store.leaveChannel('gen');
    await vi.advanceTimersByTimeAsync(15_000);
    await done;

    const cancelResult = cancel();
    expect(cancelResult.tooLate).toBe(true);
  });
});

// ── archiveChannel + 15s undo ─────────────────────────────────────────────

describe('MqttChatStore — archiveChannel (15s undo)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: archive flips + member flips, MCP called with confirm=true', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);
    store.userProfile.key = 'phil-key';
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: { status: 'archived' } });

    const { done } = store.archiveChannel('gen');
    expect(store.channelsById.gen.archived).toBe(true);
    expect(store.channelsById.gen.member).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    const res = await done;

    expect(res.success).toBe(true);
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_archive', {
      key: 'phil-key',
      conversation: 'gen',
      confirm: true,
    });
    expect(store.archivedChannels.map((c) => c.id)).toEqual(['gen']);
  });

  it('cancel() reverts optimistic state via wrapper', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);

    const { done, cancel } = store.archiveChannel('gen');
    expect(store.channelsById.gen.archived).toBe(true);

    const cancelResult = cancel();
    const res = await done;

    expect(cancelResult.tooLate).toBe(false);
    expect(res.cancelled).toBe(true);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('error rollback: archive flag, archived_at, archived_by all revert', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'unauthorized' });

    const { done } = store.archiveChannel('gen');
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await done;

    expect(res.success).toBe(false);
    expect(res.error).toBe('unauthorized');
    expect(store.channelsById.gen.archived).toBe(false);
    expect(store.channelsById.gen.archived_at).toBeNull();
    expect(store.channelsById.gen.archived_by).toBeNull();
    expect(store.channelsById.gen.member).toBe(true);
  });

  it('closeChannel produces the same optimistic archive state as archiveChannel (Q1 lock)', () => {
    // Replace the spy-on-archiveChannel delegation check with an observable
    // state assertion: after closeChannel(), the channel must be optimistically
    // marked archived and removed from membership — the same invariant that
    // archiveChannel's own happy-path test above asserts. This checks the
    // end-state contract rather than the internal delegation mechanism.
    const store = new MqttChatStore();
    store.channelsById = { gen: { id: 'gen', member: true, archived: false } };
    // closeChannel returns { done, cancel } just like archiveChannel.
    const result = store.closeChannel('gen');
    // Optimistic state: channel is archived, membership revoked.
    expect(store.channelsById.gen.archived).toBe(true);
    expect(store.channelsById.gen.member).toBe(false);
    // Result shape mirrors archiveChannel: has done + cancel.
    expect(typeof result.done?.then).toBe('function');
    expect(typeof result.cancel).toBe('function');
  });
});

// ── deleteChannel (no undo) ───────────────────────────────────────────────

describe('MqttChatStore — deleteChannel', () => {
  it('happy path: row removed from map, MCP called with confirm=true', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);
    store.userProfile.key = 'phil-key';
    store.messages = [{ id: 'm1', channel: 'gen' }];
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: { deleted: true } });

    const res = await store.deleteChannel('gen');

    expect(res.success).toBe(true);
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_delete', {
      key: 'phil-key',
      conversation: 'gen',
      confirm: true,
    });
    expect(store.channelsById.gen).toBeUndefined();
    expect(store.messages).toEqual([]);
  });

  it('error path: row re-inserted, no message buffer cleared', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);
    store.messages = [{ id: 'm1', channel: 'gen' }];
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'forbidden' });

    const res = await store.deleteChannel('gen');

    expect(res.success).toBe(false);
    expect(res.error).toBe('forbidden');
    expect(store.channelsById.gen).toBeTruthy();
    expect(store.messages).toHaveLength(1);
  });

  it('unknown channel returns error', async () => {
    const store = new MqttChatStore();
    const res = await store.deleteChannel('ghost');
    expect(res.success).toBe(false);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });
});

// ── setTopic ──────────────────────────────────────────────────────────────

describe('MqttChatStore — setTopic', () => {
  it('happy path: optimistic update + MCP success leaves new topic', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', topic: 'old' })]);
    store.userProfile.key = 'phil-key';
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: { status: 'updated' } });

    const res = await store.setTopic('gen', 'new topic');

    expect(res.success).toBe(true);
    expect(store.channelsById.gen.topic).toBe('new topic');
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: 'phil-key',
      conversation: 'gen',
      topic: 'new topic',
    });
  });

  it('error path: rolls back to prior topic on failure', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', topic: 'old' })]);
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'rate-limited' });

    const res = await store.setTopic('gen', 'new');

    expect(res.success).toBe(false);
    expect(store.channelsById.gen.topic).toBe('old');
  });
});

// ── setMute (Q4 lock — local only) ────────────────────────────────────────

describe('MqttChatStore — setMute', () => {
  it('writes localStorage + updates muteLevel + muted; no MCP call', () => {
    const store = new MqttChatStore();
    store.channelsById = { gen: { id: 'gen', muted: false, muteLevel: 'off' } };

    const res = store.setMute('gen', 'mentions');

    expect(res.success).toBe(true);
    expect(store.channelsById.gen.muteLevel).toBe('mentions');
    expect(store.channelsById.gen.muted).toBe(true);
    expect(localStorage.getItem('claude-comms.mute.gen')).toBe('mentions');
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('rejects invalid mute levels', () => {
    const store = new MqttChatStore();
    store.channelsById = { gen: { id: 'gen', muted: false, muteLevel: 'off' } };

    const res = store.setMute('gen', 'forever');
    expect(res.success).toBe(false);
    expect(store.channelsById.gen.muteLevel).toBe('off');
  });

  it("level 'off' flips muted to false", () => {
    const store = new MqttChatStore();
    store.channelsById = { gen: { id: 'gen', muted: true, muteLevel: 'all' } };

    const res = store.setMute('gen', 'off');
    expect(res.success).toBe(true);
    expect(store.channelsById.gen.muted).toBe(false);
    expect(store.channelsById.gen.muteLevel).toBe('off');
  });
});

// ── setStar (Q4-adjacent local) ───────────────────────────────────────────

describe('MqttChatStore — setStar', () => {
  it('writes localStorage + flips in-memory starred', () => {
    const store = new MqttChatStore();
    store.channelsById = { gen: { id: 'gen', starred: false } };

    const res = store.setStar('gen', true);

    expect(res.success).toBe(true);
    expect(store.channelsById.gen.starred).toBe(true);
    expect(localStorage.getItem('claude-comms.star.gen')).toBe('true');
  });

  it('restoreLocalChannelState picks up persisted star on bootstrap', async () => {
    localStorage.setItem('claude-comms.star.gen', 'true');
    localStorage.setItem('claude-comms.mute.gen', 'mentions');
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true, myStarred: false, myMuted: false })]);

    expect(store.channelsById.gen.starred).toBe(true);
    expect(store.channelsById.gen.muteLevel).toBe('mentions');
    expect(store.channelsById.gen.muted).toBe(true);
  });
});
