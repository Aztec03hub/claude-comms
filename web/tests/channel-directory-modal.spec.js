// Tests for ChannelDirectoryModal.svelte — v0.4.0 plan Step 2.13.
//
// This is the Browse + Admin tabbed modal opened via Ctrl+L or the
// "Browse channels…" link in the sidebar's Available section. It is
// Wave G's primary deliverable (paired with Step 2.14's
// ConversationBrowser refactor — that sibling agent's work lands in
// parallel; we stub global fetch here so the real ConversationBrowser
// component mounts without hitting the network).
//
// What this suite pins:
//
//   1. Open prop controls visibility — modal renders iff `open === true`.
//   2. Tabs
//      - Browse tab is default.
//      - Switching to Admin tab works (when visible).
//      - Admin tab hidden when user owns no channels.
//      - Admin tab visible when user owns >= 1 channel.
//      - Arrow keys move between tabs.
//      - initialTab="admin" opens directly on the Admin tab.
//   3. Browse tab body
//      - Filter input updates internal filterText (bound into the child
//        component's `filterValue` prop).
//      - Sort dropdown is disabled and shows "Alphabetical (locked)"
//        (Phil's SORT-LOCK invariant — the dropdown exists for
//        affordance, not for choice).
//   4. Admin tab body
//      - Owned channel row renders Edit topic / Archive / Delete
//        buttons.
//   5. Modal close paths (a11y)
//      - X button click → onClose.
//      - Escape key → onClose.
//      - Outside-click on the overlay → onClose.
//      - Click inside dialog content does not bubble to overlay.
//      - Tab focus trap cycles within the dialog.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

// Stub global fetch so the real ConversationBrowser (which calls
// /api/conversations on mount) doesn't crash the test harness. We
// return an empty conversation list — the suite asserts ChannelDirectory
// behavior, not browser rendering. (The browser's own coverage lives in
// the Step 2.14 sibling agent's suite.)
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ conversations: [] }),
  });
});

import ChannelDirectoryModal from '../src/components/ChannelDirectoryModal.svelte';

// ── Helpers ────────────────────────────────────────────────────────────

function makeStore(overrides = {}) {
  return {
    channels: overrides.channels ?? [],
    channelsById: overrides.channelsById ?? {},
    userProfile: overrides.userProfile ?? { key: 'me', name: 'me', type: 'human' },
    setTopic:
      overrides.setTopic ?? vi.fn().mockResolvedValue({ success: true }),
    archiveChannel:
      overrides.archiveChannel ??
      vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() })),
    deleteChannel:
      overrides.deleteChannel ?? vi.fn().mockResolvedValue({ success: true }),
    joinChannel: overrides.joinChannel ?? vi.fn(),
  };
}

function makeChannel(id, overrides = {}) {
  return {
    id,
    name: id,
    topic: `topic-for-${id}`,
    member: true,
    memberCount: 2,
    mode: 'public',
    visibility: 'listed',
    starred: false,
    muted: false,
    muteLevel: 'off',
    unread: 0,
    unreadHasMention: false,
    archived: false,
    archived_at: null,
    archived_by: null,
    createdAt: null,
    createdBy: null,
    ...overrides,
  };
}

function makeProps(overrides = {}) {
  return {
    store: overrides.store ?? makeStore(),
    open: overrides.open ?? true,
    initialTab: overrides.initialTab ?? 'browse',
    initialFilter: overrides.initialFilter ?? '',
    onClose: overrides.onClose ?? vi.fn(),
    onChannelClick: overrides.onChannelClick ?? vi.fn(),
    onChannelJoin: overrides.onChannelJoin ?? vi.fn(),
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

function fireKey(target, key, init = {}) {
  return fireEvent.keyDown(target, { key, bubbles: true, cancelable: true, ...init });
}

afterEach(() => {
  cleanup();
});

// ── 1. Open prop controls visibility ───────────────────────────────────

describe('ChannelDirectoryModal — visibility', () => {
  it('renders nothing when open is false', () => {
    const props = makeProps({ open: false });
    const { queryByTestId } = render(ChannelDirectoryModal, { props });
    expect(queryByTestId('channel-directory-modal')).toBeNull();
    expect(queryByTestId('channel-directory-overlay')).toBeNull();
  });

  it('renders the modal when open is true', () => {
    const props = makeProps({ open: true });
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    const dialog = getByTestId('channel-directory-modal');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy).textContent).toContain(
      'Channel directory',
    );
  });
});

// ── 2. Tabs ────────────────────────────────────────────────────────────

describe('ChannelDirectoryModal — tabs', () => {
  it('defaults to the Browse tab', () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    const browseTab = getByTestId('channel-directory-tab-browse');
    expect(browseTab.getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('channel-directory-browse-panel')).not.toBeNull();
  });

  it('hides the Admin tab when the user owns no channels', () => {
    const props = makeProps({
      store: makeStore({
        channelsById: {
          general: makeChannel('general', { createdBy: 'someone-else' }),
          random: makeChannel('random', { createdBy: null }),
        },
      }),
    });
    const { queryByTestId } = render(ChannelDirectoryModal, { props });
    expect(queryByTestId('channel-directory-tab-admin')).toBeNull();
  });

  it('shows the Admin tab when the user owns at least one channel', () => {
    const props = makeProps({
      store: makeStore({
        userProfile: { key: 'me', name: 'me', type: 'human' },
        channelsById: {
          mine: makeChannel('mine', { createdBy: 'me' }),
          theirs: makeChannel('theirs', { createdBy: 'someone-else' }),
        },
      }),
    });
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    const adminTab = getByTestId('channel-directory-tab-admin');
    expect(adminTab).not.toBeNull();
    expect(adminTab.getAttribute('aria-selected')).toBe('false');
  });

  it('switches to the Admin tab on click', async () => {
    const props = makeProps({
      store: makeStore({
        channelsById: {
          mine: makeChannel('mine', { createdBy: 'me' }),
        },
      }),
    });
    const { getByTestId, queryByTestId } = render(ChannelDirectoryModal, { props });
    await fireEvent.click(getByTestId('channel-directory-tab-admin'));
    expect(getByTestId('channel-directory-tab-admin').getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('channel-directory-admin-panel')).not.toBeNull();
    expect(queryByTestId('channel-directory-browse-panel')).toBeNull();
  });

  it('opens directly on the Admin tab when initialTab="admin"', () => {
    const props = makeProps({
      initialTab: 'admin',
      store: makeStore({
        channelsById: {
          mine: makeChannel('mine', { createdBy: 'me' }),
        },
      }),
    });
    const { getByTestId, queryByTestId } = render(ChannelDirectoryModal, { props });
    expect(getByTestId('channel-directory-tab-admin').getAttribute('aria-selected')).toBe('true');
    expect(getByTestId('channel-directory-admin-panel')).not.toBeNull();
    expect(queryByTestId('channel-directory-browse-panel')).toBeNull();
  });

  it('ArrowRight on the tab bar moves Browse → Admin', async () => {
    const props = makeProps({
      store: makeStore({
        channelsById: {
          mine: makeChannel('mine', { createdBy: 'me' }),
        },
      }),
    });
    const { getByTestId, container } = render(ChannelDirectoryModal, { props });
    const tablist = container.querySelector('[role="tablist"]');
    fireKey(tablist, 'ArrowRight');
    await tick();
    expect(getByTestId('channel-directory-tab-admin').getAttribute('aria-selected')).toBe('true');
  });
});

// ── 3. Browse tab body ─────────────────────────────────────────────────

describe('ChannelDirectoryModal — browse tab body', () => {
  it('renders the filter input and updates filterText on input', async () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    const input = getByTestId('channel-directory-filter-input');
    expect(input.value).toBe('');
    await fireEvent.input(input, { target: { value: 'general' } });
    expect(input.value).toBe('general');
  });

  it('pre-populates the filter input from the initialFilter prop', () => {
    const props = makeProps({ initialFilter: 'react' });
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    const input = getByTestId('channel-directory-filter-input');
    expect(input.value).toBe('react');
  });

  it('renders the sort dropdown as disabled with "Alphabetical (locked)" (SORT-LOCK)', () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    const select = getByTestId('channel-directory-sort-select');
    expect(select.disabled).toBe(true);
    expect(select.textContent).toContain('Alphabetical (locked)');
    expect(select.getAttribute('aria-label')).toContain('locked');
  });
});

// ── 4. Admin tab body ──────────────────────────────────────────────────

describe('ChannelDirectoryModal — admin tab body', () => {
  it('shows Edit topic / Archive / Delete buttons for each owned channel', async () => {
    const props = makeProps({
      initialTab: 'admin',
      store: makeStore({
        channelsById: {
          mine: makeChannel('mine', { createdBy: 'me', topic: 'My project' }),
        },
      }),
    });
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    expect(getByTestId('channel-directory-admin-row-mine')).not.toBeNull();
    expect(getByTestId('channel-directory-admin-edit-mine')).not.toBeNull();
    expect(getByTestId('channel-directory-admin-archive-mine')).not.toBeNull();
    expect(getByTestId('channel-directory-admin-delete-mine')).not.toBeNull();
    // Topic line shows the current topic.
    expect(getByTestId('channel-directory-admin-topic-mine').textContent.trim()).toBe(
      'My project',
    );
  });
});

// ── 5. Modal close paths (a11y) ────────────────────────────────────────

describe('ChannelDirectoryModal — close paths', () => {
  it('clicking the close button fires onClose', async () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    await fireEvent.click(getByTestId('channel-directory-close'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape fires onClose', async () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    await flushMicrotasks();
    const dialog = getByTestId('channel-directory-modal');
    fireKey(dialog, 'Escape');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the overlay fires onClose', async () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    await fireEvent.click(getByTestId('channel-directory-overlay'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog content does NOT fire onClose', async () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    await fireEvent.click(getByTestId('channel-directory-title'));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('Tab focus trap wraps from the last focusable back to the first', async () => {
    const props = makeProps();
    const { getByTestId } = render(ChannelDirectoryModal, { props });
    await flushMicrotasks();
    const dialog = getByTestId('channel-directory-modal');
    const focusables = Array.from(
      dialog.querySelectorAll(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusables.length).toBeGreaterThan(0);
    const last = focusables[focusables.length - 1];
    const first = focusables[0];
    last.focus();
    expect(document.activeElement).toBe(last);
    // Tab from the last focusable should wrap to the first.
    fireKey(last, 'Tab');
    expect(document.activeElement).toBe(first);
  });
});
