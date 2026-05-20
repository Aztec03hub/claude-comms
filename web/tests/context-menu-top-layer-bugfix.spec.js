// v0.4.4 hotfix - context menu top-layer regression coverage.
//
// Phil's Layer B real-browser pass against v0.4.3 caught that right-click
// menus (MemberContextMenu + ChannelContextMenu) rendered BEHIND other
// elements on screen. Root cause: the right-side panels (ArtifactPanel,
// ThreadPanel, SearchPanel, SettingsPanel) all set ``backdrop-filter``
// which establishes a new stacking context per CSS Containment Module
// Level 1. A ``position: fixed; z-index: 250`` declared INSIDE the
// sidebar component (whose ancestor chain ends at ``.app-layout``) can
// NOT escape that stacking context - it's painted in document order
// against its siblings. The right-side panels then render OVER it
// because they appear later in the DOM tree under ``.app-layout``.
//
// Why automated Playwright E2E missed this (W-8 anti-pattern per the
// v0.4.4 iteration log): ``expect(locator).toBeVisible()`` only checks
// ``display``/``opacity``/``visibility``/in-viewport. Does NOT check
// z-stacking. A menu rendered BEHIND another element passes
// ``.toBeVisible()`` cleanly.
//
// The v0.4.4 fix is two-pronged:
//   (a) Portal the menu element into ``document.body`` via the new
//       ``{@attach portal()}`` attachment so it escapes any ancestor
//       stacking context entirely.
//   (b) Bump the z-index to ``9999`` so it paints above every other
//       layer in the app. Either fix in isolation is fragile; both
//       together guarantee top-layer paint.
//
// This suite pins:
//   1. After mount, both MemberContextMenu and ChannelContextMenu have
//      their root element as a DIRECT child of ``document.body`` (i.e.
//      the portal moved them).
//   2. The element's computed ``z-index`` is the new high-value
//      (9999) - source-level regex pin so a future refactor that drops
//      the bump fails the suite.
//   3. The portal attachment removes the element on unmount (no leftover
//      DOM under <body>).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
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

describe('Context menus - v0.4.4 hotfix top-layer paint', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    mcpCallMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    // Defensive: clear any leftover portal nodes between tests.
    document
      .querySelectorAll('[data-testid="member-ctx-menu"]')
      .forEach((el) => el.remove());
    document
      .querySelectorAll('[data-testid="channel-ctx-menu"]')
      .forEach((el) => el.remove());
  });

  it('MemberContextMenu portals its root into document.body (escapes stacking context)', () => {
    render(MemberContextMenu, memberProps());
    const menu = document.querySelector('[data-testid="member-ctx-menu"]');
    expect(menu).not.toBeNull();
    // The portal attachment moves the element so its parent IS the body.
    // Without the portal, the parent would be the test container element
    // that @testing-library/svelte mounts under (typically a div under body).
    expect(menu.parentNode).toBe(document.body);
  });

  it('ChannelContextMenu portals its root into document.body', () => {
    render(ChannelContextMenu, channelProps());
    const menu = document.querySelector('[data-testid="channel-ctx-menu"]');
    expect(menu).not.toBeNull();
    expect(menu.parentNode).toBe(document.body);
  });

  it('MemberContextMenu portal cleanup removes the element on unmount', () => {
    const { unmount } = render(MemberContextMenu, memberProps());
    expect(
      document.querySelector('[data-testid="member-ctx-menu"]'),
    ).not.toBeNull();
    unmount();
    expect(
      document.querySelector('[data-testid="member-ctx-menu"]'),
    ).toBeNull();
  });

  it('ChannelContextMenu portal cleanup removes the element on unmount', () => {
    const { unmount } = render(ChannelContextMenu, channelProps());
    expect(
      document.querySelector('[data-testid="channel-ctx-menu"]'),
    ).not.toBeNull();
    unmount();
    expect(
      document.querySelector('[data-testid="channel-ctx-menu"]'),
    ).toBeNull();
  });

  it('source-level pin: MemberContextMenu CSS sets z-index 9999 (top-layer)', () => {
    // P-1 source regex pin (W-8 mitigation per v0.4.4 iteration log).
    // Bites at edit time so a future refactor cannot drop the z-index
    // back to 250 and silently re-introduce the stacking-context bug.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SRC = resolve(
      HERE,
      '..',
      'src',
      'components',
      'MemberContextMenu.svelte',
    );
    const src = readFileSync(SRC, 'utf8');
    // The .member-ctx-menu CSS rule must set z-index: 9999.
    expect(src).toMatch(/\.member-ctx-menu\s*\{[\s\S]*?z-index:\s*9999/);
    // And the template must apply the portal attachment.
    expect(src).toMatch(/\{@attach portal\(\)\}/);
  });

  it('source-level pin: ChannelContextMenu CSS sets z-index 9999 + applies portal attachment', () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SRC = resolve(
      HERE,
      '..',
      'src',
      'components',
      'ChannelContextMenu.svelte',
    );
    const src = readFileSync(SRC, 'utf8');
    expect(src).toMatch(/\.channel-ctx-menu\s*\{[\s\S]*?z-index:\s*9999/);
    // Template must apply portal - the submenu uses the same
    // attachment so we expect at least 2 occurrences.
    const matches = src.match(/\{@attach portal\(\)\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('portal helper exists at the shared lib path', () => {
    // Compile-time sanity: importing the module yields a function with
    // the documented shape (no SSR throw; returns an attachment that
    // accepts a node).
    const portalLibPath = '../src/lib/portal.js';
    return import(portalLibPath).then((mod) => {
      expect(typeof mod.portal).toBe('function');
      const attachment = mod.portal();
      expect(typeof attachment).toBe('function');
    });
  });
});
