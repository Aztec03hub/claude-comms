// Integration tests for ChatView.svelte after the v0.4.2 Step 3.2/3.7
// rewrite that mounts ChatHeader at top and inserts UnreadDivider between
// last-read and first-unread messages.
//
// What this suite pins:
//
//   1. Wave C IntersectionObserver wiring still attaches to every
//      `[data-message-id]` element after the new mount points land.
//      The UnreadDivider does NOT carry that attribute, so the observer
//      ignores it.
//
//   2. ChatHeader mounts only when `showChatHeader` is true (back-compat
//      with App.svelte-owned header during the v0.4.2 transition).
//
//   3. UnreadDivider appears in the message list at the correct position
//      (right BEFORE the first message whose id matches
//      `activeChannelMeta.unreadFrom`) when both cursor and count > 0.
//
//   4. UnreadDivider stays hidden when the unread cursor points at a
//      message not present in the current viewport, or when the unread
//      count is 0.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// ── safe rAF + IntersectionObserver spy double ─────────────────────────
//
// ChatView's auto-scroll $effect schedules a `requestAnimationFrame`
// callback that reads `messagesEl.scrollHeight` — when the component
// unmounts (test cleanup) between the rAF being scheduled and the
// callback firing, the bound ref nulls and the rAF throws into the
// JSDOM global handler. Install a safe rAF wrapper at module top level
// (same pattern as prop-drilling.spec.js).
{
  const realRAF =
    globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 16));
  const safeRAF = (cb) =>
    realRAF((ts) => {
      try {
        cb(ts);
      } catch {
        /* swallow teardown-race throws */
      }
    });
  globalThis.requestAnimationFrame = safeRAF;
  if (typeof window !== 'undefined') window.requestAnimationFrame = safeRAF;
}

// IntersectionObserver spy: records every element passed to observe()
// across all instances created during a single test. Reset per-test in
// beforeEach so assertions stay deterministic.
let observedTargets = [];
let observerInstances = [];

class FakeIntersectionObserver {
  constructor(cb, opts) {
    this.cb = cb;
    this.opts = opts;
    this.targets = [];
    observerInstances.push(this);
  }
  observe(el) {
    this.targets.push(el);
    observedTargets.push(el);
  }
  unobserve(_el) {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver = FakeIntersectionObserver;

// ChatView import happens AFTER the rAF + IntersectionObserver shims
// land so the module-level imports see the safe globals.
import ChatView from '../src/components/ChatView.svelte';

// ── Test harness ───────────────────────────────────────────────────────

function makeMessage(id, sender = 'alice', overrides = {}) {
  const idx = parseInt(id.replace(/\D/g, ''), 10) || 0;
  return {
    id,
    body: `body of ${id}`,
    ts: 1_700_000_000_000 + idx * 1000,
    sender: { type: 'human', key: sender, name: sender },
    reactions: {},
    thread_count: 0,
    read_by: [],
    ...overrides,
  };
}

function makeStore({
  activeMessages = [],
  activeChannelMeta = null,
  markSeen = vi.fn(),
} = {}) {
  return {
    activeMessages,
    activeChannelMeta,
    markSeen,
  };
}

function makeProps(overrides = {}) {
  return {
    messages: [],
    currentUser: { key: 'me', name: 'Me', type: 'human' },
    participants: {
      me: { key: 'me', name: 'Me', type: 'human' },
      alice: { key: 'alice', name: 'alice', type: 'human' },
      bob: { key: 'bob', name: 'bob', type: 'human' },
    },
    onOpenThread: vi.fn(),
    onContextMenu: vi.fn(),
    onShowProfile: vi.fn(),
    onReact: vi.fn(),
    onRetryMessage: vi.fn(),
    store: null,
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await tick();
  // The observer is wired inside a requestAnimationFrame callback; jsdom
  // schedules rAF on the next macrotask, so we drain that too.
  await new Promise((r) => setTimeout(r, 20));
  await tick();
}

beforeEach(() => {
  observedTargets = [];
  observerInstances = [];
});

afterEach(() => {
  cleanup();
});

// ── 1. IntersectionObserver preservation ───────────────────────────────

describe('ChatView — Wave C IntersectionObserver wiring preserved', () => {
  it('observes every [data-message-id] element after ChatHeader mount', async () => {
    const msgs = [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')];
    const store = makeStore({
      activeMessages: msgs,
      activeChannelMeta: {
        id: 'general',
        name: 'general',
        topic: 'hi',
        memberCount: 3,
        unread: 0,
        unreadFrom: null,
      },
    });
    const props = makeProps({
      store,
      showChatHeader: true,
      currentUserRole: 'owner',
    });

    const { container } = render(ChatView, props);
    await flush();

    // All three message bubbles must be in the DOM …
    const bubbleEls = container.querySelectorAll('[data-message-id]');
    expect(bubbleEls.length).toBeGreaterThanOrEqual(3);

    // … and the observer must have been handed each of their ids.
    const observedIds = observedTargets
      .map((el) => el.dataset?.messageId)
      .filter(Boolean);
    expect(observedIds).toContain('m1');
    expect(observedIds).toContain('m2');
    expect(observedIds).toContain('m3');
  });

  it('UnreadDivider does NOT receive a data-message-id (observer ignores it)', async () => {
    const msgs = [
      makeMessage('m1'),
      makeMessage('m2', 'bob'),
      makeMessage('m3', 'bob'),
    ];
    const store = makeStore({
      activeMessages: msgs,
      activeChannelMeta: {
        id: 'general',
        name: 'general',
        topic: '',
        memberCount: 3,
        unread: 2,
        unreadFrom: 'm2',
      },
    });
    const props = makeProps({ store });

    const { queryByTestId } = render(ChatView, props);
    await flush();

    const divider = queryByTestId('unread-divider');
    expect(divider).not.toBeNull();
    expect(divider.getAttribute('data-message-id')).toBeNull();
    // And the observer was not handed the divider element.
    expect(observedTargets).not.toContain(divider);
  });
});

// ── 2. ChatHeader mount gating ─────────────────────────────────────────

describe('ChatView — ChatHeader mount gating', () => {
  it('does NOT mount ChatHeader by default (back-compat with App.svelte header)', async () => {
    const store = makeStore({
      activeMessages: [],
      activeChannelMeta: {
        id: 'general',
        name: 'general',
        topic: 'hi',
        memberCount: 3,
        unread: 0,
        unreadFrom: null,
      },
    });
    const props = makeProps({ store }); // showChatHeader omitted → false
    const { queryByTestId } = render(ChatView, props);
    await flush();
    expect(queryByTestId('chat-header-new')).toBeNull();
  });

  it('mounts ChatHeader when showChatHeader=true and activeChannelMeta is non-null', async () => {
    const store = makeStore({
      activeMessages: [],
      activeChannelMeta: {
        id: 'general',
        name: 'general',
        topic: 'hi',
        memberCount: 3,
        unread: 0,
        unreadFrom: null,
      },
    });
    const props = makeProps({ store, showChatHeader: true });
    const { queryByTestId } = render(ChatView, props);
    await flush();
    expect(queryByTestId('chat-header-new')).not.toBeNull();
    // And the channel name is rendered.
    expect(queryByTestId('chat-header-name').textContent.trim()).toBe('general');
  });
});

// ── 3. UnreadDivider positioning ───────────────────────────────────────

describe('ChatView — UnreadDivider positioning', () => {
  it('renders UnreadDivider when unreadFrom is present and unread > 0', async () => {
    // Three messages; cursor points at m2.
    const m1 = makeMessage('m1', 'alice');
    const m2 = makeMessage('m2', 'bob');
    const m3 = makeMessage('m3', 'bob');
    const store = makeStore({
      activeMessages: [m1, m2, m3],
      activeChannelMeta: {
        id: 'general',
        name: 'general',
        topic: '',
        memberCount: 3,
        unread: 2,
        unreadFrom: 'm2',
      },
    });
    const props = makeProps({ store });

    const { container, queryByTestId } = render(ChatView, props);
    await flush();

    const divider = queryByTestId('unread-divider');
    expect(divider).not.toBeNull();

    // Divider precedes the bubble for m2 in document order.
    const m2Bubble = container.querySelector('[data-message-id="m2"]');
    expect(m2Bubble).not.toBeNull();
    const dividerPos = divider.compareDocumentPosition(m2Bubble);
    // FOLLOWING flag = 4 → m2Bubble comes AFTER divider in source order.
    expect(dividerPos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // And the divider follows the bubble for m1.
    const m1Bubble = container.querySelector('[data-message-id="m1"]');
    expect(m1Bubble).not.toBeNull();
    const dividerVsM1 = m1Bubble.compareDocumentPosition(divider);
    expect(dividerVsM1 & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Label reflects the unread count.
    expect(queryByTestId('unread-divider-label').textContent.trim()).toBe('2 new');
  });

  it('stays hidden when unreadFrom points at a message not in the current viewport', async () => {
    const store = makeStore({
      activeMessages: [makeMessage('m1'), makeMessage('m2')],
      activeChannelMeta: {
        id: 'general',
        name: 'general',
        topic: '',
        memberCount: 3,
        unread: 3,
        unreadFrom: 'm99-not-in-viewport',
      },
    });
    const props = makeProps({ store });

    const { queryByTestId } = render(ChatView, props);
    await flush();

    expect(queryByTestId('unread-divider')).toBeNull();
  });

  it('hides when unread count drops to 0 even if unreadFrom is set', async () => {
    const store = makeStore({
      activeMessages: [makeMessage('m1'), makeMessage('m2')],
      activeChannelMeta: {
        id: 'general',
        name: 'general',
        topic: '',
        memberCount: 3,
        unread: 0,
        unreadFrom: 'm2',
      },
    });
    const props = makeProps({ store });

    const { queryByTestId } = render(ChatView, props);
    await flush();

    expect(queryByTestId('unread-divider')).toBeNull();
  });
});
