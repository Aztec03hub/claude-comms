// ChannelContextMenu — CTX-MENU-NEW spec (Step 2.10 of the v0.4.0 release
// plan, architecture doc Part II §III.4).
//
// Verifies the action-visibility matrix per (isMember × isCreator × unread)
// combinations, keyboard navigation (ArrowUp/Down, Enter, Escape, ArrowRight
// to open submenu), Escape + outside-click closes, and the Mute submenu
// open path. The component is mounted/unmounted per right-click in the
// parent shell (Sidebar in Step 2.12), so we render a fresh instance per
// test and tear down via cleanup() in afterEach.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ChannelContextMenu from '../src/components/ChannelContextMenu.svelte';

function makeChannel(overrides = {}) {
  return {
    id: 'ch-1',
    name: 'general',
    member: true,
    starred: false,
    muted: false,
    unread: 0,
    createdBy: 'alice',
    visibility: 'listed',
    ...overrides,
  };
}

function makeAnchor(clientX = 100, clientY = 100) {
  // A bare object is sufficient — the component only reads clientX/Y.
  return { clientX, clientY };
}

function defaultProps(overrides = {}) {
  return {
    channel: makeChannel(),
    anchorEvent: makeAnchor(),
    isMember: true,
    isCreator: false,
    onAction: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ChannelContextMenu — action visibility matrix', () => {
  it('shows Star, Mute, Copy link, Leave, Channel info for a non-creator member', () => {
    const { getByTestId, queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({ isMember: true, isCreator: false })
    );

    expect(getByTestId('channel-ctx-item-toggle-star')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-mute-submenu')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-copy-link')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-leave')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-info')).toBeTruthy();

    // Close + Delete are creator-only and must NOT appear for non-creators.
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();
    expect(queryByTestId('channel-ctx-item-delete')).toBeNull();
    // Mark-read is hidden when unread === 0.
    expect(queryByTestId('channel-ctx-item-mark-read')).toBeNull();
  });

  it('shows Close + Delete (and hides Leave) for a creator-member', () => {
    const { getByTestId, queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({
        channel: makeChannel({ createdBy: 'me' }),
        isMember: true,
        isCreator: true,
      })
    );

    expect(getByTestId('channel-ctx-item-close')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-delete')).toBeTruthy();
    expect(queryByTestId('channel-ctx-item-leave')).toBeNull();
  });

  it('hides member-only actions (Star, Mute, Mark-read, Leave, Close) for a non-member', () => {
    const { getByTestId, queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({
        channel: makeChannel({ member: false, unread: 5 }),
        isMember: false,
        isCreator: false,
      })
    );

    expect(queryByTestId('channel-ctx-item-toggle-star')).toBeNull();
    expect(queryByTestId('channel-ctx-item-mute-submenu')).toBeNull();
    expect(queryByTestId('channel-ctx-item-mark-read')).toBeNull();
    expect(queryByTestId('channel-ctx-item-leave')).toBeNull();
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();

    // Always-visible actions remain.
    expect(getByTestId('channel-ctx-item-copy-link')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-info')).toBeTruthy();
  });

  it('shows Mark-all-as-read only when unread > 0', () => {
    // unread === 0 → hidden.
    const { queryByTestId, unmount } = render(
      ChannelContextMenu,
      defaultProps({ channel: makeChannel({ unread: 0 }) })
    );
    expect(queryByTestId('channel-ctx-item-mark-read')).toBeNull();
    unmount();

    // unread > 0 → visible.
    const next = render(
      ChannelContextMenu,
      defaultProps({ channel: makeChannel({ unread: 3 }) })
    );
    expect(next.getByTestId('channel-ctx-item-mark-read')).toBeTruthy();
  });

  it('flips the Star label to Unstar when channel.starred is true', () => {
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ channel: makeChannel({ starred: true }) })
    );
    const item = getByTestId('channel-ctx-item-toggle-star');
    expect(item.textContent).toContain('Unstar');
    expect(item.textContent).not.toMatch(/(^|[^n])Star\b/);
  });

  it('shows Delete to a creator who is no longer a member (admin-style edge case)', () => {
    // Phil's spec: creator-only for v0.4.0; v0.4.1 extends to admins.
    // If the user is creator but somehow not a member, Delete still shows.
    const { getByTestId, queryByTestId } = render(
      ChannelContextMenu,
      defaultProps({
        channel: makeChannel({ member: false, createdBy: 'me' }),
        isMember: false,
        isCreator: true,
      })
    );
    expect(getByTestId('channel-ctx-item-delete')).toBeTruthy();
    expect(queryByTestId('channel-ctx-item-leave')).toBeNull();
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();
  });
});

describe('ChannelContextMenu — action firing', () => {
  it('emits the actionId via onAction and then onClose when a leaf item is clicked', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onAction, onClose })
    );

    await fireEvent.click(getByTestId('channel-ctx-item-copy-link'));
    await tick();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('copy-link');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('emits toggle-star (not just "star") when the Star/Unstar item is activated', async () => {
    const onAction = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onAction })
    );
    await fireEvent.click(getByTestId('channel-ctx-item-toggle-star'));
    expect(onAction).toHaveBeenCalledWith('toggle-star');
  });

  it('emits "close" (not "archive") for a creator-member clicking Close', async () => {
    const onAction = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({
        channel: makeChannel({ createdBy: 'me' }),
        isCreator: true,
        onAction,
      })
    );
    await fireEvent.click(getByTestId('channel-ctx-item-close'));
    expect(onAction).toHaveBeenCalledWith('close');
  });
});

describe('ChannelContextMenu — Mute submenu', () => {
  it('does NOT close the parent menu when the Mute item is clicked (opens submenu instead)', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onAction, onClose })
    );

    await fireEvent.click(getByTestId('channel-ctx-item-mute-submenu'));
    await tick();
    await tick();

    // Submenu rendered; parent NOT closed; no actionId fired yet.
    expect(getByTestId('channel-ctx-submenu')).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens the Mute submenu on ArrowRight from the Mute item and fires mute:all on Enter', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onAction, onClose })
    );

    const menu = getByTestId('channel-ctx-menu');
    await tick();
    // Star = idx 0, Mute = idx 1 in the (member,non-creator,unread=0) variant.
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await tick();
    await tick();
    expect(
      getByTestId('channel-ctx-item-mute-submenu').getAttribute('tabindex')
    ).toBe('0');

    await fireEvent.keyDown(menu, { key: 'ArrowRight' });
    await tick();
    await tick();
    await tick();

    const submenu = getByTestId('channel-ctx-submenu');
    expect(submenu).toBeTruthy();

    // Enter activates the first submenu item (mute:all).
    await fireEvent.keyDown(submenu, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('mute:all');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('emits mute:mentions when the second submenu item is clicked', async () => {
    const onAction = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onAction })
    );

    await fireEvent.click(getByTestId('channel-ctx-item-mute-submenu'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-mute:mentions'));
    expect(onAction).toHaveBeenCalledWith('mute:mentions');
  });
});

describe('ChannelContextMenu — keyboard + dismissal', () => {
  it('focuses the first menuitem on mount', async () => {
    const { getByTestId } = render(ChannelContextMenu, defaultProps());
    // Wait two microtasks (mount → $effect → tick → focus).
    await tick();
    await tick();
    const firstItem = getByTestId('channel-ctx-item-toggle-star');
    expect(document.activeElement).toBe(firstItem);
  });

  it('ArrowDown then ArrowUp moves the active row through the rendered list', async () => {
    const { getByTestId } = render(ChannelContextMenu, defaultProps());
    const menu = getByTestId('channel-ctx-menu');
    await tick();

    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await tick();
    // After ArrowDown from idx 0 → idx 1 (mute-submenu).
    expect(getByTestId('channel-ctx-item-mute-submenu').getAttribute('tabindex')).toBe('0');
    expect(getByTestId('channel-ctx-item-toggle-star').getAttribute('tabindex')).toBe('-1');

    await fireEvent.keyDown(menu, { key: 'ArrowUp' });
    await tick();
    expect(getByTestId('channel-ctx-item-toggle-star').getAttribute('tabindex')).toBe('0');
  });

  it('Escape on the menu fires onClose', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onClose })
    );
    await fireEvent.keyDown(getByTestId('channel-ctx-menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('outside-click (mousedown on body) fires onClose', async () => {
    const onClose = vi.fn();
    render(ChannelContextMenu, defaultProps({ onClose }));
    await tick();
    // mousedown on the body — not inside the menu — should close.
    await fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('mousedown inside the menu does NOT fire onClose', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onClose })
    );
    await tick();
    await fireEvent.mouseDown(getByTestId('channel-ctx-menu'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Enter on the active item fires that item\'s action and closes', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(
      ChannelContextMenu,
      defaultProps({ onAction, onClose })
    );
    const menu = getByTestId('channel-ctx-menu');
    await tick();
    await fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('toggle-star');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ChannelContextMenu — a11y attributes', () => {
  it('uses role="menu" on the root and role="menuitem" on every item', () => {
    const { getByTestId } = render(ChannelContextMenu, defaultProps());
    const menu = getByTestId('channel-ctx-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBeGreaterThan(0);
  });

  it('marks the Mute item with aria-haspopup="menu"', () => {
    const { getByTestId } = render(ChannelContextMenu, defaultProps());
    const muteItem = getByTestId('channel-ctx-item-mute-submenu');
    expect(muteItem.getAttribute('aria-haspopup')).toBe('menu');
    expect(muteItem.getAttribute('aria-expanded')).toBe('false');
  });
});
