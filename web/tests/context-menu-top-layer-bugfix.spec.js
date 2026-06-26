// Context menu top-layer coverage (Overlay overhaul, Phase 2).
//
// HISTORY: Phil's Layer B real-browser pass against v0.4.3 caught that
// right-click menus (MemberContextMenu + ChannelContextMenu) rendered
// BEHIND other elements because the right-side panels (ArtifactPanel,
// ThreadPanel, SearchPanel, SettingsPanel) set ``backdrop-filter`` which
// establishes a new stacking context that a ``position: fixed; z-index``
// element declared inside ``.app-layout`` cannot escape. The v0.4.4 fix
// was a portal into ``document.body`` + ``z-index: 9999``.
//
// PHASE 2 SUPERSEDES THAT FIX: both menus now use ``use:topLayer`` (the
// Popover API), which promotes them into the browser native TOP LAYER -
// a layer that paints above EVERY stacking context with no portal and no
// z-index at all. The old portal + ``z-index: 9999`` constants are gone,
// so this suite no longer pins them (it would otherwise go red).
//
// What this suite now pins (jsdom-safe; the real "painted on top" check
// lives in Playwright e2e/scenarios/14-overlay-top-layer.spec.ts):
//   1. Both menus still MOUNT when invoked and render their items.
//   2. Outside-click (window mousedown) still closes them - the component
//      keeps that handler so behaviour holds even where the browser's
//      native popover light-dismiss is unavailable (jsdom).
//   3. Unmounting removes the element (no leftover DOM).
//   4. SOURCE invariants: each menu references ``use:topLayer``, no longer
//      references ``{@attach portal()}``, and carries NO bare z-index
//      (ChannelContextMenu wires TWO ``use:topLayer`` - menu + submenu).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const MemberContextMenu = (
  await import('../src/components/MemberContextMenu.svelte')
).default;
const ChannelContextMenu = (
  await import('../src/components/ChannelContextMenu.svelte')
).default;

function memberProps(overrides = {}) {
  return {
    member: {
      key: 'aaaaaaaa',
      name: 'alice',
      type: 'human',
      connections: { 'aaaaaaaa-web-1': { client: 'web' } },
    },
    channel: { id: 'general', name: 'general', member: true, createdBy: '11111111' },
    currentChannelRole: 'member',
    currentUserKey: '11111111',
    isMuted: false,
    x: 100,
    y: 100,
    onAction: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function channelProps(overrides = {}) {
  return {
    channel: { id: 'general', name: 'general', member: true, createdBy: '11111111' },
    anchorEvent: { clientX: 100, clientY: 100 },
    isMember: true,
    isCreator: false,
    onAction: vi.fn(),
    onClose: vi.fn(),
    currentNotificationPolicy: { policy: 'All', highlightWords: [] },
    ...overrides,
  };
}

describe('Context menus - top-layer via use:topLayer (Phase 2)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    mcpCallMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    // Defensive: clear any leftover menu nodes between tests.
    document
      .querySelectorAll('[data-testid="member-ctx-menu"]')
      .forEach((el) => el.remove());
    document
      .querySelectorAll('[data-testid="channel-ctx-menu"]')
      .forEach((el) => el.remove());
  });

  it('MemberContextMenu mounts and renders its action items', () => {
    render(MemberContextMenu, memberProps());
    const menu = document.querySelector('[data-testid="member-ctx-menu"]');
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('role')).toBe('menu');
    // At least one menuitem rendered (mute is always available).
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
  });

  it('ChannelContextMenu mounts and renders its action items', () => {
    render(ChannelContextMenu, channelProps());
    const menu = document.querySelector('[data-testid="channel-ctx-menu"]');
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
  });

  it('MemberContextMenu closes on outside-click (window mousedown) - retained handler', async () => {
    const onClose = vi.fn();
    render(MemberContextMenu, memberProps({ onClose }));
    await fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('ChannelContextMenu closes on outside-click (window mousedown) - retained handler', async () => {
    const onClose = vi.fn();
    render(ChannelContextMenu, channelProps({ onClose }));
    await fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('MemberContextMenu removes its element on unmount (no leftover DOM)', () => {
    const { unmount } = render(MemberContextMenu, memberProps());
    expect(
      document.querySelector('[data-testid="member-ctx-menu"]'),
    ).not.toBeNull();
    unmount();
    expect(
      document.querySelector('[data-testid="member-ctx-menu"]'),
    ).toBeNull();
  });

  it('ChannelContextMenu removes its element on unmount (no leftover DOM)', () => {
    const { unmount } = render(ChannelContextMenu, channelProps());
    expect(
      document.querySelector('[data-testid="channel-ctx-menu"]'),
    ).not.toBeNull();
    unmount();
    expect(
      document.querySelector('[data-testid="channel-ctx-menu"]'),
    ).toBeNull();
  });

  it('source invariant: MemberContextMenu uses use:topLayer, no portal, no bare z-index', () => {
    // Supersedes the old z-index:9999 + {@attach portal()} pins (W-8). Bites
    // at edit time so a regression back to portal/hardcoded-index fails here.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SRC = resolve(HERE, '..', 'src', 'components', 'MemberContextMenu.svelte');
    const src = readFileSync(SRC, 'utf8');
    expect(src).toMatch(/use:topLayer/);
    expect(src).not.toMatch(/@attach portal\(\)/);
    // No bare numeric z-index anywhere (the top layer needs none).
    expect(src).not.toMatch(/z-index:\s*\d/);
  });

  it('source invariant: ChannelContextMenu wires TWO use:topLayer (menu + submenu), no portal, no bare z-index', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SRC = resolve(HERE, '..', 'src', 'components', 'ChannelContextMenu.svelte');
    const src = readFileSync(SRC, 'utf8');
    // Menu + nested submenu each get their own top-layer promotion (design §F.8).
    const matches = src.match(/use:topLayer/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/@attach portal\(\)/);
    expect(src).not.toMatch(/z-index:\s*\d/);
  });
});
