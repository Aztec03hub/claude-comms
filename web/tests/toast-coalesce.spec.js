// Unit tests for the toast cap/coalesce core (UX G-14), extracted from
// App.svelte's addToast() into lib/toast-coalesce.js. This closes the gap
// flagged in the test audit: the coalesce algorithm (cap, same-channel
// coalesce, pill promotion, FIFO eviction) had no real coverage -- the old
// "G-14" tests rendered NotificationToast directly and never ran this logic.

import { describe, it, expect } from 'vitest';
import { applyToast } from '../src/lib/toast-coalesce.js';

const t = (id, channel, name = 'alice') => ({
  id,
  channel,
  sender: { key: `${name}-key`, name },
  messageId: `msg-${id}`,
});

describe('applyToast — append (no same-channel toast)', () => {
  it('appends to an empty stack and schedules its timer', () => {
    const r = applyToast([], t('a', 'general'));
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0].id).toBe('a');
    expect(r.toasts[0].coalescedCount).toBe(1);
    expect(r.toasts[0].pill).toBe(false);
    expect(r.resetTimerId).toBe('a');
    expect(r.evictedId).toBeNull();
  });

  it('appends distinct-channel toasts up to the cap without eviction', () => {
    let toasts = [];
    for (const [id, ch] of [['a', 'general'], ['b', 'dev'], ['c', 'ops']]) {
      toasts = applyToast(toasts, t(id, ch)).toasts;
    }
    expect(toasts.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('applyToast — same-channel coalesce', () => {
  it('coalesces a second same-channel event into "X and 1 other" (singular)', () => {
    const first = applyToast([], t('a', 'general', 'phil')).toasts;
    const r = applyToast(first, t('b', 'general', 'claude'));
    expect(r.toasts).toHaveLength(1); // folded, not appended
    const merged = r.toasts[0];
    expect(merged.id).toBe('a'); // keeps existing id (timer stays attached)
    expect(merged.coalescedCount).toBe(2);
    expect(merged.pill).toBe(false);
    expect(merged.text).toBe('claude and 1 other sent messages');
    expect(merged.sender.name).toBe('claude'); // freshest sender
    expect(r.resetTimerId).toBe('a');
    expect(r.evictedId).toBeNull();
  });

  it('pluralises "others" for 3+ folded events', () => {
    let toasts = applyToast([], t('a', 'general', 'phil')).toasts;
    toasts = applyToast(toasts, t('b', 'general', 'claude')).toasts;
    const r = applyToast(toasts, t('c', 'general', 'bot'));
    expect(r.toasts[0].coalescedCount).toBe(3);
    expect(r.toasts[0].text).toBe('bot and 2 others sent messages');
  });

  it('promotes to a compact pill at the pill threshold (5 folded events)', () => {
    let toasts = applyToast([], t('a', 'general', 'phil')).toasts;
    for (const id of ['b', 'c', 'd', 'e']) {
      toasts = applyToast(toasts, t(id, 'general', 'claude')).toasts;
    }
    const merged = toasts[0];
    expect(merged.coalescedCount).toBe(5);
    expect(merged.pill).toBe(true);
    expect(merged.text).toBe('+5 new in #general');
  });
});

describe('applyToast — FIFO eviction at cap', () => {
  it('evicts the oldest when a new distinct-channel toast arrives at cap', () => {
    let toasts = [];
    for (const [id, ch] of [['a', 'general'], ['b', 'dev'], ['c', 'ops']]) {
      toasts = applyToast(toasts, t(id, ch)).toasts;
    }
    const r = applyToast(toasts, t('d', 'random'));
    expect(r.toasts.map((x) => x.id)).toEqual(['b', 'c', 'd']); // 'a' evicted
    expect(r.evictedId).toBe('a');
    expect(r.resetTimerId).toBe('d');
  });

  it('does not evict when a same-channel event arrives at cap (it coalesces)', () => {
    let toasts = [];
    for (const [id, ch] of [['a', 'general'], ['b', 'dev'], ['c', 'ops']]) {
      toasts = applyToast(toasts, t(id, ch)).toasts;
    }
    const r = applyToast(toasts, t('d', 'dev'));
    expect(r.toasts).toHaveLength(3); // still capped, folded into 'b'
    expect(r.toasts.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(r.evictedId).toBeNull();
    expect(r.toasts[1].coalescedCount).toBe(2);
  });
});
