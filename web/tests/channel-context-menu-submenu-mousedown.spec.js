// ChannelContextMenu — Mute submenu survives a REAL mouse interaction
// (WEB-E finding #5).
//
// Regression: the outside-click guard was `<svelte:window onmousedown>`
// closing the menu unless `menuEl.contains(target)`. The Mute submenu is
// portaled to <body> (separate from menuEl), so a real mouse click on a
// submenu item fired `mousedown` FIRST → the guard saw "outside" → onClose →
// the menu unmounted before the `click`/action could fire. Mute was only
// settable by keyboard. The previous test masked this by activating the item
// with `fireEvent.click` alone (no preceding mousedown).
//
// This test reproduces the real browser sequence: mousedown THEN click.

import { describe, it, expect, afterEach, vi } from 'vitest';
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

function defaultProps(overrides = {}) {
  return {
    channel: makeChannel(),
    anchorEvent: { clientX: 100, clientY: 100 },
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

describe('ChannelContextMenu — portaled submenu + real mouse (mousedown→click)', () => {
  it('mousedown on a Mute submenu item does NOT close the menu, and the click fires the action', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(ChannelContextMenu, defaultProps({ onAction, onClose }));

    // Open the Mute submenu.
    await fireEvent.click(getByTestId('channel-ctx-item-mute-submenu'));
    await tick();
    await tick();

    const subItem = getByTestId('channel-ctx-item-mute:all');
    expect(subItem).toBeTruthy();

    // Real browsers send mousedown (bubbling to the window guard) BEFORE the
    // click. With the bug, this mousedown closed the menu prematurely.
    await fireEvent.mouseDown(subItem);
    await tick();
    expect(onClose).not.toHaveBeenCalled();

    // The click then fires the mute action (and closes once, as designed).
    await fireEvent.click(subItem);
    expect(onAction).toHaveBeenCalledWith('mute:all');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mousedown truly outside the menu AND submenu still closes (guard not over-broad)', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(ChannelContextMenu, defaultProps({ onClose }));

    // Open the submenu so both menu + submenu are mounted.
    await fireEvent.click(getByTestId('channel-ctx-item-mute-submenu'));
    await tick();
    await tick();

    // A mousedown on an element outside both the menu and the portaled
    // submenu must still dismiss.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await fireEvent.mouseDown(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
    outside.remove();
  });
});
