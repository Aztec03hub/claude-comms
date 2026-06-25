// Reactions who-reacted data layer (M4 / M8).
//
// Covers the store's per-emoji ``users[]`` model and hydration:
//   - users accumulate + dedup on add; drop on remove; pill removed when empty
//   - count/active are DERIVED from users on every mutation (never drift)
//   - optimistic self write (addReaction) + ignored self-echo on direct apply
//   - hydration snapshot + buffered replay with a remove AND an add arriving
//     mid-fetch (final membership correct; removed actor not resurrected)
//   - a message not in the snapshot keeps its live-tracked users untouched
//   - resolveReactor: self -> "You" (via isSelf), unknown -> raw key,
//     name change reflected after participants update
//
// The api.js module is mocked (incl. getReactions) so no daemon is needed.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const getReactionsMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
  mcpCall: vi.fn(),
  getReactions: (...args) => getReactionsMock(...args),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

const SELF = 'aaaaaaaa';
const ALICE = 'bbbbbbbb';
const BOB = 'cccccccc';
const CAROL = 'dddddddd';

function makeStore() {
  const store = new MqttChatStore();
  store.userProfile.key = SELF;
  store.userProfile.name = 'Me';
  return store;
}

function seedMessage(store, id = 'm1') {
  store.messages = [...store.messages, { id, channel: 'general', reactions: [] }];
  return store.messages.find((m) => m.id === id);
}

function reactionFor(store, id, emoji) {
  const msg = store.messages.find((m) => m.id === id);
  return (msg?.reactions ?? []).find((r) => r.emoji === emoji);
}

beforeEach(() => {
  getReactionsMock.mockReset();
});

describe('reaction model: users[] is source of truth', () => {
  it('accumulates distinct actors and derives count/active on remote add', () => {
    const store = makeStore();
    seedMessage(store);

    store._handleRemoteReactionForTest('general', {
      message_id: 'm1',
      emoji: '👍',
      op: 'add',
      actor_key: ALICE,
    });
    store._handleRemoteReactionForTest('general', {
      message_id: 'm1',
      emoji: '👍',
      op: 'add',
      actor_key: BOB,
    });

    const r = reactionFor(store, 'm1', '👍');
    expect(r.users).toEqual([ALICE, BOB]);
    expect(r.count).toBe(2);
    expect(r.active).toBe(false); // self not among reactors
  });

  it('dedups a repeated add of the same actor', () => {
    const store = makeStore();
    seedMessage(store);
    for (let i = 0; i < 3; i++) {
      store._handleRemoteReactionForTest('general', {
        message_id: 'm1',
        emoji: '👍',
        op: 'add',
        actor_key: ALICE,
      });
    }
    const r = reactionFor(store, 'm1', '👍');
    expect(r.users).toEqual([ALICE]);
    expect(r.count).toBe(1);
  });

  it('removes an actor and drops the pill when the last reactor leaves', () => {
    const store = makeStore();
    seedMessage(store);
    store._handleRemoteReactionForTest('general', {
      message_id: 'm1', emoji: '👍', op: 'add', actor_key: ALICE,
    });
    store._handleRemoteReactionForTest('general', {
      message_id: 'm1', emoji: '👍', op: 'remove', actor_key: ALICE,
    });
    expect(reactionFor(store, 'm1', '👍')).toBeUndefined();
  });

  it('derives active=true when self is among the reactors', () => {
    const store = makeStore();
    seedMessage(store);
    // Self reaction arrives via hydration replay path (not skipped).
    const buffer = store._startReactionHydrationForTest('general');
    expect(buffer).toEqual([]);
    store._reconcileReactionsForTest('general', {
      m1: { '👍': [ALICE, SELF] },
    });
    const r = reactionFor(store, 'm1', '👍');
    expect(r.users).toEqual([ALICE, SELF]);
    expect(r.count).toBe(2);
    expect(r.active).toBe(true);
  });
});

describe('optimistic self + ignored self-echo', () => {
  it('addReaction writes self into users and derives active/count', () => {
    const store = makeStore();
    seedMessage(store);
    store.addReaction('m1', '🎉');
    const r = reactionFor(store, 'm1', '🎉');
    expect(r.users).toEqual([SELF]);
    expect(r.count).toBe(1);
    expect(r.active).toBe(true);
  });

  it('addReaction toggles self back out (remove) when already active', () => {
    const store = makeStore();
    seedMessage(store);
    store.addReaction('m1', '🎉'); // add
    store.addReaction('m1', '🎉'); // remove
    expect(reactionFor(store, 'm1', '🎉')).toBeUndefined();
  });

  it('ignores our own re-broadcast on the direct-apply path (no double count)', () => {
    const store = makeStore();
    seedMessage(store);
    store.addReaction('m1', '🎉'); // optimistic self add
    // Server echoes our own resolved add back to us.
    store._handleRemoteReactionForTest('general', {
      message_id: 'm1', emoji: '🎉', op: 'add', actor_key: SELF,
    });
    const r = reactionFor(store, 'm1', '🎉');
    expect(r.users).toEqual([SELF]);
    expect(r.count).toBe(1); // not 2
  });
});

describe('hydration: snapshot + buffered replay (race-correct)', () => {
  it('a remove arriving mid-fetch is honored; the actor is not resurrected', async () => {
    const store = makeStore();
    seedMessage(store);

    // Snapshot (authoritative base, taken server-side) shows Alice + Bob.
    getReactionsMock.mockImplementation(async () => {
      // While the GET is "in flight", a remove for Alice broadcasts.
      store._handleRemoteReactionForTest('general', {
        message_id: 'm1', emoji: '👍', op: 'remove', actor_key: ALICE,
      });
      return { conversation: 'general', reactions: { m1: { '👍': [ALICE, BOB] } } };
    });

    await store._fetchReactionsForTest('general');

    const r = reactionFor(store, 'm1', '👍');
    expect(r.users).toEqual([BOB]); // Alice removed, not resurrected by snapshot
    expect(r.count).toBe(1);
  });

  it('an add arriving mid-fetch is included in the final membership', async () => {
    const store = makeStore();
    seedMessage(store);

    getReactionsMock.mockImplementation(async () => {
      // A new add for Carol broadcasts during the fetch.
      store._handleRemoteReactionForTest('general', {
        message_id: 'm1', emoji: '👍', op: 'add', actor_key: CAROL,
      });
      return { conversation: 'general', reactions: { m1: { '👍': [ALICE] } } };
    });

    await store._fetchReactionsForTest('general');

    const r = reactionFor(store, 'm1', '👍');
    expect(r.users).toEqual([ALICE, CAROL]);
    expect(r.count).toBe(2);
  });

  it('rebuilds users from the snapshot (authoritative) over stale live state', () => {
    const store = makeStore();
    seedMessage(store);
    // Pre-existing (stale) live state shows only Alice.
    store._handleRemoteReactionForTest('general', {
      message_id: 'm1', emoji: '👍', op: 'add', actor_key: ALICE,
    });
    store._startReactionHydrationForTest('general');
    store._reconcileReactionsForTest('general', {
      m1: { '👍': [ALICE, BOB, CAROL] },
    });
    const r = reactionFor(store, 'm1', '👍');
    expect(r.users).toEqual([ALICE, BOB, CAROL]);
  });

  it('leaves a message not present in the snapshot untouched', () => {
    const store = makeStore();
    seedMessage(store, 'm1');
    seedMessage(store, 'm2');
    // m2 has a live reaction that the snapshot does not mention.
    store._handleRemoteReactionForTest('general', {
      message_id: 'm2', emoji: '🔥', op: 'add', actor_key: BOB,
    });
    store._startReactionHydrationForTest('general');
    store._reconcileReactionsForTest('general', { m1: { '👍': [ALICE] } });

    expect(reactionFor(store, 'm1', '👍').users).toEqual([ALICE]);
    expect(reactionFor(store, 'm2', '🔥').users).toEqual([BOB]); // untouched
  });

  it('ignores snapshot entries for messages not in this.messages', () => {
    const store = makeStore();
    seedMessage(store, 'm1');
    store._startReactionHydrationForTest('general');
    store._reconcileReactionsForTest('general', {
      'unknown-msg': { '👍': [ALICE] },
      m1: { '🎉': [BOB] },
    });
    expect(store.messages.find((m) => m.id === 'unknown-msg')).toBeUndefined();
    expect(reactionFor(store, 'm1', '🎉').users).toEqual([BOB]);
  });

  it('discards the buffer and degrades gracefully on fetch failure', async () => {
    const store = makeStore();
    seedMessage(store);
    store._handleRemoteReactionForTest('general', {
      message_id: 'm1', emoji: '👍', op: 'add', actor_key: ALICE,
    });
    getReactionsMock.mockRejectedValue(new Error('daemon warming'));

    await store._fetchReactionsForTest('general');

    // Live-applied reaction survives; snapshot just missing. No throw.
    expect(reactionFor(store, 'm1', '👍').users).toEqual([ALICE]);
  });
});

describe('resolveReactor', () => {
  it('flags self (isSelf true) for the local key so the UI renders "You"', () => {
    const store = makeStore();
    // name resolves from the participants map (self not in it -> key fallback);
    // the rendering layer shows "You" off the isSelf flag, not this name.
    expect(store.resolveReactor(SELF)).toEqual({ name: SELF, isSelf: true });
    // When self IS in the participants map, the name resolves to it.
    store.participants[SELF] = { key: SELF, name: 'Me', connections: {} };
    expect(store.resolveReactor(SELF)).toEqual({ name: 'Me', isSelf: true });
  });

  it('falls back to the raw key when the participant is unknown', () => {
    const store = makeStore();
    expect(store.resolveReactor(ALICE)).toEqual({ name: ALICE, isSelf: false });
  });

  it('reflects a participant name change after participants update', () => {
    const store = makeStore();
    store.participants[ALICE] = { key: ALICE, name: 'Alice', connections: {} };
    expect(store.resolveReactor(ALICE).name).toBe('Alice');
    store.participants[ALICE].name = 'Alice Renamed';
    expect(store.resolveReactor(ALICE).name).toBe('Alice Renamed');
  });
});
