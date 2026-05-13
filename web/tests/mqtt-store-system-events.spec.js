// v0.4.0 Step 2.7 — `#handleSystemConversation` full event taxonomy.
//
// Step 2.6 already covered the `conversation_created` full-row populate
// in `mqtt-store-channels.spec.js`. This spec covers the *full* event
// taxonomy the daemon now publishes on `claude-comms/system/conversations`
// post-Steps 2.2 / 2.3:
//
//   - `created` / `conversation_created`        (Step 2.6 — shape only here)
//   - `topic_changed` / `conversation_topic_changed`
//   - `renamed` (forward-compat — backend not yet publishing as of 2.7)
//   - `deleted` / `conversation_deleted`        (Step 2.2)
//   - `archived` / `unarchived`                 (Step 2.3)
//   - `member_joined` / `member_left`           (forward-compat)
//   - unknown-type defensive guard              (parse-failure + skip)
//
// Specifically asserts the user-currently-viewing-this-channel switch
// logic for `deleted` and `archived` (the brief's headline behaviour),
// the dual-id-field acceptance (`msg.id` vs `msg.name`), and the
// `inAppToasts === false` opt-out suppression.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks — match the pattern from mqtt-store-channels.spec.js
// so the store loads under jsdom without standing up a real MQTT
// transport or daemon.
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
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    /* jsdom may not provide localStorage in some environments */
  }
});

// ── created (alias path) ──────────────────────────────────────────────────

describe('MqttChatStore — Step 2.7 created alias', () => {
  it("accepts the bare ``'created'`` type alias (post-2.6 forward-compat)", () => {
    const store = new MqttChatStore();
    store._handleSystemEventForTest({
      type: 'created',
      id: 'aliased',
      topic: 'short alias',
      creator_key: 'phil-mcp',
      timestamp: '2026-05-12T18:00:00Z',
    });
    expect(store.channelsById.aliased).toBeTruthy();
    expect(store.channelsById.aliased.topic).toBe('short alias');
    expect(store.channelsById.aliased.createdBy).toBe('phil-mcp');
    expect(store.channelsById.aliased.createdAt).toBe('2026-05-12T18:00:00Z');
  });

  it('does not clobber an existing row on duplicate create echo', () => {
    const store = new MqttChatStore();
    store._handleSystemEventForTest({
      type: 'conversation_created',
      name: 'dup',
      topic: 'first',
      ts: '2026-05-12T18:00:00Z',
    });
    // Local user later joined and got memberCount bumped externally.
    store.channelsById.dup.member = true;
    store.channelsById.dup.memberCount = 3;

    // A redundant create echo should NOT reset member or memberCount.
    store._handleSystemEventForTest({
      type: 'conversation_created',
      name: 'dup',
      topic: 'second',
      ts: '2026-05-12T18:01:00Z',
    });
    expect(store.channelsById.dup.member).toBe(true);
    expect(store.channelsById.dup.memberCount).toBe(3);
  });
});

// ── topic_changed (alias path) ────────────────────────────────────────────

describe('MqttChatStore — Step 2.7 topic_changed alias', () => {
  it("accepts the bare ``'topic_changed'`` type alias", async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', topic: 'old topic' })]);
    store._handleSystemEventForTest({
      type: 'topic_changed',
      id: 'gen',
      topic: 'shiny new topic',
    });
    expect(store.channelsById.gen.topic).toBe('shiny new topic');
  });

  it('still accepts the legacy ``conversation_topic_changed`` form with ``name``', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', topic: 'old topic' })]);
    store._handleSystemEventForTest({
      type: 'conversation_topic_changed',
      name: 'gen',
      topic: 'v0.3.2 wire format',
    });
    expect(store.channelsById.gen.topic).toBe('v0.3.2 wire format');
  });
});

// ── renamed (forward-compat) ──────────────────────────────────────────────

describe('MqttChatStore — Step 2.7 renamed forward-compat', () => {
  it('updates the channel display name; id is unchanged', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'imm-id', name: 'old-name' })]);
    store._handleSystemEventForTest({
      type: 'renamed',
      id: 'imm-id',
      name: 'fresh-name',
    });
    expect(store.channelsById['imm-id']).toBeTruthy();
    expect(store.channelsById['imm-id'].name).toBe('fresh-name');
    expect(store.channelsById['imm-id'].id).toBe('imm-id');
  });

  it('no-op when the channel is unknown', () => {
    const store = new MqttChatStore();
    store._handleSystemEventForTest({
      type: 'renamed',
      id: 'never-seen',
      name: 'whatever',
    });
    expect(store.channelsById['never-seen']).toBeUndefined();
  });
});

// ── deleted ───────────────────────────────────────────────────────────────

describe('MqttChatStore — Step 2.7 deleted', () => {
  it('removes the row, clears that channel\'s messages, leaves others intact', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'gone', member: true }),
      row({ id: 'survives', member: true }),
    ]);
    store.messages = [
      { id: 'm1', channel: 'gone', body: 'old1' },
      { id: 'm2', channel: 'gone', body: 'old2' },
      { id: 'm3', channel: 'survives', body: 'keep' },
    ];

    store._handleSystemEventForTest({
      type: 'deleted',
      id: 'gone',
      deletedBy: 'Phil',
      timestamp: '2026-05-12T18:30:00Z',
    });

    expect(store.channelsById.gone).toBeUndefined();
    expect(store.channelsById.survives).toBeTruthy();
    // Only the deleted channel's messages were cleared.
    expect(store.messages.map((m) => m.id)).toEqual(['m3']);
  });

  it('switches active channel + emits toast when user was viewing the deleted one', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'doomed', name: 'doomed', member: true }),
      row({ id: 'alpha', name: 'alpha', member: true }),
    ]);
    store.activeChannel = 'doomed';

    store._handleSystemEventForTest({
      type: 'deleted',
      id: 'doomed',
      deletedBy: 'Phil',
      timestamp: '2026-05-12T18:31:00Z',
    });

    // Switched to next member channel alpha-sorted.
    expect(store.activeChannel).toBe('alpha');
    // Toast emitted.
    expect(store.latestChannelLifecycleToast).toMatchObject({
      kind: 'deleted',
      channelId: 'doomed',
      channelName: 'doomed',
      by: 'Phil',
    });
    expect(store.latestChannelLifecycleToast.epoch).toBe(1);
  });

  it('falls active channel back to null when no other member channels exist', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'only', member: true })]);
    store.activeChannel = 'only';

    store._handleSystemEventForTest({
      type: 'deleted',
      id: 'only',
      deletedBy: 'Phil',
    });
    expect(store.activeChannel).toBeNull();
  });

  it('accepts the legacy ``conversation_deleted`` form with ``name`` + ``deleted_by``', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'gen', member: true })]);
    store.activeChannel = 'gen';

    store._handleSystemEventForTest({
      type: 'conversation_deleted',
      name: 'gen',
      deleted_by: 'Phil',
      ts: '2026-05-12T18:32:00Z',
    });

    expect(store.channelsById.gen).toBeUndefined();
    expect(store.latestChannelLifecycleToast).toMatchObject({
      kind: 'deleted',
      channelId: 'gen',
      by: 'Phil',
    });
  });
});

// ── archived ──────────────────────────────────────────────────────────────

describe('MqttChatStore — Step 2.7 archived', () => {
  it('flips archived = true and stamps archived_at + archived_by', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'shelve', member: true })]);

    store._handleSystemEventForTest({
      type: 'archived',
      id: 'shelve',
      archivedBy: 'Phil',
      timestamp: '2026-05-12T19:00:00Z',
    });

    expect(store.channelsById.shelve.archived).toBe(true);
    expect(store.channelsById.shelve.archived_at).toBe('2026-05-12T19:00:00Z');
    expect(store.channelsById.shelve.archived_by).toBe('Phil');
    // Row leaves activeChannels via the $derived archived filter.
    expect(store.activeChannels.map((c) => c.id)).not.toContain('shelve');
    expect(store.archivedChannels.map((c) => c.id)).toContain('shelve');
  });

  it('switches active channel + emits toast when user was viewing the archived one', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'busy', name: 'busy', member: true }),
      row({ id: 'beta', name: 'beta', member: true }),
    ]);
    store.activeChannel = 'busy';
    store.messages = [
      { id: 'm1', channel: 'busy', body: 'old' },
      { id: 'm2', channel: 'beta', body: 'keep' },
    ];

    store._handleSystemEventForTest({
      type: 'archived',
      id: 'busy',
      archivedBy: 'Phil',
      timestamp: '2026-05-12T19:01:00Z',
    });

    expect(store.activeChannel).toBe('beta');
    expect(store.latestChannelLifecycleToast).toMatchObject({
      kind: 'archived',
      channelId: 'busy',
      channelName: 'busy',
      by: 'Phil',
    });
    // Local buffer for the archived channel cleared.
    expect(store.messages.map((m) => m.id)).toEqual(['m2']);
  });
});

// ── unarchived ────────────────────────────────────────────────────────────

describe('MqttChatStore — Step 2.7 unarchived', () => {
  it('flips archived back to false; row reappears in availableChannels', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({
        id: 'old',
        name: 'old',
        member: false,
        visibility: 'listed',
        archived: true,
      }),
    ]);
    // Sanity: row is in archived, not available.
    expect(store.archivedChannels.map((c) => c.id)).toContain('old');
    expect(store.availableChannels.map((c) => c.id)).not.toContain('old');

    store._handleSystemEventForTest({
      type: 'unarchived',
      id: 'old',
      timestamp: '2026-05-12T19:30:00Z',
    });

    expect(store.channelsById.old.archived).toBe(false);
    expect(store.channelsById.old.archived_at).toBeNull();
    expect(store.channelsById.old.archived_by).toBeNull();
    expect(store.availableChannels.map((c) => c.id)).toContain('old');
    expect(store.archivedChannels.map((c) => c.id)).not.toContain('old');
  });

  it('does not emit a lifecycle toast on unarchive (non-destructive)', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'q', archived: true })]);

    store._handleSystemEventForTest({ type: 'unarchived', id: 'q' });
    expect(store.latestChannelLifecycleToast).toBeNull();
  });
});

// ── member_joined / member_left ───────────────────────────────────────────

describe('MqttChatStore — Step 2.7 member_joined / member_left', () => {
  it('member_joined bumps memberCount and lastActivity', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'crowded', member: true, memberCount: 2 }),
    ]);

    store._handleSystemEventForTest({
      type: 'member_joined',
      id: 'crowded',
      key: 'other-key',
      timestamp: '2026-05-12T20:00:00Z',
    });

    expect(store.channelsById.crowded.memberCount).toBe(3);
    expect(store.channelsById.crowded.lastActivity).toBe('2026-05-12T20:00:00Z');
  });

  it('member_joined for self flips member = true (forward-compat)', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'newly', member: false, memberCount: 4 }),
    ]);
    store.userProfile.key = 'phil-key';

    store._handleSystemEventForTest({
      type: 'member_joined',
      id: 'newly',
      key: 'phil-key',
    });

    expect(store.channelsById.newly.member).toBe(true);
    expect(store.channelsById.newly.memberCount).toBe(5);
  });

  it('member_left decrements memberCount, never below zero', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'thinning', member: true, memberCount: 1 }),
    ]);

    store._handleSystemEventForTest({
      type: 'member_left',
      id: 'thinning',
      key: 'other-key',
    });
    expect(store.channelsById.thinning.memberCount).toBe(0);

    // Re-firing decrements no further (defensive against duplicate echo).
    store._handleSystemEventForTest({
      type: 'member_left',
      id: 'thinning',
      key: 'other-key',
    });
    expect(store.channelsById.thinning.memberCount).toBe(0);
  });

  it('member_left for self flips member = false and auto-unstars', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [
      row({ id: 'leaving', member: true, memberCount: 3, myStarred: true }),
    ]);
    store.userProfile.key = 'phil-key';
    // Sanity: starred was set by the wire row's myStarred.
    expect(store.channelsById.leaving.starred).toBe(true);

    store._handleSystemEventForTest({
      type: 'member_left',
      id: 'leaving',
      key: 'phil-key',
    });

    expect(store.channelsById.leaving.member).toBe(false);
    expect(store.channelsById.leaving.starred).toBe(false);
    expect(store.channelsById.leaving.memberCount).toBe(2);
  });
});

// ── inAppToasts opt-out ───────────────────────────────────────────────────

describe('MqttChatStore — Step 2.7 inAppToasts suppression', () => {
  it('suppresses lifecycle toasts when user has disabled in-app toasts', async () => {
    const store = new MqttChatStore();
    await bootstrapWith(store, [row({ id: 'a', member: true })]);
    store.inAppToasts = false;
    store.activeChannel = 'a';

    store._handleSystemEventForTest({
      type: 'deleted',
      id: 'a',
      deletedBy: 'Phil',
    });

    // Row still got removed; the active-channel switch still happened.
    expect(store.channelsById.a).toBeUndefined();
    // ...but no toast was emitted.
    expect(store.latestChannelLifecycleToast).toBeNull();
  });
});

// ── Unknown-type defensive guard ──────────────────────────────────────────

describe('MqttChatStore — Step 2.7 unknown-type defensive guard', () => {
  it('logs structured context and bumps parseFailureRate on unknown type', () => {
    const store = new MqttChatStore();
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const beforeRate = store.parseFailureRate;

    store._handleSystemEventForTest({
      type: 'no_such_type',
      id: 'whatever',
    });

    expect(store.parseFailureRate).toBe(beforeRate + 1);
    expect(consoleErrSpy).toHaveBeenCalledWith(
      '[claude-comms] system/conversations event rejected',
      expect.objectContaining({
        reason: expect.stringContaining('no_such_type'),
      }),
    );
    consoleErrSpy.mockRestore();
  });

  it('does not throw on null / non-object / missing type / missing id', () => {
    const store = new MqttChatStore();
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => store._handleSystemEventForTest(null)).not.toThrow();
    expect(() => store._handleSystemEventForTest({})).not.toThrow();
    expect(() => store._handleSystemEventForTest({ type: 'deleted' })).not.toThrow();
    expect(() =>
      store._handleSystemEventForTest({ type: 'archived', id: '', name: '' }),
    ).not.toThrow();

    consoleErrSpy.mockRestore();
  });
});
