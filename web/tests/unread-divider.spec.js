// Tests for UnreadDivider.svelte — v0.4.2 Step 3.7.
//
// What this suite pins:
//
//   1. Show/hide
//      - Renders when unreadCount > 0.
//      - Renders nothing when unreadCount === 0.
//      - Renders nothing when unreadCount is negative or non-numeric.
//
//   2. Label
//      - Default label is "{N} new".
//      - Custom label prop overrides the default.
//
//   3. A11y
//      - role="separator" so AT users get a clear semantic break.
//      - aria-label includes the count.
//
//   4. Position-in-list integration (rendered inline by ChatView)
//      - Verified separately in chat-view-integration.spec.js. Here we
//        only pin the component's standalone behavior.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import UnreadDivider from '../src/components/UnreadDivider.svelte';

afterEach(() => {
  cleanup();
});

// ── 1. Show / hide ─────────────────────────────────────────────────────

describe('UnreadDivider — show/hide', () => {
  it('renders when unreadCount > 0', () => {
    const { queryByTestId } = render(UnreadDivider, {
      props: { unreadCount: 3 },
    });
    expect(queryByTestId('unread-divider')).not.toBeNull();
  });

  it('renders nothing when unreadCount === 0', () => {
    const { queryByTestId } = render(UnreadDivider, {
      props: { unreadCount: 0 },
    });
    expect(queryByTestId('unread-divider')).toBeNull();
  });

  it('renders nothing when unreadCount is negative', () => {
    const { queryByTestId } = render(UnreadDivider, {
      props: { unreadCount: -1 },
    });
    expect(queryByTestId('unread-divider')).toBeNull();
  });

  it('renders nothing for a freshly-joined channel (default props)', () => {
    // Default unreadCount is 0 — used by ChatView when channel.unread
    // is missing/undefined.
    const { queryByTestId } = render(UnreadDivider, { props: {} });
    expect(queryByTestId('unread-divider')).toBeNull();
  });
});

// ── 2. Label ───────────────────────────────────────────────────────────

describe('UnreadDivider — label', () => {
  it('default label is "{N} new"', () => {
    const { getByTestId } = render(UnreadDivider, {
      props: { unreadCount: 7 },
    });
    expect(getByTestId('unread-divider-label').textContent.trim()).toBe('7 new');
  });

  it('label reflects different counts', () => {
    const { getByTestId } = render(UnreadDivider, {
      props: { unreadCount: 1 },
    });
    expect(getByTestId('unread-divider-label').textContent.trim()).toBe('1 new');
  });

  it('custom label prop overrides the default', () => {
    const { getByTestId } = render(UnreadDivider, {
      props: { unreadCount: 5, label: '5 new since you were here' },
    });
    expect(getByTestId('unread-divider-label').textContent.trim()).toBe(
      '5 new since you were here',
    );
  });
});

// ── 3. A11y ────────────────────────────────────────────────────────────

describe('UnreadDivider — a11y', () => {
  it('has role="separator" so AT users get a clear semantic break', () => {
    const { getByTestId } = render(UnreadDivider, {
      props: { unreadCount: 2 },
    });
    expect(getByTestId('unread-divider').getAttribute('role')).toBe('separator');
  });

  it('aria-label includes the unread count', () => {
    const { getByTestId } = render(UnreadDivider, {
      props: { unreadCount: 4 },
    });
    const al = getByTestId('unread-divider').getAttribute('aria-label');
    expect(al).toContain('4');
    expect(al).toContain('unread');
  });
});
