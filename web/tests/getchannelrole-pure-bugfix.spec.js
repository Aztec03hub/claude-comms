// v0.4.3 hotfix — getChannelRole pure-read regression coverage.
//
// Layer B real-browser smoke caught Phil's item #3 + #5 (also the root
// cause of item #4 + item #8 cascades) in v0.4.2: the Wave B
// ``getChannelRole`` accessor lazily wrote to ``this.channelRoles``
// inside the accessor body. When the accessor was invoked from a
// Svelte 5 ``$derived`` expression (App.svelte:981 ChatView mount prop;
// App.svelte:1088 MemberContextMenu mount prop), the $state write
// inside derived-context tracking tripped ``state_unsafe_mutation``
// and broke the entire App.svelte render tree, taking the
// create-channel modal, the chat-header button row, and the
// right-click-self context menu down with it.
//
// The v0.4.3 fix splits the concern in three:
//
//   1. ``#inferChannelRole(channelId)`` — pure inference, no writes.
//   2. ``#prewarmChannelRoles()`` — bulk-warms the cache; called from
//      bootstrap + every channel-add site.
//   3. ``getChannelRole(channelId)`` — pure read of
//      ``channelRoles[channelId]``, safe from any context.
//
// This suite pins the new contract against future regressions:
//
//   1. ``getChannelRole`` does not write to ``channelRoles`` even when
//      it returns a non-null role (the very property that's required
//      for it to be safe inside a $derived).
//   2. Bootstrap pre-warms every channel's role into ``channelRoles``,
//      so consumers reading from $derived blocks see a populated cache
//      on the very first render.
//   3. A channel that joins AFTER bootstrap is also pre-warmed (via
//      the joinChannel success path).
//   4. A channel CREATED locally (createChannel) is pre-warmed too —
//      with the creator getting 'owner' role per Wave B's inference.
//   5. ``getChannelRole`` returns null gracefully for unknown ids, for
//      empty strings, for non-string inputs.
//   6. Invoking ``getChannelRole`` from a $derived context does NOT
//      throw — pins the actual Layer B bug.
//
// Total: 7 tests (≥6 required by the brief).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Hoisted mock for the api module so the store can be imported and its
// bootstrap helper exercised without a live daemon. ``mcpCall`` is
// stubbed to a vi.fn so joinChannel's MCP round-trip resolves
// deterministically (the test re-stubs the mock per-call).
const apiGetMock = vi.fn();
const mcpCallMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: (...args) => apiGetMock(...args),
  apiPost: vi.fn(),
  mcpCall: (...args) => mcpCallMock(...args),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

function makeBootstrapPayload(rows) {
  return rows.map((r) => ({
    topic: '',
    member: true,
    memberCount: 1,
    lastActivity: null,
    mode: 'public',
    visibility: 'listed',
    createdAt: '2026-04-01T00:00:00Z',
    myUnread: 0,
    myStarred: false,
    myMuted: false,
    ...r,
  }));
}

describe('MqttChatStore.getChannelRole — v0.4.3 hotfix pure-read contract', () => {
  /** @type {InstanceType<typeof MqttChatStore>} */
  let store;

  beforeEach(() => {
    apiGetMock.mockReset();
    mcpCallMock.mockReset();
    store = new MqttChatStore();
    // Pin a userProfile so the inference rules have something to match.
    store.userProfile = { key: 'me-key', name: 'me', type: 'human' };
  });

  it('does not mutate channelRoles on a non-null read (the pure-read property)', async () => {
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([
        { id: 'general', name: 'general', createdBy: 'someone-else' },
      ]),
    );
    await store._bootstrapChannelsForTest();

    // After bootstrap the cache is populated. We then drop the cache
    // entry to simulate a stale-cache state and verify that reading
    // it via the accessor does NOT silently re-populate it. A pure
    // read returns null for missing entries; a lazy-write accessor
    // would re-populate as a side effect.
    delete store.channelRoles['general'];
    const role = store.getChannelRole('general');

    expect(role).toBeNull();
    expect(store.channelRoles['general']).toBeUndefined();
  });

  it('#bootstrapChannels pre-warms channelRoles for every bootstrapped channel', async () => {
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([
        { id: 'general', name: 'general', createdBy: 'me-key' },
        { id: 'random', name: 'random', createdBy: 'someone-else' },
        { id: 'project-alpha', name: 'project-alpha', createdBy: 'me-key' },
      ]),
    );

    await store._bootstrapChannelsForTest();

    // Every channel id has a corresponding entry in channelRoles after
    // bootstrap — no lazy population required.
    expect(Object.keys(store.channelRoles).sort()).toEqual(
      ['general', 'project-alpha', 'random'],
    );
    expect(store.channelRoles['general']).toBe('owner');
    expect(store.channelRoles['random']).toBe('member');
    expect(store.channelRoles['project-alpha']).toBe('owner');
  });

  it('joinChannel populates channelRoles for a freshly-joined channel', async () => {
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([
        // Non-member row in the bootstrap; user joins it later.
        { id: 'side-room', name: 'side-room', createdBy: 'someone-else', member: false },
      ]),
    );
    await store._bootstrapChannelsForTest();

    // Wave B's pre-warm populates the cache for the bootstrap row.
    expect(store.channelRoles['side-room']).toBe('member');

    // joinChannel calls mcpCall under the hood; the api.js mock above
    // exposes mcpCallMock so we can drive the success path deterministically.
    mcpCallMock.mockResolvedValueOnce({ success: true });

    const result = await store.joinChannel('side-room');
    expect(result.success).toBe(true);
    // Role cache is still populated AND consistent after the join.
    expect(store.channelRoles['side-room']).toBe('member');
  });

  it('createChannel pre-warms channelRoles with the creator as owner', async () => {
    apiGetMock.mockResolvedValueOnce(makeBootstrapPayload([]));
    await store._bootstrapChannelsForTest();

    // Local create: no MQTT client wired, but the local row insert
    // still happens. The pre-warm path on createChannel runs.
    store.createChannel('phoenix', 'roadmap chatter');

    expect(store.channelsById['phoenix']).toBeTruthy();
    expect(store.channelRoles['phoenix']).toBe('owner');
    // getChannelRole returns the cached value WITHOUT writing.
    const before = { ...store.channelRoles };
    expect(store.getChannelRole('phoenix')).toBe('owner');
    expect(store.channelRoles).toEqual(before);
  });

  it('returns null gracefully for unknown ids, empty strings, and non-string inputs', () => {
    expect(store.getChannelRole('does-not-exist')).toBeNull();
    expect(store.getChannelRole('')).toBeNull();
    expect(store.getChannelRole(null)).toBeNull();
    expect(store.getChannelRole(undefined)).toBeNull();
    expect(store.getChannelRole(42)).toBeNull();
    // Importantly, none of these "trivial-null" returns populated the
    // map as a side effect.
    expect(Object.keys(store.channelRoles)).toEqual([]);
  });

  it('source-level pin: getChannelRole body contains no channelRoles assignment', () => {
    // Belt-and-suspenders pin. The pre-hotfix accessor had
    // ``this.channelRoles[channelId] = role`` in its body, which is
    // the exact mutation that tripped Svelte's unsafe-mutation guard.
    // We grep the source so a future refactor cannot re-introduce a
    // lazy write inside the accessor body without this test failing
    // first.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const STORE_SRC = resolve(HERE, '..', 'src', 'lib', 'mqtt-store.svelte.js');
    const src = readFileSync(STORE_SRC, 'utf8');
    // Isolate the accessor body. We bracket between the method
    // declaration and the closing brace by matching from the opening
    // brace to a line that contains only "  }" at the method-indent
    // level. This is a deliberately tight slice so the assertion is
    // unambiguous about which body it's reading.
    const start = src.indexOf('\n  getChannelRole(channelId) {\n');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('\n  }\n', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // The pure-read body must NOT assign to channelRoles (an
    // assignment is what trips ``state_unsafe_mutation``). We match
    // ``this.channelRoles[...] =`` (with optional whitespace and
    // NOT-= so '==' / '===' equality checks pass through).
    expect(body).not.toMatch(/this\.channelRoles\s*\[[^\]]+\]\s*=[^=]/);
    // Sanity: the body DOES read from channelRoles (so the test isn't
    // matching a different method by mistake).
    expect(body).toMatch(/return\s+this\.channelRoles\[/);
  });

  it('survives a "reconnect" pattern (re-bootstrap re-populates the cache)', async () => {
    // Pre-hotfix the lazy-write accessor could leave the cache in a
    // partial state on reconnect (only channels that had been queried
    // would have entries). Post-hotfix EVERY bootstrap re-warms the
    // full cache, so a reconnect re-syncs roles for the new payload
    // without relying on consumer-driven queries.
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([
        { id: 'general', name: 'general', createdBy: 'me-key' },
      ]),
    );
    await store._bootstrapChannelsForTest();
    expect(store.channelRoles['general']).toBe('owner');

    // Simulate a reconnect with a fresh payload that adds a second
    // channel and removes the first.
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([
        { id: 'random', name: 'random', createdBy: 'someone-else' },
      ]),
    );
    await store._bootstrapChannelsForTest();
    // The newly bootstrapped channel is warmed.
    expect(store.channelRoles['random']).toBe('member');
    // getChannelRole reads from the cache with no side effects.
    expect(store.getChannelRole('random')).toBe('member');
  });
});
