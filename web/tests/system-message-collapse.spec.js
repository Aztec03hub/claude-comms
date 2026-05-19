// v0.4.2 Wave E.1 Step 3.11 — SystemMessageGroup collapse + MessageGroup
// system-array delegation (UX G-58).
//
// Coverage targets per the Step 3.11 verification gate:
//   - 3+ consecutive system events collapse to a single summary row
//   - 1 or 2 consecutive system events render inline (no collapse)
//   - Clicking the summary expands the group to show all events
//   - Clicking the summary again collapses the group
//   - Summary text humanizes the event taxonomy (uses pre-rendered bodies)
//   - Summary text includes the event count
//   - MessageGroup with a non-system run still routes to MessageBubble
//   - Mixed groups (any non-system entry) fall back to bubble rendering
//   - Keyboard activation (Enter / Space) on the summary toggles expansion
//
// Fixtures: hand-rolled system message objects matching the shape pushed
// via mqtt-store.svelte.js #handleChatMessage (sender.type === 'system',
// body carries the pre-humanized event string).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import SystemMessageGroup from '../src/components/SystemMessageGroup.svelte';
import MessageGroup from '../src/components/MessageGroup.svelte';

// ── Fixture helpers ────────────────────────────────────────────────────

let nextId = 1;
function systemMessage(body, overrides = {}) {
  return {
    id: `sys-${nextId++}`,
    ts: '2026-05-19T07:00:00.000Z',
    body,
    sender: { key: 'system', name: 'System', type: 'system' },
    ...overrides,
  };
}

function humanMessage(body, overrides = {}) {
  return {
    id: `msg-${nextId++}`,
    ts: '2026-05-19T07:00:00.000Z',
    body,
    sender: { key: 'alice', name: 'Alice', type: 'human' },
    reactions: {},
    thread_count: 0,
    read_by: [],
    ...overrides,
  };
}

const baseHumanGroupProps = {
  currentUser: { key: 'me', name: 'Me', type: 'human' },
  participants: {
    alice: { key: 'alice', name: 'Alice', type: 'human' },
    me: { key: 'me', name: 'Me', type: 'human' },
  },
  onOpenThread: () => {},
  onContextMenu: () => {},
  onShowProfile: () => {},
  onReact: () => {},
  onRetryMessage: () => {},
};

afterEach(() => {
  cleanup();
});

// ── SystemMessageGroup — inline vs collapsed ──────────────────────────

describe('SystemMessageGroup — collapse threshold', () => {
  it('renders a single system event inline (no collapse, no toggle)', () => {
    const messages = [systemMessage('Alice joined')];
    const { queryByTestId, getByText } = render(SystemMessageGroup, {
      props: { messages },
    });

    expect(queryByTestId('system-message-group')).toBeNull();
    expect(queryByTestId('system-message-group-toggle')).toBeNull();
    expect(getByText('Alice joined')).toBeTruthy();
  });

  it('renders two consecutive system events inline (no collapse)', () => {
    const messages = [
      systemMessage('Alice joined'),
      systemMessage('Bob left'),
    ];
    const { queryByTestId, getByText } = render(SystemMessageGroup, {
      props: { messages },
    });

    expect(queryByTestId('system-message-group')).toBeNull();
    expect(getByText('Alice joined')).toBeTruthy();
    expect(getByText('Bob left')).toBeTruthy();
  });

  it('collapses 3 consecutive system events into a summary row', () => {
    const messages = [
      systemMessage('Alice joined'),
      systemMessage('Bob left'),
      systemMessage('Carol archived #general'),
    ];
    const { getByTestId, queryByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    expect(getByTestId('system-message-group')).toBeTruthy();
    expect(getByTestId('system-message-group-toggle')).toBeTruthy();
    // Individual event rows are NOT rendered while collapsed.
    expect(queryByTestId('system-message-group-events')).toBeNull();
  });

  it('collapses larger runs (5 events) identically to the 3-event case', () => {
    const messages = [
      systemMessage('A joined'),
      systemMessage('B joined'),
      systemMessage('C joined'),
      systemMessage('D left'),
      systemMessage('E left'),
    ];
    const { getByTestId, queryByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    expect(getByTestId('system-message-group')).toBeTruthy();
    expect(queryByTestId('system-message-group-events')).toBeNull();
  });
});

// ── SystemMessageGroup — summary text humanization ────────────────────

describe('SystemMessageGroup — summary text', () => {
  it('humanizes the event taxonomy by stitching pre-rendered bodies', () => {
    const messages = [
      systemMessage('Alice joined'),
      systemMessage('Bob left'),
      systemMessage('Carol archived #general'),
    ];
    const { getByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    const toggle = getByTestId('system-message-group-toggle');
    expect(toggle.textContent).toContain('Alice joined');
    expect(toggle.textContent).toContain('Bob left');
    expect(toggle.textContent).toContain('Carol archived #general');
  });

  it('appends a trailing "(N events)" count to the summary', () => {
    const messages = [
      systemMessage('A joined'),
      systemMessage('B joined'),
      systemMessage('C joined'),
      systemMessage('D joined'),
    ];
    const { getByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    expect(getByTestId('system-message-group-toggle').textContent).toContain(
      '(4 events)',
    );
  });

  it('falls back to "N events" when bodies are missing or blank', () => {
    const messages = [
      systemMessage(''),
      systemMessage('   '),
      systemMessage(''),
    ];
    const { getByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    expect(getByTestId('system-message-group-toggle').textContent).toContain(
      '3 events',
    );
  });
});

// ── SystemMessageGroup — expand / collapse interaction ────────────────

describe('SystemMessageGroup — expand / collapse', () => {
  it('clicking the summary expands to show every individual event', async () => {
    const messages = [
      systemMessage('Alice joined'),
      systemMessage('Bob left'),
      systemMessage('Carol archived #general'),
    ];
    const { getByTestId, queryByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    const toggle = getByTestId('system-message-group-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(queryByTestId('system-message-group-events')).toBeNull();

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const events = getByTestId('system-message-group-events');
    expect(events).toBeTruthy();
    // All three individual event rows are now visible inside the expansion.
    expect(events.querySelectorAll('[data-message-id]').length).toBe(3);
  });

  it('clicking the summary a second time collapses the group again', async () => {
    const messages = [
      systemMessage('A joined'),
      systemMessage('B joined'),
      systemMessage('C joined'),
    ];
    const { getByTestId, queryByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    const toggle = getByTestId('system-message-group-toggle');
    await fireEvent.click(toggle);
    expect(queryByTestId('system-message-group-events')).toBeTruthy();

    await fireEvent.click(toggle);
    expect(queryByTestId('system-message-group-events')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('keyboard Enter on the summary toggles expansion', async () => {
    const messages = [
      systemMessage('A joined'),
      systemMessage('B joined'),
      systemMessage('C joined'),
    ];
    const { getByTestId, queryByTestId } = render(SystemMessageGroup, {
      props: { messages },
    });

    const toggle = getByTestId('system-message-group-toggle');
    await fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(queryByTestId('system-message-group-events')).toBeTruthy();
  });
});

// ── MessageGroup — delegation to SystemMessageGroup ───────────────────

describe('MessageGroup — system-array delegation (Step 3.11 wiring)', () => {
  it('routes a system-only run of 3+ to SystemMessageGroup (collapsed)', () => {
    const messages = [
      systemMessage('Alice joined'),
      systemMessage('Bob left'),
      systemMessage('Carol archived #general'),
    ];
    const { getByTestId } = render(MessageGroup, {
      props: { ...baseHumanGroupProps, messages },
    });

    expect(getByTestId('system-message-group')).toBeTruthy();
  });

  it('routes a system-only run of 2 to SystemMessageGroup (inline, no toggle)', () => {
    const messages = [
      systemMessage('Alice joined'),
      systemMessage('Bob left'),
    ];
    const { queryByTestId } = render(MessageGroup, {
      props: { ...baseHumanGroupProps, messages },
    });

    expect(queryByTestId('system-message-group')).toBeNull();
    expect(queryByTestId('system-message-group-toggle')).toBeNull();
  });

  it('passes through to MessageBubble for non-system message runs', () => {
    const messages = [humanMessage('Hello'), humanMessage('Again')];
    const { queryByTestId, container } = render(MessageGroup, {
      props: { ...baseHumanGroupProps, messages },
    });

    expect(queryByTestId('system-message-group')).toBeNull();
    // MessageBubble renders an article role per its template.
    expect(container.querySelectorAll('[role="article"]').length).toBe(2);
  });

  it('falls back to MessageBubble when a run mixes system and non-system entries', () => {
    // Defensive guard: ChatView is responsible for grouping, but a
    // malformed mixed group should NOT silently disappear into the
    // SystemMessageGroup branch — it must render through MessageBubble so
    // the regression is visible.
    const messages = [
      systemMessage('Alice joined'),
      humanMessage('hi everyone'),
      systemMessage('Bob left'),
    ];
    const { queryByTestId, container } = render(MessageGroup, {
      props: { ...baseHumanGroupProps, messages },
    });

    expect(queryByTestId('system-message-group')).toBeNull();
    // All three entries fall through to bubbles when the group is mixed.
    expect(container.querySelectorAll('[role="article"]').length).toBe(3);
  });
});

// Silence the vi import (used implicitly above for fixture isolation in
// future tests).
void vi;
