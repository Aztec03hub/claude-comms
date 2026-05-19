// v0.4.2 Step 3.10 - mention-dot invariant on muted channels (Design Spec §8.2).
//
// What this file pins
// ───────────────────
// The Design Spec §8.2 invariant: a muted channel STILL surfaces a
// mention dot (and the underlying ``unreadHasMention`` flag) when an
// incoming message ``@mentions`` the current user. Mute suppresses
// notification volume + reduces row opacity; it does NOT hide
// mention-bearing unread. This was designed into v0.4.0 but only
// the bootstrap path (``checkChannels``) actually raised the flag,
// so live MQTT messages silently bumped ``unread`` without ever
// flipping the mention bit. Step 3.10 closes that gap in
// ``#handleChatMessage`` and locks the behavior with these tests.
//
// What this file does NOT pin (yet)
// ─────────────────────────────────
// Step 3.9 (per-channel notification policy with "All/Mentions/Off")
// has not landed (Wave E/G work). The "Only mentions" policy
// interaction with muted-but-mentioned therefore can't be exercised
// here; that needs a follow-up test once 3.9 ships. The current toast
// handler in App.svelte short-circuits on ``ch.muted`` regardless of
// mention status (line ~403), which is a pre-existing Design Spec §8.2
// gap surfaced as ``[VERIFY]`` in the worklog for Wave G.
//
// What we exercise
// ────────────────
//   1. Store-layer derivation: ``#handleChatMessage`` raises
//      ``unreadHasMention`` when the incoming wire ``msg.mentions``
//      includes the caller's participant key, even when the channel
//      is muted and even when ``channel !== activeChannel``.
//   2. SidebarChannelRow rendering: the row renders the mention-dot
//      variant when ``unreadHasMention && unread > 0``, regardless of
//      ``muted`` (Phil's invariant from Design Spec §8.2).
//   3. Control cases: ordinary (non-mention) messages on muted
//      channels bump ``unread`` but DO NOT raise the mention dot.
//   4. Bootstrap path: ``checkChannels`` ALSO raises ``unreadHasMention``
//      from the wire ``latest.mentions`` list on muted channels.
//
// Test seam
// ─────────
// We added ``_handleChatMessageForTest(channel, msg)`` to the store
// (mirrors the existing ``_handleSystemEventForTest`` / ``_bootstrap
// ChannelsForTest`` seams) so we can drive the live-message dispatch
// path without standing up an MQTT broker. The seam is a one-liner
// that forwards into the private ``#handleChatMessage``; production
// callers (``sendMessage`` echo, forward, and MQTT dispatch) are
// untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

// Hoisted mocks: ``apiGet`` drives bootstrap, ``mcpCall`` is what
// ``checkChannels`` invokes. Pattern mirrors
// ``tests/mqtt-store-comms-check.spec.js``.
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
const SidebarChannelRow = (
  await import('../src/components/SidebarChannelRow.svelte')
).default;

const SELF_KEY = '0123abcd';
const OTHER_KEY = 'beefcafe';

// Wire-row builder matching the Step 2.1 ``ChannelRow`` shape that
// ``_bootstrapChannelsForTest`` consumes.
function row(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: '',
    member: true,
    memberCount: 2,
    lastActivity: null,
    mode: 'public',
    visibility: 'public',
    createdAt: null,
    createdBy: null,
    myUnread: 0,
    unreadHasMention: false,
    myStarred: false,
    myMuted: false,
    ...overrides,
  };
}

async function bootstrapWith(store, rows) {
  apiGetMock.mockResolvedValueOnce(rows);
  await store._bootstrapChannelsForTest();
}

function makeStore() {
  const store = new MqttChatStore();
  store.userProfile.key = SELF_KEY;
  store.userProfile.name = 'me';
  store.userProfile.type = 'human';
  return store;
}

// Synthesize an incoming-message payload as it would arrive on the
// MQTT topic ``claude-comms/conv/{id}/messages``. The store's
// ``#handleChatMessage`` doesn't care about field ordering, only that
// ``id`` is unique (for dedupe) and ``mentions`` is a list of keys.
function makeIncoming(overrides = {}) {
  return {
    id: 'msg-' + Math.random().toString(16).slice(2, 10),
    ts: new Date().toISOString(),
    sender: { key: OTHER_KEY, name: 'them', type: 'human' },
    body: 'hi',
    mentions: null,
    ...overrides,
  };
}

// SidebarChannelRow fixture helper - mirrors the pattern in
// ``tests/sidebar-channel-row.spec.js``. We hand the row a fully
// populated channel object so no field is undefined at render time.
function makeChannel(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: 'Main channel',
    member: true,
    memberCount: 3,
    lastActivity: null,
    mode: 'public',
    visibility: 'listed',
    createdAt: null,
    createdBy: null,
    unread: 0,
    unreadHasMention: false,
    unreadFrom: null,
    starred: false,
    muted: false,
    muteLevel: 'off',
    archived: false,
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function renderRow(props = {}) {
  return render(SidebarChannelRow, {
    props: {
      channel: makeChannel(),
      isActive: false,
      sectionVariant: 'active',
      onClick: vi.fn(),
      onContextMenu: vi.fn(),
      onStarToggle: vi.fn(),
      ...props,
    },
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  mcpCallMock.mockResolvedValue({ success: true, payload: {} });
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    /* jsdom may not provide localStorage */
  }
});

afterEach(() => {
  cleanup();
});

// ── Store: live-message derivation ─────────────────────────────────

describe('Step 3.10 - store raises unreadHasMention from live mention messages', () => {
  it('mention + muted: live message sets unreadHasMention=true on the channel', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: true })]);

    // Sanity: bootstrap-side flags are off, channel is muted.
    expect(store.channelsById.general.muted).toBe(true);
    expect(store.channelsById.general.unreadHasMention).toBe(false);
    expect(store.channelsById.general.unread).toBe(0);

    // Active channel is NOT general - the unread-bump path only fires
    // when the message arrives on a non-active channel, mirroring the
    // production guard at #handleChatMessage's "channel !== activeChannel"
    // branch.
    store.activeChannel = 'somewhere-else';

    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: [SELF_KEY] }),
    );

    expect(store.channelsById.general.unreadHasMention).toBe(true);
    expect(store.channelsById.general.unread).toBe(1);
  });

  it('ordinary + muted: live message bumps unread but leaves unreadHasMention=false', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: true })]);
    store.activeChannel = 'somewhere-else';

    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: null }),
    );

    expect(store.channelsById.general.unread).toBe(1);
    expect(store.channelsById.general.unreadHasMention).toBe(false);
  });

  it('mention + unmuted (control): live message sets unreadHasMention=true', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: false })]);
    store.activeChannel = 'somewhere-else';

    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: [SELF_KEY] }),
    );

    expect(store.channelsById.general.muted).toBe(false);
    expect(store.channelsById.general.unreadHasMention).toBe(true);
    expect(store.channelsById.general.unread).toBe(1);
  });

  it('mention list does NOT include self: unreadHasMention stays false', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: true })]);
    store.activeChannel = 'somewhere-else';

    // ``mentions`` carries a different key - someone else was tagged.
    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: [OTHER_KEY] }),
    );

    expect(store.channelsById.general.unread).toBe(1);
    expect(store.channelsById.general.unreadHasMention).toBe(false);
  });

  it('mentions=[] empty list (no one tagged): unreadHasMention stays false', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: true })]);
    store.activeChannel = 'somewhere-else';

    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: [] }),
    );

    expect(store.channelsById.general.unread).toBe(1);
    expect(store.channelsById.general.unreadHasMention).toBe(false);
  });

  it('multiple mention messages: dot stays raised across successive arrivals', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: true })]);
    store.activeChannel = 'somewhere-else';

    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: [SELF_KEY] }),
    );
    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: null }),
    );
    store._handleChatMessageForTest(
      'general',
      makeIncoming({ mentions: [SELF_KEY, OTHER_KEY] }),
    );

    expect(store.channelsById.general.unread).toBe(3);
    // Once raised, the flag persists until markAllRead/markMessageViewed
    // clears it - even an intervening ordinary message must not stomp it.
    expect(store.channelsById.general.unreadHasMention).toBe(true);
  });
});

// ── Store: bootstrap-path derivation (already shipped pre-3.10) ────

describe('Step 3.10 - checkChannels also raises unreadHasMention on muted channels', () => {
  it('comms_check latest.mentions including self: muted channel still raises the dot', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: true })]);

    mcpCallMock.mockReset();
    mcpCallMock.mockResolvedValueOnce({
      success: true,
      payload: {
        unread_summary: [
          {
            conversation: 'general',
            unread_count: 4,
            latest: {
              ts: '2026-05-19T05:00:00Z',
              mentions: [SELF_KEY],
            },
          },
        ],
      },
    });

    const result = await store.checkChannels();
    expect(result.success).toBe(true);

    expect(store.channelsById.general.muted).toBe(true);
    expect(store.channelsById.general.unread).toBe(4);
    expect(store.channelsById.general.unreadHasMention).toBe(true);
  });
});

// ── Rendering: SidebarChannelRow honors the §8.2 invariant ─────────

describe('Step 3.10 - SidebarChannelRow renders mention dot on muted channels', () => {
  it('mention + muted: renders row-mention-dot AND .muted class on the row', () => {
    const { getByTestId, queryByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({
        id: 'general',
        unread: 2,
        unreadHasMention: true,
        muted: true,
      }),
    });

    const rowEl = getByTestId('sidebar-channel-row-general');
    expect(rowEl.classList.contains('muted')).toBe(true);

    // The mention dot is visible despite the muted modifier - Design
    // Spec §8.2's hard invariant. The numeric badge is suppressed in
    // mention-dot mode.
    expect(getByTestId('row-mention-dot-general')).not.toBeNull();
    expect(queryByTestId('row-unread-badge-general')).toBeNull();
  });

  it('ordinary + muted: no dot, no numeric badge (mute suppresses ordinary unread visuals)', () => {
    // Per SidebarChannelRow line ~113 the dot only renders when
    // ``showUnreadBadge && unreadHasMention``; ``showUnreadBadge`` itself
    // is gated on the section variant. We assert the no-dot case here
    // and rely on the existing ``sidebar-channel-row.spec.js`` for the
    // full section-variant matrix.
    const { queryByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({
        id: 'general',
        unread: 5,
        unreadHasMention: false,
        muted: true,
      }),
    });

    expect(queryByTestId('row-mention-dot-general')).toBeNull();
  });
});
