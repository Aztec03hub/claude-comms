// v0.4.0 Step 2.5 — channel bootstrap from /api/conversations (S-FIX web).
//
// The store no longer ships with a hardcoded seed channels list. Instead,
// `connect()` calls `/api/conversations` after the MQTT broker handshake
// and populates `channels` from the daemon's authoritative response.
//
// These tests cover the four edge cases the architecture spec calls out:
//   1. 0 rows → channels stays empty; sidebar derivations are empty.
//   2. Populated rows → channels mirrors the payload with the camelCase
//      `my`-prefix → unprefixed rename (myUnread → unread, etc.).
//   3. 404 / 500 → `serverUnreachable` flips true; channels stays empty.
//   4. No hardcoded seed survives anywhere in the store source.
//
// The bootstrap helper is exercised via a test seam
// (`_bootstrapChannelsForTest`) that calls the private `#bootstrapChannels`
// without needing a live broker. We mock `lib/api.js`'s `apiGet` so the
// daemon does not need to be running.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Hoisted mock for the api module so the store imports the mocked helpers.
const apiGetMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: (...args) => apiGetMock(...args),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
}));

// Imported AFTER the mock so the module picks up the mocked apiGet.
const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_SRC_PATH = resolve(HERE, '..', 'src', 'lib', 'mqtt-store.svelte.js');

describe('MqttChatStore — v0.4.0 Step 2.5 bootstrap from /api/conversations', () => {
  /** @type {InstanceType<typeof MqttChatStore>} */
  let store;

  beforeEach(() => {
    apiGetMock.mockReset();
    store = new MqttChatStore();
    // The store ships with an empty channels array now — assert the
    // pre-bootstrap state so we know the seed deletion landed.
    expect(store.channels).toEqual([]);
    expect(store.serverUnreachable).toBe(false);
  });

  it('starts with an empty channels array (no hardcoded seed)', () => {
    // No `general`, `random`, `project-alpha`, `lora-training`, etc.
    expect(store.channels).toHaveLength(0);
    // None of the prior seed ids leak in.
    const ids = store.channels.map((c) => c.id);
    expect(ids).not.toContain('general');
    expect(ids).not.toContain('random');
    expect(ids).not.toContain('project-alpha');
    expect(ids).not.toContain('lora-training');
  });

  it('0-row payload → channels stays empty, derivations are empty', async () => {
    apiGetMock.mockResolvedValueOnce([]);

    await store._bootstrapChannelsForTest();

    expect(apiGetMock).toHaveBeenCalledWith('/api/conversations');
    expect(store.channels).toEqual([]);
    expect(store.starredChannels).toEqual([]);
    expect(store.activeChannelMeta).toBeUndefined();
    expect(store.serverUnreachable).toBe(false);
  });

  it('populated payload → channels mirrors rows with my→unprefixed rename', async () => {
    const wireRows = [
      {
        id: 'general',
        name: 'general',
        topic: 'Main discussion',
        member: true,
        memberCount: 4,
        lastActivity: '2026-05-12T15:30:00Z',
        mode: 'public',
        visibility: 'listed',
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'phil-mcp',
        myUnread: 3,
        myStarred: true,
        myMuted: false,
      },
      {
        id: 'random',
        name: 'random',
        topic: 'Off-topic',
        member: false,
        memberCount: 1,
        lastActivity: null,
        mode: 'public',
        visibility: 'listed',
        createdAt: '2026-04-02T00:00:00Z',
        createdBy: 'phil-mcp',
        myUnread: 0,
        myStarred: false,
        myMuted: true,
      },
    ];
    apiGetMock.mockResolvedValueOnce(wireRows);

    await store._bootstrapChannelsForTest();

    expect(store.channels).toHaveLength(2);

    const general = store.channels.find((c) => c.id === 'general');
    expect(general).toBeTruthy();
    // Renamed fields land under the unprefixed names.
    expect(general.unread).toBe(3);
    expect(general.starred).toBe(true);
    expect(general.muted).toBe(false);
    // The wire `my`-prefix fields must NOT leak into the store-internal shape.
    expect(general.myUnread).toBeUndefined();
    expect(general.myStarred).toBeUndefined();
    expect(general.myMuted).toBeUndefined();
    // Other ChannelRow fields pass through as-is.
    expect(general.name).toBe('general');
    expect(general.topic).toBe('Main discussion');
    expect(general.member).toBe(true);
    expect(general.memberCount).toBe(4);
    expect(general.lastActivity).toBe('2026-05-12T15:30:00Z');
    expect(general.mode).toBe('public');
    expect(general.visibility).toBe('listed');
    expect(general.createdAt).toBe('2026-04-01T00:00:00Z');
    expect(general.createdBy).toBe('phil-mcp');
    // Archive fields default to non-archived when absent (Step 2.1 daemon
    // does not yet emit them; ChannelRow contract reserves the slots).
    expect(general.archived).toBe(false);
    expect(general.archived_at).toBeNull();
    expect(general.archived_by).toBeNull();

    const random = store.channels.find((c) => c.id === 'random');
    expect(random.muted).toBe(true);
    expect(random.starred).toBe(false);
    expect(random.unread).toBe(0);

    // starredChannels derivation picks up only `general`.
    expect(store.starredChannels.map((c) => c.id)).toEqual(['general']);
    // serverUnreachable cleared on a successful bootstrap.
    expect(store.serverUnreachable).toBe(false);
  });

  it('404 response → serverUnreachable=true, channels stays empty', async () => {
    // apiGet throws on non-2xx with an Error that carries `.status`.
    const err = Object.assign(new Error('HTTP 404'), { status: 404 });
    apiGetMock.mockRejectedValueOnce(err);

    await store._bootstrapChannelsForTest();

    expect(store.channels).toEqual([]);
    expect(store.serverUnreachable).toBe(true);
    // No fallback to hardcoded seeds.
    const ids = store.channels.map((c) => c.id);
    expect(ids).not.toContain('general');
  });

  it('500 response → serverUnreachable=true, channels stays empty', async () => {
    const err = Object.assign(new Error('HTTP 500'), { status: 500 });
    apiGetMock.mockRejectedValueOnce(err);

    await store._bootstrapChannelsForTest();

    expect(store.channels).toEqual([]);
    expect(store.serverUnreachable).toBe(true);
  });

  it('network error → serverUnreachable=true, channels stays empty', async () => {
    apiGetMock.mockRejectedValueOnce(new TypeError('NetworkError: fetch failed'));

    await store._bootstrapChannelsForTest();

    expect(store.channels).toEqual([]);
    expect(store.serverUnreachable).toBe(true);
  });

  it('successful bootstrap after a failure clears the serverUnreachable flag', async () => {
    apiGetMock.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 500'), { status: 500 }),
    );
    await store._bootstrapChannelsForTest();
    expect(store.serverUnreachable).toBe(true);

    apiGetMock.mockResolvedValueOnce([
      {
        id: 'general',
        name: 'general',
        topic: '',
        member: true,
        memberCount: 1,
        lastActivity: null,
        mode: 'public',
        visibility: 'listed',
        createdAt: null,
        createdBy: null,
        myUnread: 0,
        myStarred: false,
        myMuted: false,
      },
    ]);
    await store._bootstrapChannelsForTest();

    expect(store.serverUnreachable).toBe(false);
    expect(store.channels).toHaveLength(1);
    expect(store.channels[0].id).toBe('general');
  });

  it('tolerates a wrapped { conversations: [...] } envelope', async () => {
    apiGetMock.mockResolvedValueOnce({
      conversations: [
        {
          id: 'wrapped',
          name: 'wrapped',
          topic: 'env',
          member: false,
          memberCount: 0,
          mode: 'public',
          visibility: 'listed',
          myUnread: 7,
          myStarred: false,
          myMuted: false,
        },
      ],
    });

    await store._bootstrapChannelsForTest();

    expect(store.channels).toHaveLength(1);
    expect(store.channels[0].id).toBe('wrapped');
    expect(store.channels[0].unread).toBe(7);
  });

  it('defends against partial / missing fields with safe defaults', async () => {
    apiGetMock.mockResolvedValueOnce([
      { id: 'sparse' },
      null,
      { id: 'archived-row', archived: true, archived_by: 'phil', archived_at: '2026-05-12T00:00:00Z' },
    ]);

    await store._bootstrapChannelsForTest();

    expect(store.channels).toHaveLength(3);

    const sparse = store.channels.find((c) => c.id === 'sparse');
    expect(sparse.topic).toBe('');
    expect(sparse.member).toBe(false);
    expect(sparse.memberCount).toBe(0);
    expect(sparse.mode).toBe('public');
    // v0.4.2 Wave C [VERIFY-3.6b-2]: default visibility tightened from
    // legacy 'listed' to the 3.6b-pinned 'public' wire value.
    expect(sparse.visibility).toBe('public');
    expect(sparse.unread).toBe(0);
    expect(sparse.starred).toBe(false);
    expect(sparse.muted).toBe(false);
    expect(sparse.archived).toBe(false);
    expect(sparse.archived_at).toBeNull();
    expect(sparse.archived_by).toBeNull();

    // The `null` row is handled gracefully (default id='').
    const nullRow = store.channels[1];
    expect(nullRow.id).toBe('');
    expect(nullRow.archived).toBe(false);

    const archived = store.channels.find((c) => c.id === 'archived-row');
    expect(archived.archived).toBe(true);
    expect(archived.archived_by).toBe('phil');
    expect(archived.archived_at).toBe('2026-05-12T00:00:00Z');
  });

  it('source assertion: no hardcoded seed array literal in connect()', () => {
    // Read the store source directly to assert the hardcoded seed list
    // (general / random / project-alpha / lora-training) is gone. This
    // is a defense-in-depth check on top of the runtime assertions
    // above — if a future refactor re-introduces a seed via a fixture
    // import, runtime tests might pass but source would still ship the
    // bad pattern.
    const src = readFileSync(STORE_SRC_PATH, 'utf-8');

    // The seed channels used pre-v0.4.0. None should appear as object
    // literals in the source anymore. We grep for the topic strings
    // (and unique ids) that were unique to the seed.
    expect(src).not.toContain("'project-alpha'");
    expect(src).not.toContain("'lora-training'");
    expect(src).not.toContain('Main discussion channel for the team');
    expect(src).not.toContain('Project Alpha development');
    expect(src).not.toContain('LoRA training runs and results');
    expect(src).not.toContain('Off-topic and fun');

    // Behavioral coverage of the no-seed-data invariant is provided by the
    // runtime bootstrapping tests above (channelsById starts empty and is
    // populated only from the daemon API payload).
  });
});
