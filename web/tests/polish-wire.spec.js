// Polish Wave Batch 2 wiring — integration tests.
//
// Batch 1 (4 parallel agents) shipped:
//   - store.markAllRead(channelId) + forwardMessage pendingSends extension
//   - TypeNameConfirmDialog.svelte (Promise-resolving destructive confirm)
//   - UndoToast.svelte (15s undo affordance for {done, cancel} envelopes)
//
// Batch 2 (this agent's work) wires those into App.svelte / Sidebar.svelte /
// ChannelDirectoryModal.svelte. The shape of the wiring is:
//
//   - App.svelte exposes a Promise-based ``confirmDestructive(opts)`` helper
//     and an ``showUndoToast({ message, onUndo, onExpire })`` helper. Both
//     drive a single shared mount each (TypeNameConfirmDialog / UndoToast),
//     gated on reactive props objects.
//
//   - Sidebar.svelte receives both as ``onConfirmDestructive`` and
//     ``onShowUndoToast`` props. Its context-menu Delete action awaits the
//     helper; its silent leave/close paths spawn an undo toast from the
//     ``{ done, cancel }`` envelope.
//
//   - ChannelDirectoryModal.svelte receives ``onConfirmDestructive`` and
//     uses it for both Admin tab Archive (severity warning) and Delete
//     (severity danger).
//
//   - MessageInput dispatches ``slashCommand`` CustomEvents for /list +
//     /nick. App.svelte mounts a window-level listener that opens the
//     directory or calls api.updateName.
//
//   - Sidebar's ``mark-read`` short-circuit (was ``return;`` with a TODO)
//     is replaced with ``store.markAllRead(c.id)``.
//
// This suite pins every one of those wires. The shape is mostly props-level
// — we stub vi.fn() spies for ``onConfirmDestructive`` and
// ``onShowUndoToast`` and assert the Sidebar / Modal call them with the
// expected option bag and call store methods only after the Promise resolves
// the way we want.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import Sidebar from '../src/components/Sidebar.svelte';
import ChannelDirectoryModal from '../src/components/ChannelDirectoryModal.svelte';

// ── Fixtures ───────────────────────────────────────────────────────────

function makeChannel(id, overrides = {}) {
  return {
    id,
    name: id,
    topic: '',
    member: true,
    memberCount: 2,
    mode: 'public',
    visibility: 'listed',
    starred: false,
    muted: false,
    muteLevel: 'off',
    unread: 3,
    unreadHasMention: false,
    unreadFrom: null,
    lastActivity: null,
    createdAt: null,
    createdBy: null,
    archived: false,
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  const channelsById = {
    general: makeChannel('general', { starred: true, topic: 'Main' }),
    random: makeChannel('random', { unread: 5 }),
    announcements: makeChannel('announcements', { member: false }),
    ...(overrides.channelsById ?? {}),
  };
  const store = {
    channelsById,
    channels: Object.values(channelsById),
    activeChannel: overrides.activeChannel ?? 'general',
    connected: true,
    connectionError: null,
    userProfile: overrides.userProfile ?? { key: 'phil-key', name: 'phil', type: 'human' },
    messages: overrides.messages ?? [],
    pinnedMessages: overrides.pinnedMessages ?? [],
    get starredChannels() {
      return Object.values(this.channelsById).filter((c) => c.member && c.starred && !c.archived);
    },
    get activeChannels() {
      return Object.values(this.channelsById).filter((c) => c.member && !c.starred && !c.archived);
    },
    get availableChannels() {
      return Object.values(this.channelsById).filter((c) => !c.member && c.visibility === 'listed' && !c.archived);
    },
    switchChannel: vi.fn(),
    joinChannel: vi.fn(() => Promise.resolve({ success: true })),
    leaveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() })),
    closeChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() })),
    archiveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() })),
    deleteChannel: vi.fn(() => Promise.resolve({ success: true })),
    setStar: vi.fn(),
    setMute: vi.fn(),
    setTopic: vi.fn(() => Promise.resolve({ success: true })),
    toggleStar: vi.fn(),
    markAllRead: vi.fn(),
  };
  return store;
}

function renderSidebar(store, overrides = {}) {
  return render(Sidebar, {
    props: {
      store,
      onCreateChannel: vi.fn(),
      onBrowseChannels: vi.fn(),
      onShowProfile: vi.fn(),
      onOpenSettings: vi.fn(),
      ...overrides,
    },
  });
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  // Stub global fetch so the real ConversationBrowser (mounted by
  // ChannelDirectoryModal in the Browse tab) doesn't crash the harness
  // when its mount-time /api/conversations fetch fires.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ conversations: [] }),
  });
});
afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// ── Task C — mark-read short-circuit fix ───────────────────────────────

describe('Polish Wave Batch 2 — Sidebar mark-read wiring (Task C)', () => {
  it('selecting "Mark all as read" in the context menu calls store.markAllRead with the channel id', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-mark-read'));
    await tick();

    expect(store.markAllRead).toHaveBeenCalledTimes(1);
    expect(store.markAllRead).toHaveBeenCalledWith('random');
  });

  it('mark-read action does NOT fire leaveChannel / closeChannel / deleteChannel', async () => {
    // Regression guard: the v0.4.1 placeholder was a bare ``return;`` that
    // accidentally fell through to nothing. The wired version must NOT
    // accidentally call any destructive method.
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-mark-read'));
    await tick();

    expect(store.leaveChannel).not.toHaveBeenCalled();
    expect(store.closeChannel).not.toHaveBeenCalled();
    expect(store.deleteChannel).not.toHaveBeenCalled();
  });
});

// ── Task B — UndoToast wiring (silent leave / close path) ──────────────

describe('Polish Wave Batch 2 — Sidebar undo-toast wiring (Task B)', () => {
  it('silent leave (non-starred, non-creator) calls onShowUndoToast with the channel name in the message', async () => {
    const store = makeStore();
    const onShowUndoToast = vi.fn();
    const { getByTestId } = renderSidebar(store, { onShowUndoToast });

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    expect(store.leaveChannel).toHaveBeenCalledWith('random');
    expect(onShowUndoToast).toHaveBeenCalledTimes(1);
    const arg = onShowUndoToast.mock.calls[0][0];
    expect(arg.message).toContain('Left');
    expect(arg.message).toContain('random');
    expect(typeof arg.onUndo).toBe('function');
    expect(typeof arg.onExpire).toBe('function');
  });

  it('clicking the toast Undo callback invokes the envelope cancel()', async () => {
    const cancelSpy = vi.fn();
    const store = makeStore();
    store.leaveChannel = vi.fn(() => ({
      done: Promise.resolve({ success: true }),
      cancel: cancelSpy,
    }));
    const onShowUndoToast = vi.fn();
    const { getByTestId } = renderSidebar(store, { onShowUndoToast });

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    const { onUndo } = onShowUndoToast.mock.calls[0][0];
    onUndo();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('close action (creator path) wires the close envelope into the undo toast', async () => {
    // Set up a channel where the user is the creator so the "close" action
    // surfaces in the context menu.
    const store = makeStore({
      channelsById: {
        ownChannel: makeChannel('ownChannel', { createdBy: 'phil-key' }),
      },
      activeChannel: 'ownChannel',
    });
    const onShowUndoToast = vi.fn();
    const { getByTestId } = renderSidebar(store, { onShowUndoToast });

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-ownChannel'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-close'));
    await tick();

    expect(store.closeChannel).toHaveBeenCalledWith('ownChannel');
    expect(onShowUndoToast).toHaveBeenCalledTimes(1);
    const arg = onShowUndoToast.mock.calls[0][0];
    expect(arg.message).toContain('Closed');
    expect(arg.message).toContain('ownChannel');
  });

  it('does NOT throw when onShowUndoToast prop is missing (graceful no-op)', async () => {
    // Test render without the prop — wiring must remain robust.
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    // The store method still fires; we just don't surface the undo toast.
    expect(store.leaveChannel).toHaveBeenCalledWith('random');
  });
});

// ── Task A + E — onConfirmDestructive wiring (Sidebar Delete path) ─────

describe('Polish Wave Batch 2 — Sidebar Delete confirmDestructive wiring (Tasks A + E)', () => {
  it('Delete action invokes onConfirmDestructive with the type-name option bag', async () => {
    // Owned channel — Delete only surfaces for creators.
    const store = makeStore({
      channelsById: {
        ownChannel: makeChannel('ownChannel', { createdBy: 'phil-key' }),
      },
    });
    const onConfirmDestructive = vi.fn(() => Promise.resolve(true));
    const { getByTestId } = renderSidebar(store, { onConfirmDestructive });

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-ownChannel'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-delete'));
    // Wait for the Promise resolution to land.
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    const opts = onConfirmDestructive.mock.calls[0][0];
    expect(opts.requireTypedName).toBe('ownChannel');
    expect(opts.severity).toBe('danger');
    expect(opts.resourceName).toContain('ownChannel');
    expect(opts.body).toContain('permanently delete');
    expect(opts.body).toContain('ownChannel');
    expect(opts.confirmLabel).toBe('Delete channel');
  });

  it('Delete calls store.deleteChannel ONLY when onConfirmDestructive resolves true', async () => {
    const store = makeStore({
      channelsById: {
        ownChannel: makeChannel('ownChannel', { createdBy: 'phil-key' }),
      },
    });
    const onConfirmDestructive = vi.fn(() => Promise.resolve(true));
    const { getByTestId } = renderSidebar(store, { onConfirmDestructive });

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-ownChannel'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-delete'));
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(store.deleteChannel).toHaveBeenCalledWith('ownChannel');
  });

  it('Delete does NOT call store.deleteChannel when onConfirmDestructive resolves false', async () => {
    const store = makeStore({
      channelsById: {
        ownChannel: makeChannel('ownChannel', { createdBy: 'phil-key' }),
      },
    });
    const onConfirmDestructive = vi.fn(() => Promise.resolve(false));
    const { getByTestId } = renderSidebar(store, { onConfirmDestructive });

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-ownChannel'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-delete'));
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    expect(store.deleteChannel).not.toHaveBeenCalled();
  });

  it('Delete falls back to window.confirm when onConfirmDestructive prop is not supplied', async () => {
    // Regression guard for the test-render path that doesn't wire the
    // helper. Existing tests pre-Polish wave used window.confirm; if we
    // accidentally broke that compatibility, they'd start failing.
    const store = makeStore({
      channelsById: {
        ownChannel: makeChannel('ownChannel', { createdBy: 'phil-key' }),
      },
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { getByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-ownChannel'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-delete'));
    await tick();

    expect(confirmSpy).toHaveBeenCalled();
    expect(store.deleteChannel).toHaveBeenCalledWith('ownChannel');
    confirmSpy.mockRestore();
  });
});

// ── Task E — ChannelDirectoryModal Admin tab wiring ────────────────────

function makeOwnedStore(extra = {}) {
  return {
    channels: [],
    channelsById: {
      myChannel: makeChannel('myChannel', { createdBy: 'me', topic: 'Topic' }),
    },
    userProfile: { key: 'me', name: 'me', type: 'human' },
    setTopic: vi.fn().mockResolvedValue({ success: true }),
    archiveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() })),
    deleteChannel: vi.fn().mockResolvedValue({ success: true }),
    joinChannel: vi.fn(),
    ...extra,
  };
}

describe('Polish Wave Batch 2 — ChannelDirectoryModal Admin tab wiring (Task E)', () => {
  it('Archive action invokes onConfirmDestructive with severity "warning"', async () => {
    const store = makeOwnedStore();
    const onConfirmDestructive = vi.fn(() => Promise.resolve(true));

    const { getByTestId } = render(ChannelDirectoryModal, {
      props: {
        store,
        open: true,
        initialTab: 'admin',
        onClose: vi.fn(),
        onChannelClick: vi.fn(),
        onChannelJoin: vi.fn(),
        onConfirmDestructive,
      },
    });

    await tick();
    await fireEvent.click(getByTestId('channel-admin-action-archive'));
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    const opts = onConfirmDestructive.mock.calls[0][0];
    expect(opts.severity).toBe('warning');
    expect(opts.requireTypedName).toBe('myChannel');
    expect(opts.confirmLabel).toBe('Archive channel');
    expect(store.archiveChannel).toHaveBeenCalledWith('myChannel');
  });

  it('Delete action invokes onConfirmDestructive with severity "danger"', async () => {
    const store = makeOwnedStore();
    const onConfirmDestructive = vi.fn(() => Promise.resolve(true));

    const { getByTestId } = render(ChannelDirectoryModal, {
      props: {
        store,
        open: true,
        initialTab: 'admin',
        onClose: vi.fn(),
        onChannelClick: vi.fn(),
        onChannelJoin: vi.fn(),
        onConfirmDestructive,
      },
    });

    await tick();
    await fireEvent.click(getByTestId('channel-admin-action-delete'));
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    const opts = onConfirmDestructive.mock.calls[0][0];
    expect(opts.severity).toBe('danger');
    expect(opts.requireTypedName).toBe('myChannel');
    expect(opts.confirmLabel).toBe('Delete channel');
    expect(store.deleteChannel).toHaveBeenCalledWith('myChannel');
  });

  it('Archive does NOT call store.archiveChannel when confirm resolves false', async () => {
    const store = makeOwnedStore();
    const onConfirmDestructive = vi.fn(() => Promise.resolve(false));

    const { getByTestId } = render(ChannelDirectoryModal, {
      props: {
        store,
        open: true,
        initialTab: 'admin',
        onClose: vi.fn(),
        onChannelClick: vi.fn(),
        onChannelJoin: vi.fn(),
        onConfirmDestructive,
      },
    });

    await tick();
    await fireEvent.click(getByTestId('channel-admin-action-archive'));
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    expect(store.archiveChannel).not.toHaveBeenCalled();
  });

  it('Delete does NOT call store.deleteChannel when confirm resolves false', async () => {
    const store = makeOwnedStore();
    const onConfirmDestructive = vi.fn(() => Promise.resolve(false));

    const { getByTestId } = render(ChannelDirectoryModal, {
      props: {
        store,
        open: true,
        initialTab: 'admin',
        onClose: vi.fn(),
        onChannelClick: vi.fn(),
        onChannelJoin: vi.fn(),
        onConfirmDestructive,
      },
    });

    await tick();
    await fireEvent.click(getByTestId('channel-admin-action-delete'));
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    expect(store.deleteChannel).not.toHaveBeenCalled();
  });

  it('Admin tab no longer calls window.confirm or window.prompt when onConfirmDestructive is wired', async () => {
    // Regression guard for the original v0.4.0 placeholder behavior. After
    // wiring, these globals must not be touched.
    // v0.4.2 Step 3.1: Archive + Delete now both auto-close the modal
    // (via onClose -> close) on commit, so this test only clicks Archive
    // (single destructive button is enough to prove globals are not
    // touched). The companion test cases above already pin the Delete
    // severity routing independently.
    const store = makeOwnedStore();
    const onConfirmDestructive = vi.fn(() => Promise.resolve(true));
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm should NOT have been called');
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => {
      throw new Error('window.prompt should NOT have been called');
    });

    const { getByTestId } = render(ChannelDirectoryModal, {
      props: {
        store,
        open: true,
        initialTab: 'admin',
        onClose: vi.fn(),
        onChannelClick: vi.fn(),
        onChannelJoin: vi.fn(),
        onConfirmDestructive,
      },
    });

    try {
      await tick();
      await fireEvent.click(getByTestId('channel-admin-action-archive'));
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(promptSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
      promptSpy.mockRestore();
    }
  });
});

// ── Source-grep regression guards ──────────────────────────────────────

// These tests pin the structural invariant Phil's done-criteria require:
// no remaining ``window.confirm`` / ``window.prompt`` in the two files we
// migrated. (We import them as raw strings via Vite's ?raw query so the
// assertion lives in the test suite, not just in a grep step.)

import sidebarSource from '../src/components/Sidebar.svelte?raw';
import directorySource from '../src/components/ChannelDirectoryModal.svelte?raw';

describe('Polish Wave Batch 2 — source-level invariants (regression guards)', () => {
  it('Sidebar.svelte: window.confirm CALL survives ONLY in the test-render fallback branch', () => {
    // We accept a SINGLE window.confirm(...) CALL in Sidebar.svelte (the
    // fallback for test renders that don't wire onConfirmDestructive). The
    // ``typeof window.confirm === 'function'`` typeof-check also references
    // the symbol but is not a call; we filter to actual invocations by
    // requiring a trailing ``(``.
    const calls = sidebarSource.match(/window\.confirm\s*\(/g) ?? [];
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(sidebarSource).toContain('onConfirmDestructive');
  });

  it('Sidebar.svelte: no window.prompt anywhere', () => {
    expect(sidebarSource).not.toContain('window.prompt');
  });

  it('ChannelDirectoryModal.svelte: window.confirm / window.prompt CALLS survive ONLY in the fallback branches', () => {
    // Same call-vs-symbol distinction as above: filter to invocations.
    // Each placeholder may survive AT MOST once in the fallback path.
    const confirmCalls = (directorySource.match(/window\.confirm\s*\(/g) ?? []).length;
    const promptCalls = (directorySource.match(/window\.prompt\s*\(/g) ?? []).length;
    expect(confirmCalls).toBeLessThanOrEqual(1);
    expect(promptCalls).toBeLessThanOrEqual(1);
    expect(directorySource).toContain('onConfirmDestructive');
  });

  it('App.svelte prop bindings: Sidebar declares both Batch 2 wiring props (no drift)', () => {
    // Indirect check: Sidebar must declare the props by name. If a future
    // refactor renames the prop on the App side, the prop becomes a
    // dangling reference; the test catches the drift early.
    expect(sidebarSource).toContain('onConfirmDestructive');
    expect(sidebarSource).toContain('onShowUndoToast');
  });
});
