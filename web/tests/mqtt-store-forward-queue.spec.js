// Polish P6 (v0.4.2 Wave 0) — `forwardMessage` pending-sends queue.
//
// The v0.3.3 G-62 fix added the bounded `#pendingSends` queue +
// per-message `status` ('sending' | 'sent' | 'failed') to
// `sendMessage` so disconnected sends queue + drain on reconnect
// instead of silently dropping. The same silent-drop existed in
// `forwardMessage` until this Polish wave; this spec locks the
// fix in.
//
// Pattern mirrors `tests/mqtt-store-pending-sends.spec.js` but
// drives the forward path: a forwarded message while disconnected
// should land in `#pendingSends`, carry status='sending', drain
// FIFO on reconnect, and respect the cap.

import { describe, it, expect, beforeEach } from 'vitest';
import { MqttChatStore } from '../src/lib/mqtt-store.svelte.js';

/**
 * Build a minimal mqtt.js-like client stub. Records every `publish`
 * call for assertions. By default `publish` invokes its callback with
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
    subscribe() {},
    on() {},
    end() {},
    reconnect() {},
    options: { reconnectPeriod: 0 },
  };
}

/**
 * Build a minimal source-message shape that mirrors what
 * MessageBubble's forward picker hands `store.forwardMessage`.
 */
function srcMessage(overrides = {}) {
  return {
    id: 'src-msg-1',
    ts: '2026-05-18T20:00:00.000Z',
    body: 'forward me',
    sender: { key: 'orig', name: 'orig-user', type: 'human' },
    conv: 'source-channel',
    ...overrides,
  };
}

describe('MqttChatStore — Polish P6 forwardMessage pending sends', () => {
  /** @type {MqttChatStore} */
  let store;

  beforeEach(() => {
    store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
  });

  it('queues forwards while disconnected (does not publish, does not drop)', () => {
    // Default state: connected=false, no #client. The pre-P6 behavior
    // would local-echo and silently drop the wire publish — leaving
    // the bubble in an indeterminate state. Post-P6: bubble is
    // 'sending', queue entry exists.
    expect(store.connected).toBe(false);

    store.forwardMessage(srcMessage(), 'target-channel');

    const local = store.messages.find((m) => m.forwarded_from === 'src-msg-1');
    expect(local).toBeTruthy();
    expect(local.status).toBe('sending');
    expect(local.conv).toBe('target-channel');
    // Queue length reflects the one queued forward.
    expect(store._pendingSendsLengthForTest()).toBe(1);
  });

  it('drains queued forwards in FIFO order on reconnect', () => {
    // Forward three different source messages to two different target
    // channels while disconnected.
    store.forwardMessage(srcMessage({ id: 'src-a', body: 'first' }), 'target-1');
    store.forwardMessage(srcMessage({ id: 'src-b', body: 'second' }), 'target-2');
    store.forwardMessage(srcMessage({ id: 'src-c', body: 'third' }), 'target-1');

    const forwards = store.messages.filter((m) => m.forwarded_from);
    expect(forwards).toHaveLength(3);
    for (const m of forwards) {
      expect(m.status).toBe('sending');
    }
    expect(store._pendingSendsLengthForTest()).toBe(3);

    // Simulate broker becoming reachable + invoke the real drain
    // helper (same hook the production 'connect' callback uses).
    const fake = makeFakeClient();
    store._installTestClient(fake, true);
    store._drainPendingSendsForTest();

    // FIFO order preserved + the topic carries the correct target.
    expect(fake.published).toHaveLength(3);
    const decoded = fake.published.map((p) => ({
      topic: p.topic,
      body: JSON.parse(p.payload).body,
      conv: JSON.parse(p.payload).conv,
    }));
    expect(decoded[0]).toEqual({
      topic: 'claude-comms/conv/target-1/messages',
      body: 'first',
      conv: 'target-1',
    });
    expect(decoded[1]).toEqual({
      topic: 'claude-comms/conv/target-2/messages',
      body: 'second',
      conv: 'target-2',
    });
    expect(decoded[2]).toEqual({
      topic: 'claude-comms/conv/target-1/messages',
      body: 'third',
      conv: 'target-1',
    });

    // All three local-echo bubbles flipped to 'sent' via the publish
    // callback (the fake client invokes the success branch).
    for (const m of forwards) {
      expect(m.status).toBe('sent');
    }
    expect(store._pendingSendsLengthForTest()).toBe(0);
  });

  it('drops oldest forward when the queue cap (100) is exceeded; oldest is marked failed', () => {
    // Push 101 forwards while disconnected. Cap is 100; the first
    // entry is evicted and its bubble flips to 'failed'.
    for (let i = 0; i < 101; i++) {
      store.forwardMessage(
        srcMessage({ id: 'src-' + i, body: 'fwd-' + i }),
        'target-channel',
      );
    }

    const first = store.messages.find((m) => m.body === 'fwd-0');
    const second = store.messages.find((m) => m.body === 'fwd-1');
    const last = store.messages.find((m) => m.body === 'fwd-100');

    expect(first.status).toBe('failed');
    expect(second.status).toBe('sending');
    expect(last.status).toBe('sending');

    // Queue is at cap, not over.
    expect(store._pendingSendsLengthForTest()).toBe(100);

    // Drain confirms only fwd-1..fwd-100 publish.
    const fake = makeFakeClient();
    store._installTestClient(fake, true);
    store._drainPendingSendsForTest();

    const bodies = fake.published.map((p) => JSON.parse(p.payload).body);
    expect(bodies).toHaveLength(100);
    expect(bodies[0]).toBe('fwd-1');
    expect(bodies[99]).toBe('fwd-100');
    expect(bodies).not.toContain('fwd-0');
  });

  it('publishes immediately + marks the bubble sent when already connected', () => {
    const fake = makeFakeClient();
    store._installTestClient(fake, true);

    store.forwardMessage(srcMessage({ id: 'src-direct', body: 'direct' }), 'target-channel');

    // Wire publish landed; queue stayed empty.
    expect(fake.published).toHaveLength(1);
    expect(store._pendingSendsLengthForTest()).toBe(0);

    const local = store.messages.find((m) => m.forwarded_from === 'src-direct');
    expect(local.status).toBe('sent');

    // Topic + payload conv field match the target channel.
    const published = fake.published[0];
    expect(published.topic).toBe('claude-comms/conv/target-channel/messages');
    const wire = JSON.parse(published.payload);
    expect(wire.conv).toBe('target-channel');
    expect(wire.body).toBe('direct');
    expect(wire.forwarded_from).toBe('src-direct');
    // The internal local-echo `status` field must NOT leak onto the wire —
    // otherwise remote viewers render a permanent "Sending…" spinner.
    expect(wire.status).toBeUndefined();
  });

  it('publish-callback error during drain marks the forward as failed (retryable)', () => {
    // Queue a forward while disconnected, then drain against a fake
    // broker whose publish callback signals an error. The bubble
    // should land in 'failed', not stay in 'sending'.
    store.forwardMessage(srcMessage({ id: 'src-err', body: 'will-fail' }), 'target-channel');
    const local = store.messages.find((m) => m.forwarded_from === 'src-err');
    expect(local.status).toBe('sending');
    expect(store._pendingSendsLengthForTest()).toBe(1);

    const fake = makeFakeClient();
    fake.setPublishMode('error');
    store._installTestClient(fake, true);
    store._drainPendingSendsForTest();

    expect(fake.published).toHaveLength(1);
    expect(local.status).toBe('failed');
    expect(store._pendingSendsLengthForTest()).toBe(0);

    // retryMessage works on the failed forward — it's just another
    // local-echo from the messages array as far as the retry path is
    // concerned.
    fake.setPublishMode('success');
    store.retryMessage(local.id);
    expect(fake.published).toHaveLength(2);
    expect(local.status).toBe('sent');
  });

  it('drain dispatches mixed sendMessage + forwardMessage entries by topic', () => {
    // Both code paths feed the same `#pendingSends` queue + the same
    // `#publishOutgoing` helper, so the drain is naturally
    // topic-agnostic. This test pins that contract: a queue holding
    // one direct send + one forward should drain both, each to its
    // own topic, in insertion order.
    store.activeChannel = 'direct-channel';
    store.sendMessage('direct hello while offline');
    store.forwardMessage(srcMessage({ id: 'src-mix', body: 'forward while offline' }), 'fwd-channel');

    expect(store._pendingSendsLengthForTest()).toBe(2);

    const fake = makeFakeClient();
    store._installTestClient(fake, true);
    store._drainPendingSendsForTest();

    expect(fake.published).toHaveLength(2);
    expect(fake.published[0].topic).toBe('claude-comms/conv/direct-channel/messages');
    expect(fake.published[1].topic).toBe('claude-comms/conv/fwd-channel/messages');

    const firstPayload = JSON.parse(fake.published[0].payload);
    const secondPayload = JSON.parse(fake.published[1].payload);
    expect(firstPayload.body).toBe('direct hello while offline');
    expect(firstPayload.forwarded_from).toBeUndefined();
    expect(secondPayload.body).toBe('forward while offline');
    expect(secondPayload.forwarded_from).toBe('src-mix');
    // Neither path may leak the internal `status` local-echo field.
    expect(firstPayload.status).toBeUndefined();
    expect(secondPayload.status).toBeUndefined();
  });

  it('forwarding to a non-active channel does NOT inflate the sender\'s own unread', () => {
    // The forwarded local-echo is self-authored and lands in a non-active
    // channel; the sender must never bump their OWN unread badge.
    store.activeChannel = 'home-channel';
    store.channelsById = {
      'target-channel': { id: 'target-channel', unread: 0, unreadHasMention: false },
    };

    store.forwardMessage(srcMessage({ id: 'src-self', body: 'fwd to elsewhere' }), 'target-channel');

    expect(store.channelsById['target-channel'].unread).toBe(0);
    expect(store.channelsById['target-channel'].unreadHasMention).toBe(false);
  });
});
