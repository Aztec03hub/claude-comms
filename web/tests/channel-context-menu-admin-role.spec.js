// ChannelContextMenu — admin-role + reserved-channel gating.
//
// Companion to channel-context-menu.spec.js. Verifies the unified
// ``canAdmin = isCreator || isAdminOrOwner`` rule (so a non-creator
// owner/admin sees Close/Delete) and the reserved-channel suppression
// (#general / #system never offer Delete/Close even to an admin).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import ChannelContextMenu from '../src/components/ChannelContextMenu.svelte';

function makeChannel(overrides = {}) {
  return {
    id: 'ch-1',
    name: 'design',
    member: true,
    starred: false,
    muted: false,
    unread: 0,
    createdBy: 'alice',
    visibility: 'listed',
    ...overrides,
  };
}

function defaultProps(overrides = {}) {
  return {
    channel: makeChannel(),
    anchorEvent: { clientX: 100, clientY: 100 },
    isMember: true,
    isCreator: false,
    isAdminOrOwner: false,
    isReserved: false,
    onAction: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ChannelContextMenu — admin-role gating', () => {
  it('shows Close + Delete (and hides Leave) for a non-creator admin', () => {
    const { getByTestId, queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({ isCreator: false, isAdminOrOwner: true }),
    );
    expect(getByTestId('channel-ctx-item-close')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-delete')).toBeTruthy();
    expect(queryByTestId('channel-ctx-item-leave')).toBeNull();
  });

  it('shows Close + Delete for a non-creator owner', () => {
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ isCreator: false, isAdminOrOwner: true }),
    );
    expect(getByTestId('channel-ctx-item-close')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-delete')).toBeTruthy();
  });

  it('shows only Leave (no Close/Delete) for a plain member', () => {
    const { getByTestId, queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({ isCreator: false, isAdminOrOwner: false }),
    );
    expect(getByTestId('channel-ctx-item-leave')).toBeTruthy();
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();
    expect(queryByTestId('channel-ctx-item-delete')).toBeNull();
  });

  it('still shows Close + Delete for the literal creator', () => {
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ isCreator: true, isAdminOrOwner: false }),
    );
    expect(getByTestId('channel-ctx-item-close')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-delete')).toBeTruthy();
  });
});

describe('ChannelContextMenu — reserved-channel suppression', () => {
  it('hides Delete + Close for a reserved channel even for an admin', () => {
    const { queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({
        channel: makeChannel({ id: 'general', name: 'general' }),
        isCreator: true,
        isAdminOrOwner: true,
        isReserved: true,
      }),
    );
    expect(queryByTestId('channel-ctx-item-delete')).toBeNull();
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();
    // Non-destructive rows still render (info is always present).
    expect(queryByTestId('channel-ctx-item-info')).toBeTruthy();
  });

  it('shows Leave (not Delete/Close) for a plain member of a reserved channel', () => {
    const { queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({
        channel: makeChannel({ id: 'general', name: 'general' }),
        isCreator: false,
        isAdminOrOwner: false,
        isReserved: true,
      }),
    );
    expect(queryByTestId('channel-ctx-item-leave')).toBeTruthy();
    expect(queryByTestId('channel-ctx-item-delete')).toBeNull();
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();
  });
});
