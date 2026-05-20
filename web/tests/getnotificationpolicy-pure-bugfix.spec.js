// v0.4.4 hotfix - getNotificationPolicy pure-read regression coverage.
//
// Phil's Layer B real-browser pass against v0.4.3 caught a
// ``state_unsafe_mutation`` thrown on new channel creation. Stack trace:
//
//   set notificationPolicies (mqtt-store.svelte.js:207:23)
//   getNotificationPolicy (mqtt-store.svelte.js:3620:10)
//   T (Sidebar.svelte:260:18)        // getChannelNotificationPolicy
//   SidebarChannelSection.svelte:244:19
//
// Root cause: same anti-pattern class as v0.4.3's ``getChannelRole`` fix.
// The pre-v0.4.4 ``getNotificationPolicy`` lazy-wrote to
// ``this.notificationPolicies`` when the entry was missing. Bootstrap's
// ``#prewarmNotificationPolicies`` covered channels present at bootstrap
// time, but channels created / joined / inserted via realtime events
// AFTER bootstrap hit the lazy-write path on first sidebar render - and
// since that read happens inside SidebarChannelSection's $derived, the
// write tripped Svelte 5's unsafe-mutation guard.
//
// The v0.4.4 fix mirrors v0.4.3's split-of-concerns:
//
//   1. ``#decodeNotificationPolicyForChannel(id)`` - pure decoder; reads
//      localStorage; performs NO $state writes.
//   2. ``#prewarmNotificationPolicies()`` - bulk-warms the cache from
//      ``channelsById``; called from bootstrap.
//   3. ``#prewarmNotificationPolicyForChannel(id)`` - single-channel
//      pre-warm; called from every channel-add site (createChannel,
//      joinChannel success, conversation_created system event,
//      #handleMeta first-insert).
//   4. ``getNotificationPolicy(id)`` - pure read with a localStorage
//      fallback that ALSO performs NO writes. Safe from any $derived
//      context.
//
// This suite pins the new contract against future regressions across all
// the channel-add paths so the cache is populated BEFORE any sidebar
// $derived reads it.
//
// Total: 8 tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Hoisted mock for the api module so the store can be imported and its
// bootstrap helper exercised without a live daemon.
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
    visibility: 'public',
    createdAt: '2026-04-01T00:00:00Z',
    myUnread: 0,
    myStarred: false,
    myMuted: false,
    ...r,
  }));
}

describe('MqttChatStore.getNotificationPolicy - v0.4.4 hotfix pure-read contract', () => {
  /** @type {InstanceType<typeof MqttChatStore>} */
  let store;

  beforeEach(() => {
    apiGetMock.mockReset();
    mcpCallMock.mockReset();
    // Reset localStorage between tests so policy persistence doesn't
    // leak across cases.
    try {
      if (typeof localStorage !== 'undefined') localStorage.clear();
    } catch {
      // jsdom may not provide localStorage in every config; defensive.
    }
    store = new MqttChatStore();
    store.userProfile = { key: 'me-key', name: 'me', type: 'human' };
  });

  it('does not mutate notificationPolicies on a cache-miss read (the pure-read property)', async () => {
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([{ id: 'general', name: 'general' }]),
    );
    await store._bootstrapChannelsForTest();

    // After bootstrap the cache is populated. We then drop the cache
    // entry to simulate a stale-cache / missed-prewarm state and verify
    // that reading via the accessor does NOT silently re-populate it.
    // A pure read returns the localStorage-decoded value (or defaults)
    // without writing back to the reactive map.
    const policiesBefore = { ...store.notificationPolicies };
    delete store.notificationPolicies['general'];
    const policy = store.getNotificationPolicy('general');

    // Returns the localStorage-decoded default (or {policy:'All', highlightWords:[]}).
    expect(policy).toEqual({ policy: 'All', highlightWords: [] });
    // The reactive cache entry is STILL missing - no lazy write happened.
    expect(store.notificationPolicies['general']).toBeUndefined();
    // And no other entries were touched.
    expect(Object.keys(store.notificationPolicies).sort()).toEqual(
      Object.keys(policiesBefore).filter((k) => k !== 'general').sort(),
    );
  });

  it('#bootstrapChannels pre-warms notificationPolicies for every bootstrapped channel', async () => {
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([
        { id: 'general', name: 'general' },
        { id: 'random', name: 'random' },
        { id: 'project-alpha', name: 'project-alpha' },
      ]),
    );
    await store._bootstrapChannelsForTest();

    expect(Object.keys(store.notificationPolicies).sort()).toEqual(
      ['general', 'project-alpha', 'random'],
    );
    // All default to the {All, []} policy when no localStorage entry exists.
    expect(store.notificationPolicies['general']).toEqual({
      policy: 'All',
      highlightWords: [],
    });
  });

  it('createChannel pre-warms notificationPolicies for the just-created channel', async () => {
    apiGetMock.mockResolvedValueOnce(makeBootstrapPayload([]));
    await store._bootstrapChannelsForTest();

    // Before create: empty.
    expect(store.notificationPolicies['phoenix']).toBeUndefined();
    store.createChannel('phoenix', 'roadmap chatter');
    // After create: pre-warmed.
    expect(store.notificationPolicies['phoenix']).toEqual({
      policy: 'All',
      highlightWords: [],
    });
    // getNotificationPolicy reads the cache WITHOUT writing.
    const before = { ...store.notificationPolicies };
    expect(store.getNotificationPolicy('phoenix')).toEqual({
      policy: 'All',
      highlightWords: [],
    });
    expect(store.notificationPolicies).toEqual(before);
  });

  it('joinChannel pre-warms notificationPolicies for the freshly-joined channel', async () => {
    apiGetMock.mockResolvedValueOnce(
      makeBootstrapPayload([
        // Non-member row in bootstrap.
        { id: 'side-room', name: 'side-room', member: false },
      ]),
    );
    await store._bootstrapChannelsForTest();
    expect(store.notificationPolicies['side-room']).toEqual({
      policy: 'All',
      highlightWords: [],
    });

    // Drop the entry to simulate a post-leave / post-clear state, then
    // call joinChannel and verify the pre-warm path re-populates.
    delete store.notificationPolicies['side-room'];
    mcpCallMock.mockResolvedValueOnce({ success: true });

    // Set ch.member = false so joinChannel actually runs the join path.
    store.channelsById['side-room'].member = false;
    const result = await store.joinChannel('side-room');
    expect(result.success).toBe(true);
    expect(store.notificationPolicies['side-room']).toEqual({
      policy: 'All',
      highlightWords: [],
    });
  });

  it('conversation_created system event pre-warms notificationPolicies for the new row', async () => {
    apiGetMock.mockResolvedValueOnce(makeBootstrapPayload([]));
    await store._bootstrapChannelsForTest();
    expect(store.notificationPolicies['from-peer']).toBeUndefined();

    // Synthesize a system/conversations 'created' event the way the
    // real MQTT path would: handle via the test hook.
    store._handleSystemEventForTest({
      type: 'conversation_created',
      id: 'from-peer',
      name: 'from-peer',
      topic: 'started by a peer',
      creator_key: 'someone-else',
      ts: '2026-05-20T14:30:00Z',
    });

    expect(store.channelsById['from-peer']).toBeTruthy();
    expect(store.notificationPolicies['from-peer']).toEqual({
      policy: 'All',
      highlightWords: [],
    });
  });

  it('getNotificationPolicy honours an existing localStorage entry on cache miss', async () => {
    // Pre-seed localStorage with a non-default policy. Read should
    // surface that policy WITHOUT writing to the reactive cache.
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        'cc:notif-policy:starboard',
        JSON.stringify({ policy: 'Mentions', highlightWords: ['ahoy'] }),
      );
    }
    const before = { ...store.notificationPolicies };
    const policy = store.getNotificationPolicy('starboard');
    expect(policy).toEqual({ policy: 'Mentions', highlightWords: ['ahoy'] });
    // No lazy write - cache is still untouched.
    expect(store.notificationPolicies).toEqual(before);
    expect(store.notificationPolicies['starboard']).toBeUndefined();
  });

  it('returns the default policy gracefully for unknown ids, empty strings, and non-string inputs', () => {
    const defaultPolicy = { policy: 'All', highlightWords: [] };
    expect(store.getNotificationPolicy('does-not-exist')).toEqual(defaultPolicy);
    expect(store.getNotificationPolicy('')).toEqual(defaultPolicy);
    expect(store.getNotificationPolicy(null)).toEqual(defaultPolicy);
    expect(store.getNotificationPolicy(undefined)).toEqual(defaultPolicy);
    expect(store.getNotificationPolicy(42)).toEqual(defaultPolicy);
    // No reactive cache pollution from any trivial-default return.
    expect(Object.keys(store.notificationPolicies)).toEqual([]);
  });

  it('source-level pin: getNotificationPolicy body contains no notificationPolicies assignment', () => {
    // Belt-and-suspenders pin. The pre-hotfix accessor had
    // ``this.notificationPolicies = {..., [channelId]: entry}`` in
    // its body - the exact $state mutation that tripped Svelte's
    // unsafe-mutation guard. We grep the source so a future refactor
    // cannot re-introduce a lazy write inside the accessor body
    // without this test failing first. Mirrors the equivalent pin
    // for v0.4.3's getChannelRole.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const STORE_SRC = resolve(HERE, '..', 'src', 'lib', 'mqtt-store.svelte.js');
    const src = readFileSync(STORE_SRC, 'utf8');
    const start = src.indexOf('\n  getNotificationPolicy(channelId) {\n');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('\n  }\n', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // The pure-read body must NOT assign to notificationPolicies
    // (any assignment trips state_unsafe_mutation when called from
    // a $derived context).
    expect(body).not.toMatch(/this\.notificationPolicies\s*=/);
    expect(body).not.toMatch(/this\.notificationPolicies\s*\[[^\]]+\]\s*=[^=]/);
    // Sanity: the body DOES read from notificationPolicies (so the
    // test isn't matching a different method by mistake).
    expect(body).toMatch(/this\.notificationPolicies\[/);
  });
});
