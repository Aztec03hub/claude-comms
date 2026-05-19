// v0.4.2 Step 3.9 (Wave G) — per-channel notification policy + Q7
// highlight-words + Q8 kebab quickview + SidebarChannelRow bell-icon
// variant test suite.
//
// What this file pins
// ───────────────────
// 1. Store accessors (4 tests):
//    getNotificationPolicy / setNotificationPolicy / cycleNotificationPolicy
//    + highlight-words round-trip via localStorage key cc:notif-policy:{id}.
//
// 2. NotificationPolicyMenu UI (3 tests):
//    Radio toggle picks the right policy on save; highlight-words text
//    splits/trims/empty-filters on save; Cancel discards.
//
// 3. ChannelContextMenu Q8 quickview (2 tests):
//    The "Notifications: <policy>" row shows the current policy and
//    fires actionId='notif:cycle' on click (which would call
//    cycleNotificationPolicy in the parent's onAction handler).
//
// 4. SidebarChannelRow bell-icon variant (2 tests):
//    Mentions → BellDot icon visible; Off → BellOff icon visible;
//    All → no bell icon (control via absence assertion).
//
// 5. Highlight-word match in #handleChatMessage (3 tests):
//    Case-insensitive substring match raises unreadHasMention on a
//    non-mention message; multiple configured words all match; an
//    empty list / non-matching body leaves unreadHasMention=false.
//
// Total: 14 tests (target ≥14 per orchestrator brief).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

const apiGetMock = vi.fn();
const mcpCallMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: (...args) => apiGetMock(...args),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
  mcpCall: (...args) => mcpCallMock(...args),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');
const NotificationPolicyMenu = (
  await import('../src/components/NotificationPolicyMenu.svelte')
).default;
const ChannelContextMenu = (
  await import('../src/components/ChannelContextMenu.svelte')
).default;
const SidebarChannelRow = (
  await import('../src/components/SidebarChannelRow.svelte')
).default;

const SELF_KEY = '0123abcd';
const OTHER_KEY = 'beefcafe';

function row(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: '',
    member: true,
    memberCount: 2,
    lastActivity: null,
    mode: 'public',
    visibility: 'public',
    createdAt: null,
    createdBy: null,
    myUnread: 0,
    unreadHasMention: false,
    myStarred: false,
    myMuted: false,
    ...overrides,
  };
}

async function bootstrapWith(store, rows) {
  apiGetMock.mockResolvedValueOnce(rows);
  await store._bootstrapChannelsForTest();
}

function makeStore() {
  const store = new MqttChatStore();
  store.userProfile.key = SELF_KEY;
  store.userProfile.name = 'me';
  store.userProfile.type = 'human';
  return store;
}

function makeIncoming(overrides = {}) {
  return {
    id: 'msg-' + Math.random().toString(16).slice(2, 10),
    ts: new Date().toISOString(),
    sender: { key: OTHER_KEY, name: 'them', type: 'human' },
    body: 'hi',
    mentions: null,
    ...overrides,
  };
}

function makeChannel(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: '',
    member: true,
    memberCount: 3,
    lastActivity: null,
    mode: 'public',
    visibility: 'public',
    createdAt: null,
    createdBy: null,
    unread: 0,
    unreadHasMention: false,
    unreadFrom: null,
    starred: false,
    muted: false,
    muteLevel: 'off',
    archived: false,
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  mcpCallMock.mockResolvedValue({ success: true, payload: {} });
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    /* jsdom may not provide localStorage */
  }
});

afterEach(() => {
  cleanup();
});

// ── 1. Store accessors ────────────────────────────────────────────

describe('Step 3.9 (Wave G) - notification-policy store accessors', () => {
  it('getNotificationPolicy returns defaults for unconfigured channels', () => {
    const store = makeStore();
    const result = store.getNotificationPolicy('any-channel');
    expect(result).toEqual({ policy: 'All', highlightWords: [] });
  });

  it('setNotificationPolicy round-trips via localStorage and bumps the reactive map', () => {
    const store = makeStore();
    const result = store.setNotificationPolicy('general', 'Mentions', [
      'release',
      'bug',
    ]);
    expect(result.success).toBe(true);

    // Reactive cache reflects the write.
    expect(store.notificationPolicies['general']).toEqual({
      policy: 'Mentions',
      highlightWords: ['release', 'bug'],
    });

    // localStorage carries the JSON-encoded blob under the pinned key.
    const raw = localStorage.getItem('cc:notif-policy:general');
    expect(raw).toBeTruthy();
    const decoded = JSON.parse(raw);
    expect(decoded.policy).toBe('Mentions');
    expect(decoded.highlightWords).toEqual(['release', 'bug']);

    // A fresh store instance reads from localStorage on first access.
    const store2 = makeStore();
    const reread = store2.getNotificationPolicy('general');
    expect(reread.policy).toBe('Mentions');
    expect(reread.highlightWords).toEqual(['release', 'bug']);
  });

  it('cycleNotificationPolicy advances All -> Mentions -> Off -> All', () => {
    const store = makeStore();
    expect(store.getNotificationPolicy('general').policy).toBe('All');

    expect(store.cycleNotificationPolicy('general')).toBe('Mentions');
    expect(store.getNotificationPolicy('general').policy).toBe('Mentions');

    expect(store.cycleNotificationPolicy('general')).toBe('Off');
    expect(store.getNotificationPolicy('general').policy).toBe('Off');

    expect(store.cycleNotificationPolicy('general')).toBe('All');
    expect(store.getNotificationPolicy('general').policy).toBe('All');
  });

  it('setNotificationPolicy preserves highlightWords when omitted; lowercases + trims on write', () => {
    const store = makeStore();
    store.setNotificationPolicy('general', 'Mentions', [
      '  Release  ',
      'BUG',
      '',
      'deploy',
    ]);
    expect(store.getNotificationPolicy('general').highlightWords).toEqual([
      'release',
      'bug',
      'deploy',
    ]);

    // Omitting the third arg preserves the existing list.
    store.setNotificationPolicy('general', 'Off');
    expect(store.getNotificationPolicy('general')).toEqual({
      policy: 'Off',
      highlightWords: ['release', 'bug', 'deploy'],
    });
  });
});

// ── 2. NotificationPolicyMenu UI ──────────────────────────────────

describe('Step 3.9 (Wave G) - NotificationPolicyMenu UI', () => {
  it('radio toggle picks the new policy on Save', async () => {
    const onSave = vi.fn();
    const { getByTestId } = render(NotificationPolicyMenu, {
      props: {
        channelId: 'general',
        currentPolicy: 'All',
        currentHighlightWords: [],
        onSave,
        onCancel: vi.fn(),
      },
    });

    const radioMentions = getByTestId('notif-policy-radio-Mentions');
    await fireEvent.click(radioMentions);
    await tick();

    await fireEvent.click(getByTestId('notif-policy-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].policy).toBe('Mentions');
    expect(onSave.mock.calls[0][0].highlightWords).toEqual([]);
  });

  it('highlight-words text input splits comma-separated tokens on Save', async () => {
    const onSave = vi.fn();
    const { getByTestId } = render(NotificationPolicyMenu, {
      props: {
        channelId: 'general',
        currentPolicy: 'Mentions',
        currentHighlightWords: ['release', 'bug'],
        onSave,
        onCancel: vi.fn(),
      },
    });

    const wordsInput = getByTestId('notif-policy-highlight-words');
    expect(wordsInput.value).toBe('release, bug');

    await fireEvent.input(wordsInput, {
      target: { value: 'release, bug,  deploy , ,foo' },
    });
    await tick();

    await fireEvent.click(getByTestId('notif-policy-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    // Parsed tokens: trimmed + empty-filtered. Lowercasing happens at
    // the store layer (setNotificationPolicy), not in the dialog.
    expect(onSave.mock.calls[0][0].highlightWords).toEqual([
      'release',
      'bug',
      'deploy',
      'foo',
    ]);
  });

  it('Cancel button discards changes and fires onCancel', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const { getByTestId } = render(NotificationPolicyMenu, {
      props: {
        channelId: 'general',
        currentPolicy: 'All',
        currentHighlightWords: [],
        onSave,
        onCancel,
      },
    });

    await fireEvent.click(getByTestId('notif-policy-radio-Off'));
    await fireEvent.click(getByTestId('notif-policy-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ── 3. ChannelContextMenu Q8 quickview ────────────────────────────

describe('Step 3.9 (Wave G) - ChannelContextMenu quickview row', () => {
  it('renders "Notifications: <policy>" quickview row at the top', () => {
    const { getByTestId } = render(ChannelContextMenu, {
      props: {
        channel: { id: 'general', name: 'general', member: true, starred: false, muted: false, unread: 0, createdBy: 'alice' },
        anchorEvent: { clientX: 100, clientY: 100 },
        isMember: true,
        isCreator: false,
        onAction: vi.fn(),
        onClose: vi.fn(),
        currentNotificationPolicy: { policy: 'Mentions', highlightWords: ['ship'] },
      },
    });
    const quickRow = getByTestId('channel-ctx-item-notif:cycle');
    expect(quickRow).toBeTruthy();
    expect(quickRow.textContent).toMatch(/Notifications:\s*Mentions/);
    expect(quickRow.getAttribute('data-quickview')).toBe('true');
  });

  it('clicking the quickview row fires actionId="notif:cycle" and closes the menu', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(ChannelContextMenu, {
      props: {
        channel: { id: 'general', name: 'general', member: true, starred: false, muted: false, unread: 0, createdBy: 'alice' },
        anchorEvent: { clientX: 100, clientY: 100 },
        isMember: true,
        isCreator: false,
        onAction,
        onClose,
        currentNotificationPolicy: { policy: 'All', highlightWords: [] },
      },
    });
    await fireEvent.click(getByTestId('channel-ctx-item-notif:cycle'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toBe('notif:cycle');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── 4. SidebarChannelRow bell-icon variant ────────────────────────

describe('Step 3.9 (Wave G) - SidebarChannelRow bell variant', () => {
  it('renders the BellDot variant when notificationPolicy.policy === "Mentions"', () => {
    const { getByTestId } = render(SidebarChannelRow, {
      props: {
        channel: makeChannel(),
        isActive: false,
        sectionVariant: 'active',
        onClick: vi.fn(),
        onContextMenu: vi.fn(),
        onStarToggle: vi.fn(),
        notificationPolicy: { policy: 'Mentions', highlightWords: [] },
      },
    });
    const bell = getByTestId('row-notif-bell-general');
    expect(bell).toBeTruthy();
    expect(bell.getAttribute('data-policy')).toBe('Mentions');
    expect(bell.classList.contains('variant-mentions')).toBe(true);
  });

  it('renders the BellOff variant when notificationPolicy.policy === "Off"; "All" hides the bell', () => {
    // Off → bell rendered with variant-off.
    const offRender = render(SidebarChannelRow, {
      props: {
        channel: makeChannel(),
        isActive: false,
        sectionVariant: 'active',
        onClick: vi.fn(),
        onContextMenu: vi.fn(),
        onStarToggle: vi.fn(),
        notificationPolicy: { policy: 'Off', highlightWords: [] },
      },
    });
    const offBell = offRender.getByTestId('row-notif-bell-general');
    expect(offBell.getAttribute('data-policy')).toBe('Off');
    expect(offBell.classList.contains('variant-off')).toBe(true);
    offRender.unmount();

    // All → no bell rendered at all (default / control case).
    const allRender = render(SidebarChannelRow, {
      props: {
        channel: makeChannel(),
        isActive: false,
        sectionVariant: 'active',
        onClick: vi.fn(),
        onContextMenu: vi.fn(),
        onStarToggle: vi.fn(),
        notificationPolicy: { policy: 'All', highlightWords: [] },
      },
    });
    expect(allRender.queryByTestId('row-notif-bell-general')).toBeNull();
  });
});

// ── 5. Highlight-word match in #handleChatMessage ─────────────────

describe('Step 3.9 (Wave G) - highlight-word match raises unreadHasMention', () => {
  it('case-insensitive substring match flips unreadHasMention=true on a non-mention message', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: false })]);
    store.activeChannel = 'somewhere-else';
    store.setNotificationPolicy('general', 'Mentions', ['Release']);

    expect(store.channelsById.general.unreadHasMention).toBe(false);

    store._handleChatMessageForTest(
      'general',
      makeIncoming({
        body: 'we are shipping the RELEASE today',
        mentions: null,
      }),
    );

    expect(store.channelsById.general.unread).toBe(1);
    expect(store.channelsById.general.unreadHasMention).toBe(true);
  });

  it('multiple configured words: any match raises the dot', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: false })]);
    store.activeChannel = 'somewhere-else';
    store.setNotificationPolicy('general', 'Mentions', [
      'release',
      'bug',
      'deploy',
    ]);

    store._handleChatMessageForTest(
      'general',
      makeIncoming({ body: 'production deploy in 5 minutes' }),
    );

    expect(store.channelsById.general.unreadHasMention).toBe(true);
  });

  it('empty list or non-matching body: unreadHasMention stays false', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myMuted: false })]);
    store.activeChannel = 'somewhere-else';

    // No words configured at all (default state).
    store._handleChatMessageForTest(
      'general',
      makeIncoming({ body: 'no highlight words configured here' }),
    );
    expect(store.channelsById.general.unreadHasMention).toBe(false);

    // Words configured but the body misses every one of them.
    store.setNotificationPolicy('general', 'Mentions', ['release', 'bug']);
    store._handleChatMessageForTest(
      'general',
      makeIncoming({ body: 'lunch plans anyone?' }),
    );
    // unread bumps but the mention flag stays false (control case for
    // the highlight-word match branch).
    expect(store.channelsById.general.unread).toBe(2);
    expect(store.channelsById.general.unreadHasMention).toBe(false);
  });
});
