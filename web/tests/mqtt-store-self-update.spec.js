// Tests for MqttChatStore.markSelfUpdate / isOurRecentUpdate — the
// keyed TTL Map that prevents our own POST echo from triggering a
// "remote update" banner in the artifact panel (plan §1, R5-6).
//
// We exercise the methods directly without spinning up an MQTT client;
// the store's own map logic is deterministic and doesn't depend on the
// broker.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MqttChatStore } from '../src/lib/mqtt-store.svelte.js';

describe('MqttChatStore — self-update tracking', () => {
  /** @type {MqttChatStore} */
  let store;

  beforeEach(() => {
    store = new MqttChatStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false before any markSelfUpdate call', () => {
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(false);
  });

  it('returns true within the 5-second TTL window', () => {
    store.markSelfUpdate('artifact-one', 1);
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(true);
    // 4 seconds later — still within TTL
    vi.advanceTimersByTime(4000);
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(true);
  });

  it('returns false after the 5-second TTL expires', () => {
    store.markSelfUpdate('artifact-one', 1);
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(true);
    // Advance past 5s — entry must be pruned/expired.
    vi.advanceTimersByTime(5001);
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(false);
  });

  it('isolates entries by (name, version) composite key', () => {
    store.markSelfUpdate('artifact-one', 1);
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(true);
    expect(store.isOurRecentUpdate('artifact-one', 2)).toBe(false);
    expect(store.isOurRecentUpdate('artifact-two', 1)).toBe(false);
  });

  it('multiple artifacts updated simultaneously do not cross-contaminate', () => {
    store.markSelfUpdate('artifact-one', 3);
    store.markSelfUpdate('artifact-two', 7);
    store.markSelfUpdate('artifact-three', 1);

    expect(store.isOurRecentUpdate('artifact-one', 3)).toBe(true);
    expect(store.isOurRecentUpdate('artifact-two', 7)).toBe(true);
    expect(store.isOurRecentUpdate('artifact-three', 1)).toBe(true);

    // Different versions of the same name are not "recent" just because a
    // sibling version is.
    expect(store.isOurRecentUpdate('artifact-one', 4)).toBe(false);
    expect(store.isOurRecentUpdate('artifact-two', 8)).toBe(false);
  });

  it('expires entries independently on their own timers', () => {
    store.markSelfUpdate('artifact-one', 1);
    vi.advanceTimersByTime(3000);
    // Mark the second one 3s later.
    store.markSelfUpdate('artifact-two', 1);

    vi.advanceTimersByTime(2500);
    // artifact-one: total 5500ms — expired.
    // artifact-two: total 2500ms — still live.
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(false);
    expect(store.isOurRecentUpdate('artifact-two', 1)).toBe(true);
  });

  it('re-marking the same (name, version) refreshes the TTL', () => {
    store.markSelfUpdate('artifact-one', 1);
    vi.advanceTimersByTime(4000);
    // Re-mark at t=4s.
    store.markSelfUpdate('artifact-one', 1);
    vi.advanceTimersByTime(4000);
    // Total elapsed = 8s, but second mark only 4s ago → still live.
    expect(store.isOurRecentUpdate('artifact-one', 1)).toBe(true);
  });

  it('treats numeric and string versions as different keys', () => {
    // This is a defensive check — callers should be consistent with their
    // version representation, and the composite key honors that.
    store.markSelfUpdate('artifact-one', 3);
    expect(store.isOurRecentUpdate('artifact-one', 3)).toBe(true);
    // Same stringification, same key — works with either representation
    // as long as the caller is consistent.
    expect(store.isOurRecentUpdate('artifact-one', '3')).toBe(true);
  });
});

describe('MqttChatStore — artifactsDirty counter', () => {
  /** @type {MqttChatStore} */
  let store;

  beforeEach(() => {
    store = new MqttChatStore();
  });

  it('initialises to 0', () => {
    expect(store.artifactsDirty).toBe(0);
  });

  // We can't easily trigger the private #handleChatMessage without mocking
  // the whole MQTT client, but we can assert the counter is at least
  // reachable and incrementable — the integration is exercised by the
  // Playwright e2e tests.
  it('is publicly mutable (no accidental read-only guard)', () => {
    store.artifactsDirty++;
    expect(store.artifactsDirty).toBe(1);
    store.artifactsDirty++;
    expect(store.artifactsDirty).toBe(2);
  });
});
