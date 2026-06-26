// Regression: messages loaded from REST history must not show a stuck
// "Sending..." spinner. The per-message `status` in the wire payload is the
// optimistic local-echo state ('sending'); 'sent' is only ever set by the live
// publish callback in the originating session. On reload, #fetchHistory pulls
// past messages from /api/messages carrying status:'sending' with no PUBACK to
// advance them — so without normalization your own past messages render a
// permanent spinner. #fetchHistory now maps a stale 'sending' to 'sent'.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
  mcpCall: vi.fn(),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

const SELF = '0123abcd';

function makeStore() {
  const s = new MqttChatStore();
  s.userProfile.key = SELF;
  s.userProfile.name = 'me';
  s.userProfile.type = 'human';
  return s;
}

function mockHistory(messages) {
  global.fetch = vi.fn(async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes('/api/messages/') ? { messages } : { participants: [] },
  }));
}

// Poll for the async ``#fetchHistory`` result instead of racing a single
// fixed delay: ``switchChannel`` kicks off the history fetch fire-and-forget,
// so under suite load a one-shot 10ms wait was occasionally too short and the
// message had not landed yet (intermittent "expected undefined to be truthy").
// This waits up to a generous deadline but returns as soon as the row appears.
async function waitForMessage(store, id, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const m = store.messages.find((x) => x.id === id);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 5));
  }
  return store.messages.find((x) => x.id === id);
}

describe('#fetchHistory status normalization', () => {
  let origFetch;
  beforeEach(() => {
    origFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = origFetch;
    vi.clearAllMocks();
  });

  test('stale "sending" from history reload becomes "sent" (no stuck spinner)', async () => {
    const store = makeStore();
    mockHistory([
      {
        id: 'h1',
        ts: '2026-05-06T10:00:00-05:00',
        sender: { key: SELF, name: 'me', type: 'human' },
        body: 'hi',
        status: 'sending',
        conv: 'testchan',
        reply_to: null,
      },
    ]);

    store.switchChannel('testchan');
    const m = await waitForMessage(store, 'h1');

    expect(m).toBeTruthy();
    expect(m.status).toBe('sent');
  });

  test('non-sending status passes through unchanged', async () => {
    const store = makeStore();
    mockHistory([
      {
        id: 'h2',
        ts: '2026-05-06T10:00:00-05:00',
        sender: { key: 'other123', name: 'o', type: 'claude' },
        body: 'yo',
        conv: 'testchan',
        reply_to: null,
      },
    ]);

    store.switchChannel('testchan');
    const m = await waitForMessage(store, 'h2');

    expect(m).toBeTruthy();
    expect(m.status).toBeUndefined();
  });
});
