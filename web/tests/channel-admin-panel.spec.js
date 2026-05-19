// Tests for ChannelAdminPanel.svelte — v0.4.2 Step 3.1.
//
// The panel is the per-channel admin actions surface mounted inside
// ChannelDirectoryModal's Admin tab. Action visibility is gated by the
// `currentChannelRole` prop per Q6 lock-in (2026-05-13):
//
//   - 'owner'  -> Rename, Edit topic, Visibility, Mode, Transfer,
//                 Archive, Delete  (all 6 destructive/admin actions)
//   - 'admin'  -> Rename, Edit topic, Visibility, Mode, Archive
//                 (no Transfer, no Delete)
//   - 'member' -> empty state ("You don't have admin rights ...")
//   - null     -> skeleton placeholder ("Loading admin actions...")
//
// Destructive actions route through the shared onConfirmDestructive
// helper prop-drilled from App.svelte:
//
//   - Archive  -> severity: 'warning' (skips typed-name gate)
//   - Delete   -> severity: 'danger'  (typed-name required)
//   - Transfer -> severity: 'danger'  (typed-name required)
//
// What this suite pins (>=15 cases):
//
//   1. Role gating
//      - Owner sees all 6 actions.
//      - Admin sees 4 actions (no Transfer, no Delete).
//      - Member sees the empty state, no action buttons.
//      - null role renders the skeleton placeholder.
//
//   2. Severity routing
//      - Archive click invokes onConfirmDestructive with severity 'warning'.
//      - Delete click invokes onConfirmDestructive with severity 'danger'.
//      - Transfer click invokes onConfirmDestructive with severity 'danger'.
//
//   3. Store wiring
//      - Confirmed Archive calls store.archiveChannel(id).
//      - Confirmed Delete calls store.deleteChannel(id).
//      - Cancelled Archive does NOT call store.archiveChannel.
//      - Cancelled Delete does NOT call store.deleteChannel.
//
//   4. Inline editing
//      - Rename click opens the inline name input.
//      - Edit topic click opens the inline topic input.
//      - Visibility button toggles label based on current value.
//      - Mode button toggles label based on current value.
//
//   5. onClose
//      - Successful Archive invokes onClose.
//      - Successful Delete invokes onClose.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ChannelAdminPanel from '../src/components/ChannelAdminPanel.svelte';

// ── Helpers ────────────────────────────────────────────────────────────

function makeChannel(overrides = {}) {
  return {
    id: 'ch-1',
    name: 'general',
    topic: 'Hello world',
    mode: 'open',
    visibility: 'public',
    createdBy: 'me',
    archived: false,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    archiveChannel:
      overrides.archiveChannel ??
      vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() })),
    deleteChannel:
      overrides.deleteChannel ?? vi.fn().mockResolvedValue({ success: true }),
    setTopic: overrides.setTopic ?? vi.fn().mockResolvedValue({ success: true }),
    renameChannel: overrides.renameChannel,
    setVisibility: overrides.setVisibility,
    setMode: overrides.setMode,
    transferOwnership: overrides.transferOwnership,
  };
}

function makeProps(overrides = {}) {
  return {
    channel: overrides.channel ?? makeChannel(),
    // Note: use `in overrides` rather than `?? 'owner'` so a caller
    // passing `currentChannelRole: null` exercises the hydrating path.
    currentChannelRole: 'currentChannelRole' in overrides ? overrides.currentChannelRole : 'owner',
    store: overrides.store ?? makeStore(),
    onConfirmDestructive:
      overrides.onConfirmDestructive ?? vi.fn().mockResolvedValue(true),
    onClose: overrides.onClose ?? vi.fn(),
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

afterEach(() => {
  cleanup();
});

// ── 1. Role gating ─────────────────────────────────────────────────────

describe('ChannelAdminPanel: role gating', () => {
  it('owner role exposes all 6 admin actions (rename, visibility, mode, transfer, archive, delete) plus edit topic', () => {
    const props = makeProps({ currentChannelRole: 'owner' });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    expect(getByTestId('channel-admin-panel').getAttribute('data-role')).toBe('owner');
    expect(getByTestId('channel-admin-action-rename')).not.toBeNull();
    expect(getByTestId('channel-admin-action-edit-topic')).not.toBeNull();
    expect(getByTestId('channel-admin-action-visibility')).not.toBeNull();
    expect(getByTestId('channel-admin-action-mode')).not.toBeNull();
    expect(getByTestId('channel-admin-action-transfer')).not.toBeNull();
    expect(getByTestId('channel-admin-action-archive')).not.toBeNull();
    expect(getByTestId('channel-admin-action-delete')).not.toBeNull();
  });

  it('admin role hides Transfer and Delete but keeps Rename/Topic/Visibility/Mode/Archive', () => {
    const props = makeProps({ currentChannelRole: 'admin' });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });
    expect(getByTestId('channel-admin-panel').getAttribute('data-role')).toBe('admin');
    expect(getByTestId('channel-admin-action-rename')).not.toBeNull();
    expect(getByTestId('channel-admin-action-edit-topic')).not.toBeNull();
    expect(getByTestId('channel-admin-action-visibility')).not.toBeNull();
    expect(getByTestId('channel-admin-action-mode')).not.toBeNull();
    expect(getByTestId('channel-admin-action-archive')).not.toBeNull();
    expect(queryByTestId('channel-admin-action-transfer')).toBeNull();
    expect(queryByTestId('channel-admin-action-delete')).toBeNull();
  });

  it('member role renders the empty state and zero action buttons', () => {
    const props = makeProps({ currentChannelRole: 'member' });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });
    expect(getByTestId('channel-admin-empty-member')).not.toBeNull();
    expect(queryByTestId('channel-admin-action-rename')).toBeNull();
    expect(queryByTestId('channel-admin-action-archive')).toBeNull();
    expect(queryByTestId('channel-admin-action-delete')).toBeNull();
    expect(queryByTestId('channel-admin-action-transfer')).toBeNull();
  });

  it('null role renders the hydrating skeleton', () => {
    const props = makeProps({ currentChannelRole: null });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });
    expect(getByTestId('channel-admin-panel').getAttribute('data-role')).toBe('hydrating');
    expect(getByTestId('channel-admin-skeleton')).not.toBeNull();
    expect(queryByTestId('channel-admin-actions')).toBeNull();
  });
});

// ── 2. Severity routing ────────────────────────────────────────────────

describe('ChannelAdminPanel: severity routing', () => {
  it('Archive click invokes onConfirmDestructive with severity warning', async () => {
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const props = makeProps({ currentChannelRole: 'owner', onConfirmDestructive });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-archive'));
    await flush();
    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    const opts = onConfirmDestructive.mock.calls[0][0];
    expect(opts.severity).toBe('warning');
    expect(opts.requireTypedName).toBe('general');
    expect(opts.confirmLabel).toBe('Archive channel');
  });

  it('Delete click invokes onConfirmDestructive with severity danger', async () => {
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const props = makeProps({ currentChannelRole: 'owner', onConfirmDestructive });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-delete'));
    await flush();
    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    const opts = onConfirmDestructive.mock.calls[0][0];
    expect(opts.severity).toBe('danger');
    expect(opts.requireTypedName).toBe('general');
    expect(opts.confirmLabel).toBe('Delete channel');
  });

  it('Transfer ownership click opens the new-owner picker (no immediate confirm)', async () => {
    // v0.4.2 Wave C [VERIFY-3.6b-4]: Transfer is now a two-step UX.
    // The initial click opens the picker; confirmDestructive only
    // fires after the user selects a member and clicks Confirm.
    // The picker + Confirm path is covered in
    // tests/channel-admin-panel-transfer.spec.js. Here we just pin
    // the new "click opens picker, no immediate wire call" contract.
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const props = makeProps({ currentChannelRole: 'owner', onConfirmDestructive });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });
    expect(queryByTestId('channel-admin-transfer-picker')).toBeNull();
    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();
    // confirmDestructive NOT called yet — picker is the gating step.
    expect(onConfirmDestructive).not.toHaveBeenCalled();
    // Picker is now visible.
    expect(getByTestId('channel-admin-transfer-picker')).not.toBeNull();
  });
});

// ── 3. Store wiring ────────────────────────────────────────────────────

describe('ChannelAdminPanel: store wiring', () => {
  it('confirmed Archive calls store.archiveChannel(id) and triggers onClose', async () => {
    const store = makeStore();
    const onConfirmDestructive = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    const props = makeProps({
      currentChannelRole: 'owner',
      store,
      onConfirmDestructive,
      onClose,
    });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-archive'));
    await flush();
    expect(store.archiveChannel).toHaveBeenCalledWith('ch-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('confirmed Delete calls store.deleteChannel(id) and triggers onClose', async () => {
    const store = makeStore();
    const onConfirmDestructive = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    const props = makeProps({
      currentChannelRole: 'owner',
      store,
      onConfirmDestructive,
      onClose,
    });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-delete'));
    await flush();
    expect(store.deleteChannel).toHaveBeenCalledWith('ch-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancelled Archive does NOT call store.archiveChannel and does NOT trigger onClose', async () => {
    const store = makeStore();
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    const props = makeProps({
      currentChannelRole: 'owner',
      store,
      onConfirmDestructive,
      onClose,
    });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-archive'));
    await flush();
    expect(store.archiveChannel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancelled Delete does NOT call store.deleteChannel and does NOT trigger onClose', async () => {
    const store = makeStore();
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    const props = makeProps({
      currentChannelRole: 'owner',
      store,
      onConfirmDestructive,
      onClose,
    });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-delete'));
    await flush();
    expect(store.deleteChannel).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancelled Transfer does NOT call store.transferOwnership', async () => {
    const transferOwnership = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ transferOwnership });
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const props = makeProps({
      currentChannelRole: 'owner',
      store,
      onConfirmDestructive,
    });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();
    expect(transferOwnership).not.toHaveBeenCalled();
  });
});

// ── 4. Inline editing ──────────────────────────────────────────────────

describe('ChannelAdminPanel: inline editing', () => {
  it('Rename click swaps the name span for an input', async () => {
    const props = makeProps({ currentChannelRole: 'owner' });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });
    expect(queryByTestId('channel-admin-name-input')).toBeNull();
    await fireEvent.click(getByTestId('channel-admin-action-rename'));
    await flush();
    expect(getByTestId('channel-admin-name-input')).not.toBeNull();
    expect(queryByTestId('channel-admin-name')).toBeNull();
  });

  it('Edit topic click swaps the topic text for an input', async () => {
    const props = makeProps({ currentChannelRole: 'owner' });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });
    expect(queryByTestId('channel-admin-topic-input')).toBeNull();
    await fireEvent.click(getByTestId('channel-admin-action-edit-topic'));
    await flush();
    expect(getByTestId('channel-admin-topic-input')).not.toBeNull();
  });

  it('Visibility button label flips between Make private and Make public based on channel.visibility', () => {
    const publicProps = makeProps({
      currentChannelRole: 'owner',
      channel: makeChannel({ visibility: 'public' }),
    });
    const { getByTestId, unmount } = render(ChannelAdminPanel, { props: publicProps });
    expect(getByTestId('channel-admin-action-visibility').textContent).toContain('Make private');
    unmount();

    const privateProps = makeProps({
      currentChannelRole: 'owner',
      channel: makeChannel({ visibility: 'private' }),
    });
    const { getByTestId: getByTestId2 } = render(ChannelAdminPanel, { props: privateProps });
    expect(getByTestId2('channel-admin-action-visibility').textContent).toContain('Make public');
  });

  it('Mode button label flips between Switch to open and Switch to invite-only based on channel.mode', () => {
    const openProps = makeProps({
      currentChannelRole: 'owner',
      channel: makeChannel({ mode: 'open' }),
    });
    const { getByTestId, unmount } = render(ChannelAdminPanel, { props: openProps });
    expect(getByTestId('channel-admin-action-mode').textContent).toContain('Switch to invite-only');
    unmount();

    const inviteProps = makeProps({
      currentChannelRole: 'owner',
      channel: makeChannel({ mode: 'invite' }),
    });
    const { getByTestId: getByTestId2 } = render(ChannelAdminPanel, { props: inviteProps });
    expect(getByTestId2('channel-admin-action-mode').textContent).toContain('Switch to open');
  });

  it('Visibility toggle calls store.setVisibility with the inverted value when available', async () => {
    const setVisibility = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ setVisibility });
    const props = makeProps({
      currentChannelRole: 'owner',
      store,
      channel: makeChannel({ visibility: 'public' }),
    });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-visibility'));
    await flush();
    expect(setVisibility).toHaveBeenCalledWith('ch-1', 'private');
  });

  it('Mode toggle calls store.setMode with the inverted value when available', async () => {
    const setMode = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ setMode });
    const props = makeProps({
      currentChannelRole: 'owner',
      store,
      channel: makeChannel({ mode: 'open' }),
    });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-mode'));
    await flush();
    expect(setMode).toHaveBeenCalledWith('ch-1', 'invite');
  });
});

// ── 5. Admin role destructive flows ───────────────────────────────────

describe('ChannelAdminPanel: admin role destructive paths', () => {
  it('admin role Archive routes through severity warning (same as owner)', async () => {
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const props = makeProps({ currentChannelRole: 'admin', onConfirmDestructive });
    const { getByTestId } = render(ChannelAdminPanel, { props });
    await fireEvent.click(getByTestId('channel-admin-action-archive'));
    await flush();
    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    expect(onConfirmDestructive.mock.calls[0][0].severity).toBe('warning');
  });
});
