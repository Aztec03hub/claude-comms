// web-thread-visibility fix — threaded replies must be visible AND
// openable from the MAIN chat feed.
//
// Two layers are pinned here:
//
//   A. Store normalization (`MqttChatStore.activeMessages`):
//      A root message can carry its thread metadata in any of three
//      shapes and the feed must surface a reply count + last author
//      regardless of which path delivered it:
//        1. flat `thread_reply_count` / `thread_last_author` (the
//           `/api/messages` REST path returns the broker's flat fields);
//        2. a `thread_summary: {reply_count, last_ts, last_author}`
//           object (the `comms_read(top_level_only=True)` MCP path);
//        3. live replies pushed onto `store.messages` over MQTT AFTER
//           the root loaded (the broker never re-pushes the root, so the
//           client must count local replies itself — live increment).
//      `activeMessages` reconciles all three onto the flat
//      `thread_reply_count` / `thread_last_author` fields that
//      MessageBubble reads.
//
//   B. MessageBubble rendering + click:
//      Given a root with a reply count, the prominent thread indicator
//      (`data-testid="thread-indicator"`) renders, shows the count + last
//      author, and clicking it invokes `onOpenThread(message)` — the
//      callback App wires to open ThreadPanel.
//
// No em dashes in user-facing assertion text (Standing Rule §I.6 #11).

import { describe, it, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

// ── Store-layer harness (mirrors tests/intersection-observer-unread.spec.js) ──
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
import MessageBubble from '../src/components/MessageBubble.svelte';

const SELF = '0123abcd';
const EMBER = 'e1f2a3b4';

function chanRow(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: '',
    member: true,
    memberCount: 1,
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
  store.userProfile.key = SELF;
  store.userProfile.name = 'me';
  store.userProfile.type = 'human';
  return store;
}

// One-shot snapshot of the `store.activeMessages` `$derived.by` getter.
// Reading a derived outside a tracking scope computes it lazily against
// the current `$state`, which is exactly what we want for an assertion
// after a synchronous `store.messages` / `store.activeChannel` write.
// (Runes can't be used in a `.spec.js` file, so no `$effect.root` here.)
function readActiveMessages(store) {
  return store.activeMessages;
}

function rootMsg(overrides = {}) {
  return {
    id: 'root-1',
    channel: 'general',
    reply_to: null,
    ts: '2026-06-23T12:00:00.000Z',
    sender: { key: EMBER, name: 'ember', type: 'claude' },
    body: 'kick off the thread',
    ...overrides,
  };
}

function replyMsg(overrides = {}) {
  return {
    id: 'reply-1',
    channel: 'general',
    reply_to: 'root-1',
    ts: '2026-06-23T12:05:00.000Z',
    sender: { key: SELF, name: 'me', type: 'human' },
    body: 'a reply',
    ...overrides,
  };
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

// ── A. Store normalization ───────────────────────────────────────────────

describe('activeMessages — thread field normalization', () => {
  it('maps flat thread_reply_count / thread_last_author onto the root', async () => {
    const store = makeStore();
    await bootstrapWith(store, [chanRow()]);
    store.activeChannel = 'general';
    store.messages = [
      rootMsg({ thread_reply_count: 3, thread_last_author: 'ember' }),
    ];

    const out = readActiveMessages(store);
    expect(out).toHaveLength(1);
    expect(out[0].thread_reply_count).toBe(3);
    expect(out[0].thread_last_author).toBe('ember');
  });

  it('maps a thread_summary object onto the flat fields MessageBubble reads', async () => {
    const store = makeStore();
    await bootstrapWith(store, [chanRow()]);
    store.activeChannel = 'general';
    // The `comms_read(top_level_only=True)` shape: NO flat fields, only
    // a thread_summary. Pre-fix this rendered no indicator.
    store.messages = [
      rootMsg({
        thread_reply_count: undefined,
        thread_last_author: undefined,
        thread_summary: { reply_count: 2, last_ts: 'x', last_author: 'sage' },
      }),
    ];

    const out = readActiveMessages(store);
    expect(out[0].thread_reply_count).toBe(2);
    expect(out[0].thread_last_author).toBe('sage');
  });

  it('counts live MQTT replies even with no server-reported count (live increment)', async () => {
    const store = makeStore();
    await bootstrapWith(store, [chanRow()]);
    store.activeChannel = 'general';
    // Root has NO thread metadata; a reply lands live in store.messages.
    store.messages = [rootMsg(), replyMsg({ sender: { key: EMBER, name: 'ember', type: 'claude' } })];

    const out = readActiveMessages(store);
    const root = out.find(m => m.id === 'root-1');
    expect(root.thread_reply_count).toBe(1);
    expect(root.thread_last_author).toBe('ember');
  });

  it('takes the max of server count and local replies (live overtakes stale)', async () => {
    const store = makeStore();
    await bootstrapWith(store, [chanRow()]);
    store.activeChannel = 'general';
    // Server said 1; two replies are actually present locally.
    store.messages = [
      rootMsg({ thread_reply_count: 1, thread_last_author: 'ember' }),
      replyMsg({ id: 'reply-1', ts: '2026-06-23T12:05:00.000Z' }),
      replyMsg({ id: 'reply-2', ts: '2026-06-23T12:06:00.000Z', sender: { key: EMBER, name: 'ember', type: 'claude' } }),
    ];

    const out = readActiveMessages(store);
    const root = out.find(m => m.id === 'root-1');
    expect(root.thread_reply_count).toBe(2);
    // Freshest local reply wins for last author.
    expect(root.thread_last_author).toBe('ember');
  });

  it('leaves a childless root untouched (no indicator data)', async () => {
    const store = makeStore();
    await bootstrapWith(store, [chanRow()]);
    store.activeChannel = 'general';
    store.messages = [rootMsg()];

    const out = readActiveMessages(store);
    expect(out[0].thread_reply_count).toBeFalsy();
  });
});

// ── B. MessageBubble rendering + click ───────────────────────────────────

const PARTICIPANTS = {
  [SELF]: { key: SELF, name: 'me', type: 'human', connections: {} },
  [EMBER]: { key: EMBER, name: 'ember', type: 'claude', connections: {} },
};

function renderBubble(message, onOpenThread = () => {}) {
  return render(MessageBubble, {
    props: {
      message,
      currentUser: { key: SELF, name: 'me', type: 'human' },
      participants: PARTICIPANTS,
      consecutive: false,
      onOpenThread,
      onContextMenu: () => {},
      onShowProfile: () => {},
      onReact: () => {},
      onMore: () => {},
    },
  });
}

describe('MessageBubble — thread indicator render + open', () => {
  test('renders the indicator when a root carries thread_reply_count (REST flat path)', () => {
    const message = rootMsg({ thread_reply_count: 3, thread_last_author: 'ember' });
    const { getByTestId } = renderBubble(message);

    const indicator = getByTestId('thread-indicator');
    expect(indicator).not.toBeNull();
    expect(indicator.textContent).toContain('3 replies');
    expect(indicator.textContent).toContain('@ember');
    // Accessible + obviously clickable.
    expect(indicator.getAttribute('role')).toBe('button');
    expect(indicator.getAttribute('tabindex')).toBe('0');
  });

  test('renders singular "reply" for a single reply', () => {
    const message = rootMsg({ thread_reply_count: 1, thread_last_author: 'ember' });
    const { getByTestId } = renderBubble(message);
    expect(getByTestId('thread-indicator').textContent).toContain('1 reply');
  });

  test('does NOT render the indicator for a childless root', () => {
    const { queryByTestId } = renderBubble(rootMsg());
    expect(queryByTestId('thread-indicator')).toBeNull();
  });

  test('clicking the indicator calls onOpenThread with the message', async () => {
    const message = rootMsg({ thread_reply_count: 2, thread_last_author: 'ember' });
    const onOpenThread = vi.fn();
    const { getByTestId } = renderBubble(message, onOpenThread);

    await fireEvent.click(getByTestId('thread-indicator'));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith(message);
  });

  test('pressing Enter on the indicator calls onOpenThread', async () => {
    const message = rootMsg({ thread_reply_count: 2, thread_last_author: 'ember' });
    const onOpenThread = vi.fn();
    const { getByTestId } = renderBubble(message, onOpenThread);

    await fireEvent.keyDown(getByTestId('thread-indicator'), { key: 'Enter' });
    expect(onOpenThread).toHaveBeenCalledWith(message);
  });
});
