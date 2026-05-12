// UX G-62 — pending-send queue + per-message delivery status tests.
//
// `MqttChatStore.sendMessage` should never silently drop a message when
// the broker is unreachable. The store maintains a bounded FIFO queue
// (`#pendingSends`, cap 100) of (topic, payload) tuples for outgoing
// messages composed while disconnected, drains it on the next
// `connect` event, and exposes a `retryMessage(id)` helper for any
// individual message that failed.
//
// These tests exercise the store with a stubbed `#client` so we don't
// need a live broker; we inject the mock via `#setClientForTesting` (a
// test-only seam we wrap with a small helper). The store's queue logic
// is deterministic and tests as plain JS.

import { describe, it, expect, beforeEach } from 'vitest';
import { MqttChatStore } from '../src/lib/mqtt-store.svelte.js';

/**
 * Build a minimal mqtt.js-like client stub. Records every `publish` call
 * for assertions. By default `publish` invokes its callback with
 * `(undefined)` for success; callers can override via `setPublishMode`.
 */
function makeFakeClient() {
  const published = [];
  let mode = 'success';
  return {
    published,
    setPublishMode(m) { mode = m; },
    publish(topic, payload, opts, cb) {
      published.push({ topic, payload, opts });
      if (typeof cb === 'function') {
        if (mode === 'error') {
          cb(new Error('simulated publish failure'));
        } else {
          cb();
        }
      }
    },
    // Surface methods the store may call that we don't care about in
    // these tests. No-ops keep the surface trivial.
    subscribe() {},
    on() {},
    end() {},
    reconnect() {},
    options: { reconnectPeriod: 0 },
  };
}

// Test seams used below (see `MqttChatStore._installTestClient` and
// `_drainPendingSendsForTest` in src/lib/mqtt-store.svelte.js):
//
//   - `_installTestClient(fakeClient, connected=true)` — wires the stub
//     mqtt.js-like client into the private `#client` slot and toggles
//     `this.connected`.
//   - `_drainPendingSendsForTest()` — invokes the real `#drainPendingSends`
//     helper, exactly as the production `'connect'` event callback does.
//   - `_pendingSendsLengthForTest()` — inspector for the private queue
//     length; used to assert the queue is bounded and drained.
//
// These seams are minimal accessors; the production publish + queue
// logic stays in the private methods.

describe('MqttChatStore — UX G-62 pending sends queue', () => {
  /** @type {MqttChatStore} */
  let store;

  beforeEach(() => {
    store = new MqttChatStore();
    // Give the store a known identity so sendMessage doesn't crash on
    // serialization. Real connect() would fill these from /api/identity.
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
  });

  it('queues outgoing messages when disconnected (does not publish)', () => {
    // Default state: connected=false, no #client. sendMessage should
    // local-echo + queue, but NOT crash and NOT silently disappear.
    expect(store.connected).toBe(false);

    store.sendMessage('hello while offline');

    // Local echo lands in messages array with status='sending'.
    const local = store.messages.find((m) => m.body === 'hello while offline');
    expect(local).toBeTruthy();
    expect(local.status).toBe('sending');

    // No client = nothing was published. The bubble remains 'sending'
    // until reconnect drains the queue.
    expect(local.status).not.toBe('sent');
    expect(local.status).not.toBe('failed');
  });

  it('drains queue in order on reconnect (via #drainPendingSends)', () => {
    // Send three while disconnected. All three get queued in #pendingSends.
    store.sendMessage('first');
    store.sendMessage('second');
    store.sendMessage('third');

    const ids = store.messages
      .filter((m) => ['first', 'second', 'third'].includes(m.body))
      .map((m) => m.id);
    expect(ids).toHaveLength(3);

    // All three are 'sending' and queued.
    for (const id of ids) {
      const msg = store.messages.find((m) => m.id === id);
      expect(msg.status).toBe('sending');
    }
    expect(store._pendingSendsLengthForTest()).toBe(3);

    // Simulate the broker becoming reachable: install fake client, set
    // connected=true, and trigger the real drain helper (mirroring what
    // the production `'connect'` callback does).
    const fake = makeFakeClient();
    store._installTestClient(fake, true);
    store._drainPendingSendsForTest();

    // Published topics arrived in the same order we sent them. The drain
    // is FIFO — `first` lands first, then `second`, then `third`.
    const bodies = fake.published.map((p) => JSON.parse(p.payload).body);
    expect(bodies).toEqual(['first', 'second', 'third']);

    // All three flipped to 'sent' via the publish callback.
    for (const id of ids) {
      const msg = store.messages.find((m) => m.id === id);
      expect(msg.status).toBe('sent');
    }

    // Queue is empty after drain.
    expect(store._pendingSendsLengthForTest()).toBe(0);
  });

  it('drops oldest entry when queue cap (100) is exceeded; oldest is marked failed', () => {
    // Send 101 messages while disconnected. Cap is 100; the first one
    // should be evicted and flipped to 'failed'.
    for (let i = 0; i < 101; i++) {
      store.sendMessage('msg-' + i);
    }

    const first = store.messages.find((m) => m.body === 'msg-0');
    const second = store.messages.find((m) => m.body === 'msg-1');
    const last = store.messages.find((m) => m.body === 'msg-100');

    expect(first).toBeTruthy();
    expect(first.status).toBe('failed');

    // The next one is still queued ('sending' until drain).
    expect(second.status).toBe('sending');
    expect(last.status).toBe('sending');

    // Queue length is at-cap, not above it — the bookkeeping evicts in
    // place, doesn't just truncate after the fact.
    expect(store._pendingSendsLengthForTest()).toBe(100);

    // Drain confirms the surviving 100 publish in order msg-1 .. msg-100,
    // and the evicted msg-0 is NOT published.
    const fake = makeFakeClient();
    store._installTestClient(fake, true);
    store._drainPendingSendsForTest();

    const bodies = fake.published.map((p) => JSON.parse(p.payload).body);
    expect(bodies).toHaveLength(100);
    expect(bodies[0]).toBe('msg-1');
    expect(bodies[99]).toBe('msg-100');
    expect(bodies).not.toContain('msg-0');
  });

  it('retryMessage re-attempts a failed message', () => {
    store.sendMessage('retry-target');
    const id = store.messages.find((m) => m.body === 'retry-target').id;

    // Force the message into the failed state (as if a publish callback
    // had reported an error).
    const msg = store.messages.find((m) => m.id === id);
    msg.status = 'failed';

    // Wire up a fake broker now.
    const fake = makeFakeClient();
    store._installTestClient(fake, true);

    store.retryMessage(id);

    expect(fake.published).toHaveLength(1);
    const retried = JSON.parse(fake.published[0].payload);
    expect(retried.body).toBe('retry-target');
    expect(retried.id).toBe(id);
    // After the publish callback fires (synchronous in our stub), the
    // status should be 'sent'.
    expect(msg.status).toBe('sent');
  });

  it('retryMessage on non-failed message is a no-op (no double publish)', () => {
    store.sendMessage('still-sending');
    const id = store.messages.find((m) => m.body === 'still-sending').id;
    const msg = store.messages.find((m) => m.id === id);
    expect(msg.status).toBe('sending');

    const fake = makeFakeClient();
    store._installTestClient(fake, true);

    store.retryMessage(id);
    // Nothing published — the message is in 'sending', not 'failed'.
    expect(fake.published).toHaveLength(0);
    expect(msg.status).toBe('sending');
  });

  it('publish callback error transitions a sent message to failed', () => {
    // Start sending while disconnected, force to failed, then retry
    // against a fake broker that signals an error in the callback.
    store.sendMessage('publish-will-error');
    const id = store.messages.find((m) => m.body === 'publish-will-error').id;
    const msg = store.messages.find((m) => m.id === id);
    msg.status = 'failed';

    const fake = makeFakeClient();
    fake.setPublishMode('error');
    store._installTestClient(fake, true);

    store.retryMessage(id);
    expect(fake.published).toHaveLength(1);
    // Callback reported an error → status flips back to 'failed'.
    expect(msg.status).toBe('failed');
  });
});

describe('MqttChatStore — UX G-43 default name', () => {
  it('initial userProfile.name is the sentinel "(unset)" not "Phil"', () => {
    const store = new MqttChatStore();
    expect(store.userProfile.name).toBe('(unset)');
    // And the unset flag starts true.
    expect(store.nameUnset).toBe(true);
  });
});
