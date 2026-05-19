// v0.4.2 Step 3.6b follow-up [VERIFY-3.6b-4] / Wave C — ChannelAdminPanel
// new-owner picker UX.
//
// Pre-Wave-C: clicking "Transfer ownership" jumped straight to the
// typed-name confirm dialog and then fired `store.transferOwnership(id)`
// (1-arg) which the store accessor rejected with `{ success: false,
// error: 'New-owner key required.' }`. The transfer never persisted.
//
// New behavior (this spec pins it):
//
//   1. Click "Transfer ownership" -> picker dropdown opens, listing
//      every channel member EXCLUDING the caller, sorted by name.
//      `confirmDestructive` is NOT called yet.
//   2. Empty-member case: picker shows an inline "No eligible members"
//      hint; Confirm button is disabled.
//   3. Pick a member + click Confirm -> `confirmDestructive` opens with
//      severity 'danger' + the channel name as the typed-name gate.
//      On confirm, `store.transferOwnership(channelId, pickedKey)` is
//      called with the 2-arg signature.
//   4. Cancel button (or re-click Transfer ownership) collapses the
//      picker without firing the wire call.
//   5. confirmDestructive returning false (user declined) leaves the
//      picker open but does NOT fire transferOwnership.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ChannelAdminPanel from '../src/components/ChannelAdminPanel.svelte';

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

// Build a store stub with channelMembers + participants in the shape
// the picker $derived expects. `members` is an ordered list of
// { key, name } pairs; the caller's key defaults to 'me' so the
// picker excludes it.
function makeStore({
  members = [],
  selfKey = 'me',
  transferOwnership,
  channelId = 'ch-1',
} = {}) {
  const channelMembers = { [channelId]: { [selfKey]: '2026-05-19T00:00:00Z' } };
  const participants = {
    [selfKey]: { key: selfKey, name: 'me', type: 'human', connections: { 'c0': {} } },
  };
  for (const m of members) {
    channelMembers[channelId][m.key] = '2026-05-19T00:00:00Z';
    participants[m.key] = {
      key: m.key,
      name: m.name,
      type: 'human',
      connections: { 'c1': {} },
    };
  }
  return {
    channelMembers,
    participants,
    userProfile: { key: selfKey, name: 'me', type: 'human' },
    transferOwnership: transferOwnership ?? vi.fn().mockResolvedValue({ success: true }),
    archiveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() })),
    deleteChannel: vi.fn().mockResolvedValue({ success: true }),
    setTopic: vi.fn().mockResolvedValue({ success: true }),
    renameChannel: vi.fn().mockResolvedValue({ success: true }),
    setVisibility: vi.fn().mockResolvedValue({ success: true }),
    setMode: vi.fn().mockResolvedValue({ success: true }),
  };
}

function makeProps(overrides = {}) {
  return {
    channel: overrides.channel ?? makeChannel(),
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

describe('ChannelAdminPanel transfer picker: opens on click', () => {
  it('clicking Transfer ownership opens the picker (no confirmDestructive call)', async () => {
    const onConfirmDestructive = vi.fn().mockResolvedValue(true);
    const store = makeStore({
      members: [{ key: 'alice', name: 'Alice' }],
    });
    const props = makeProps({ store, onConfirmDestructive });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });

    expect(queryByTestId('channel-admin-transfer-picker')).toBeNull();

    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();

    expect(getByTestId('channel-admin-transfer-picker')).not.toBeNull();
    expect(onConfirmDestructive).not.toHaveBeenCalled();
  });

  it('Cancel button collapses the picker without firing transferOwnership', async () => {
    const store = makeStore({ members: [{ key: 'alice', name: 'Alice' }] });
    const props = makeProps({ store });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });

    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();
    expect(getByTestId('channel-admin-transfer-picker')).not.toBeNull();

    await fireEvent.click(getByTestId('channel-admin-transfer-cancel'));
    await flush();

    expect(queryByTestId('channel-admin-transfer-picker')).toBeNull();
    expect(store.transferOwnership).not.toHaveBeenCalled();
  });
});

describe('ChannelAdminPanel transfer picker: candidate list excludes caller', () => {
  it('lists every channel member EXCEPT the caller, alpha-sorted by name', async () => {
    const store = makeStore({
      members: [
        { key: 'charlie', name: 'Charlie' },
        { key: 'alice', name: 'Alice' },
        { key: 'bob', name: 'Bob' },
      ],
      selfKey: 'me',
    });
    const props = makeProps({ store });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });

    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();

    // Caller ('me') excluded.
    expect(queryByTestId('channel-admin-transfer-option-me')).toBeNull();
    // Members present in alpha order.
    const alice = getByTestId('channel-admin-transfer-option-alice');
    const bob = getByTestId('channel-admin-transfer-option-bob');
    const charlie = getByTestId('channel-admin-transfer-option-charlie');
    expect(alice).not.toBeNull();
    expect(bob).not.toBeNull();
    expect(charlie).not.toBeNull();

    // DOM order matches alpha sort.
    const select = getByTestId('channel-admin-transfer-select');
    const optionKeys = Array.from(select.querySelectorAll('option[value]:not([value=""])')).map(
      (o) => o.getAttribute('value'),
    );
    expect(optionKeys).toEqual(['alice', 'bob', 'charlie']);
  });

  it('empty-member channel shows the inline "No eligible members" hint', async () => {
    const store = makeStore({ members: [], selfKey: 'me' });
    const props = makeProps({ store });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });

    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();

    expect(getByTestId('channel-admin-transfer-picker-empty')).not.toBeNull();
    expect(queryByTestId('channel-admin-transfer-select')).toBeNull();
    // Confirm button is disabled in this state.
    const confirmBtn = getByTestId('channel-admin-transfer-confirm');
    expect(confirmBtn.hasAttribute('disabled')).toBe(true);
  });
});

describe('ChannelAdminPanel transfer picker: confirm fires 2-arg transferOwnership', () => {
  it('picking a member + confirming fires store.transferOwnership(id, key)', async () => {
    const transferOwnership = vi.fn().mockResolvedValue({ success: true });
    const onConfirmDestructive = vi.fn().mockResolvedValue(true);
    const store = makeStore({
      members: [{ key: 'alice', name: 'Alice' }],
      transferOwnership,
    });
    const props = makeProps({ store, onConfirmDestructive });
    const { getByTestId } = render(ChannelAdminPanel, { props });

    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();

    const select = getByTestId('channel-admin-transfer-select');
    await fireEvent.change(select, { target: { value: 'alice' } });
    await flush();

    await fireEvent.click(getByTestId('channel-admin-transfer-confirm'));
    await flush();

    // confirmDestructive opened with severity:'danger' + channel name.
    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    const opts = onConfirmDestructive.mock.calls[0][0];
    expect(opts.severity).toBe('danger');
    expect(opts.requireTypedName).toBe('general');
    expect(opts.confirmLabel).toBe('Transfer ownership');

    // Store called with the 2-arg path (channelId, pickedKey).
    expect(transferOwnership).toHaveBeenCalledTimes(1);
    expect(transferOwnership).toHaveBeenCalledWith('ch-1', 'alice');
  });

  it('confirmDestructive returning false leaves picker open + does NOT fire transferOwnership', async () => {
    const transferOwnership = vi.fn().mockResolvedValue({ success: true });
    const onConfirmDestructive = vi.fn().mockResolvedValue(false);
    const store = makeStore({
      members: [{ key: 'alice', name: 'Alice' }],
      transferOwnership,
    });
    const props = makeProps({ store, onConfirmDestructive });
    const { getByTestId } = render(ChannelAdminPanel, { props });

    await fireEvent.click(getByTestId('channel-admin-action-transfer'));
    await flush();

    const select = getByTestId('channel-admin-transfer-select');
    await fireEvent.change(select, { target: { value: 'alice' } });
    await flush();

    await fireEvent.click(getByTestId('channel-admin-transfer-confirm'));
    await flush();

    // User declined the confirm dialog.
    expect(onConfirmDestructive).toHaveBeenCalledTimes(1);
    expect(transferOwnership).not.toHaveBeenCalled();
    // Picker stays open so the user can either retry or click Cancel.
    expect(getByTestId('channel-admin-transfer-picker')).not.toBeNull();
  });
});
