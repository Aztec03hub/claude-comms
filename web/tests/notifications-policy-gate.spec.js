// v0.4.2 Wave G follow-up [VERIFY-WAVE-G-4]. Browser Notification
// policy gate in ``web/src/lib/notifications.svelte.js``.
//
// What this file pins
// ───────────────────
// 1. The policy decision tree mirrors App.svelte:541-573 exactly:
//      'Off'      → never notify.
//      'Mentions' → notify on @mention OR highlight-word match only.
//      'All'      → notify always EXCEPT when channel muted AND msg is
//                   not a mention.
// 2. Mentions / highlight-word hits bypass the legacy ``muted`` flag
//    (the Wave G bug fix, mirrored on the browser-Notification path).
// 3. The explicit ``options.notificationPolicy`` override path supersedes
//    a registered policy resolver, so callers that pre-resolve don't
//    need a store hookup.
// 4. ``setNotificationPolicyResolver`` round-trips: registering a
//    resolver activates the gate for the registered channel ids, and
//    passing ``null`` clears it so test ``cleanup()`` doesn't leak.
//
// All tests exercise the pure ``shouldNotifyForPolicy`` +
// ``resolveNotificationPolicy`` helpers rather than the
// ``sendNotification`` end-to-end path because ``new Notification(...)``
// is fiddly to stub in jsdom and the surface that matters for the bug
// fix is the gate decision, not the DOM-level constructor invocation.
//
// Total: 12 tests (target floor was ≥6).

import { describe, it, expect, beforeEach } from 'vitest';

const {
  resolveNotificationPolicy,
  shouldNotifyForPolicy,
  setNotificationPolicyResolver,
} = await import('../src/lib/notifications.svelte.js');

const SELF_KEY = 'phil-key';
const OTHER_KEY = 'beefcafe';

beforeEach(() => {
  // Always clear the resolver between tests so an explicit-policy test
  // can't be confounded by a leftover registration from a sibling test.
  setNotificationPolicyResolver(null);
});

// ── 1. Policy decision tree (shouldNotifyForPolicy) ───────────────────

describe('Wave G follow-up - shouldNotifyForPolicy decision tree', () => {
  it('policy=Off: never notifies, even for an @mention', () => {
    const policy = { policy: 'Off', highlightWords: [] };
    const result = shouldNotifyForPolicy(policy, {
      mentions: [SELF_KEY],
      userKey: SELF_KEY,
      muted: false,
      body: 'hey @phil',
    });
    expect(result).toBe(false);
  });

  it('policy=Off: never notifies, even when muted=false and policy was set explicitly silent', () => {
    const policy = { policy: 'Off', highlightWords: ['ship'] };
    const result = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: false,
      body: 'we ship today',
    });
    expect(result).toBe(false);
  });

  it('policy=Mentions: notifies on an @mention, suppresses ordinary messages', () => {
    const policy = { policy: 'Mentions', highlightWords: [] };
    const mention = shouldNotifyForPolicy(policy, {
      mentions: [SELF_KEY, OTHER_KEY],
      userKey: SELF_KEY,
      muted: false,
      body: 'pinging @phil and @bob',
    });
    expect(mention).toBe(true);

    const ordinary = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: false,
      body: 'just chatting',
    });
    expect(ordinary).toBe(false);
  });

  it('policy=Mentions: highlight-word substring hit raises a notification on a non-mention message', () => {
    const policy = { policy: 'Mentions', highlightWords: ['release', 'bug'] };
    const hit = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: false,
      body: 'kicking off the v0.5 release tomorrow',
    });
    expect(hit).toBe(true);

    // Non-matching body: no notification.
    const miss = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: false,
      body: 'just chatting',
    });
    expect(miss).toBe(false);
  });

  it('policy=Mentions: highlight-word match is case-insensitive', () => {
    const policy = { policy: 'Mentions', highlightWords: ['bug'] };
    const result = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: false,
      body: 'Found a BUG in the auth flow',
    });
    expect(result).toBe(true);
  });

  it('policy=All: notifies on every ordinary message when not muted', () => {
    const policy = { policy: 'All', highlightWords: [] };
    const result = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: false,
      body: 'hi everyone',
    });
    expect(result).toBe(true);
  });

  it('policy=All: muted channel + non-mention → suppressed (legacy mute)', () => {
    const policy = { policy: 'All', highlightWords: [] };
    const result = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: true,
      body: 'hi everyone',
    });
    expect(result).toBe(false);
  });

  it('policy=All: muted channel + @mention → fires (mention bypasses mute, the Wave G bug fix)', () => {
    const policy = { policy: 'All', highlightWords: [] };
    const result = shouldNotifyForPolicy(policy, {
      mentions: [SELF_KEY],
      userKey: SELF_KEY,
      muted: true,
      body: 'hey @phil',
    });
    expect(result).toBe(true);
  });

  it('policy=All: muted channel + highlight-word hit → fires (Q7 parallels mention-bypass)', () => {
    const policy = { policy: 'All', highlightWords: ['ship'] };
    const result = shouldNotifyForPolicy(policy, {
      mentions: null,
      userKey: SELF_KEY,
      muted: true,
      body: 'we ship today',
    });
    expect(result).toBe(true);
  });
});

// ── 2. resolveNotificationPolicy resolution order ─────────────────────

describe('Wave G follow-up - resolveNotificationPolicy resolution order', () => {
  it('explicit notificationPolicy option supersedes the registered resolver', () => {
    setNotificationPolicyResolver(() => ({ policy: 'All', highlightWords: [] }));
    const resolved = resolveNotificationPolicy({
      channel: 'general',
      notificationPolicy: { policy: 'Off', highlightWords: [] },
    });
    expect(resolved.policy).toBe('Off');
  });

  it('registered resolver is used when only options.channel is supplied', () => {
    setNotificationPolicyResolver((id) => {
      if (id === 'random') return { policy: 'Mentions', highlightWords: ['ship'] };
      return { policy: 'All', highlightWords: [] };
    });
    const resolved = resolveNotificationPolicy({ channel: 'random' });
    expect(resolved.policy).toBe('Mentions');
    expect(resolved.highlightWords).toEqual(['ship']);
  });

  it('falls back to {policy: All, highlightWords: []} when no resolver and no override', () => {
    setNotificationPolicyResolver(null);
    const resolved = resolveNotificationPolicy({ channel: 'general' });
    expect(resolved).toEqual({ policy: 'All', highlightWords: [] });
  });
});
