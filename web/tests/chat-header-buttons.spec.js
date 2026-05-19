// Tests for ChatHeader.svelte — v0.4.2 Wave E.2 follow-up [VERIFY-i]:
// the button row (search / pinned / artifacts / settings / theme toggle /
// mobile-menu) that was lost when the legacy inline App.svelte header was
// deleted in commit 3458b6d.
//
// What this suite pins:
//
//   1. Each of the 6 buttons renders ONLY when its callback prop is
//      provided (so unrelated test harnesses mounting the bare topic-edit
//      contract are unaffected).
//   2. Each click invokes the corresponding callback exactly once.
//   3. The button-row DOM order matches the documented affordance order
//      (mobile-menu first, then search, pinned, artifacts, theme,
//      settings). The mobile-menu button uses `order: -1` in CSS to keep
//      it visually leftmost when the viewport is narrow; we assert the
//      DOM ORDER here, which is stable regardless of viewport.
//   4. The theme toggle swaps the rendered icon based on `themeMode`
//      (sun in dark mode, moon in light mode) so the affordance stays
//      legible in either palette.
//
// These six restored buttons are essentially a port of the deleted
// `.header-actions` cluster from App.svelte. The legacy block lived in
// commit 942761d's parent, lines 729-756; see
// `.worklogs/v042-chatheader-fixup.md` §2 for the full before-snapshot.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import ChatHeader from '../src/components/ChatHeader.svelte';

// ── Helpers ────────────────────────────────────────────────────────────

function makeChannel(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: 'a place for general chatter',
    memberCount: 5,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    setTopic: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function makeButtonProps(overrides = {}) {
  return {
    channel: makeChannel(),
    currentUserRole: 'owner',
    store: makeStore(),
    onToggleSearch: vi.fn(),
    onTogglePinned: vi.fn(),
    onToggleArtifacts: vi.fn(),
    onToggleSettings: vi.fn(),
    onToggleTheme: vi.fn(),
    onToggleMobileMenu: vi.fn(),
    themeMode: 'dark',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

// ── 1. Buttons render only when their callback prop is provided ────────

describe('ChatHeader — button row visibility gated on callback presence', () => {
  it('renders all 6 buttons when all 6 callbacks are provided', () => {
    const props = makeButtonProps();
    const { queryByTestId } = render(ChatHeader, { props });
    expect(queryByTestId('chat-header-mobile-menu-btn')).not.toBeNull();
    expect(queryByTestId('chat-header-search-btn')).not.toBeNull();
    expect(queryByTestId('chat-header-pinned-btn')).not.toBeNull();
    expect(queryByTestId('chat-header-artifacts-btn')).not.toBeNull();
    expect(queryByTestId('chat-header-theme-toggle-btn')).not.toBeNull();
    expect(queryByTestId('chat-header-settings-btn')).not.toBeNull();
  });

  it('renders no button-row buttons when no callbacks are provided (bare contract)', () => {
    // This mirrors the older topic-edit-only mount used by
    // chat-header-topic-edit.spec.js, which must not regress.
    const props = {
      channel: makeChannel(),
      currentUserRole: 'owner',
      store: makeStore(),
    };
    const { queryByTestId } = render(ChatHeader, { props });
    expect(queryByTestId('chat-header-mobile-menu-btn')).toBeNull();
    expect(queryByTestId('chat-header-search-btn')).toBeNull();
    expect(queryByTestId('chat-header-pinned-btn')).toBeNull();
    expect(queryByTestId('chat-header-artifacts-btn')).toBeNull();
    expect(queryByTestId('chat-header-theme-toggle-btn')).toBeNull();
    expect(queryByTestId('chat-header-settings-btn')).toBeNull();
    // The header itself + the topic edit affordance still render —
    // confirms we are still rendering the same component.
    expect(queryByTestId('chat-header-new')).not.toBeNull();
    expect(queryByTestId('chat-header-topic-edit-btn')).not.toBeNull();
  });
});

// ── 2. Each click invokes the corresponding callback exactly once ──────

describe('ChatHeader — button click fires its callback', () => {
  it('clicking the search button fires onToggleSearch', async () => {
    const onToggleSearch = vi.fn();
    const props = makeButtonProps({ onToggleSearch });
    const { getByTestId } = render(ChatHeader, { props });
    await fireEvent.click(getByTestId('chat-header-search-btn'));
    expect(onToggleSearch).toHaveBeenCalledTimes(1);
  });

  it('clicking the pinned button fires onTogglePinned', async () => {
    const onTogglePinned = vi.fn();
    const props = makeButtonProps({ onTogglePinned });
    const { getByTestId } = render(ChatHeader, { props });
    await fireEvent.click(getByTestId('chat-header-pinned-btn'));
    expect(onTogglePinned).toHaveBeenCalledTimes(1);
  });

  it('clicking the artifacts button fires onToggleArtifacts', async () => {
    const onToggleArtifacts = vi.fn();
    const props = makeButtonProps({ onToggleArtifacts });
    const { getByTestId } = render(ChatHeader, { props });
    await fireEvent.click(getByTestId('chat-header-artifacts-btn'));
    expect(onToggleArtifacts).toHaveBeenCalledTimes(1);
  });

  it('clicking the settings button fires onToggleSettings', async () => {
    const onToggleSettings = vi.fn();
    const props = makeButtonProps({ onToggleSettings });
    const { getByTestId } = render(ChatHeader, { props });
    await fireEvent.click(getByTestId('chat-header-settings-btn'));
    expect(onToggleSettings).toHaveBeenCalledTimes(1);
  });

  it('clicking the theme toggle button fires onToggleTheme', async () => {
    const onToggleTheme = vi.fn();
    const props = makeButtonProps({ onToggleTheme });
    const { getByTestId } = render(ChatHeader, { props });
    await fireEvent.click(getByTestId('chat-header-theme-toggle-btn'));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it('clicking the mobile-menu button fires onToggleMobileMenu', async () => {
    const onToggleMobileMenu = vi.fn();
    const props = makeButtonProps({ onToggleMobileMenu });
    const { getByTestId } = render(ChatHeader, { props });
    await fireEvent.click(getByTestId('chat-header-mobile-menu-btn'));
    expect(onToggleMobileMenu).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Button-row DOM order matches expected affordance order ──────────

describe('ChatHeader — button-row DOM order', () => {
  it('renders buttons in mobile-menu, search, pinned, artifacts, theme, settings order', () => {
    const props = makeButtonProps();
    const { getByTestId } = render(ChatHeader, { props });
    const actions = getByTestId('chat-header-actions');
    const orderedIds = Array.from(actions.querySelectorAll('button')).map(
      (b) => b.getAttribute('data-testid'),
    );
    expect(orderedIds).toEqual([
      'chat-header-mobile-menu-btn',
      'chat-header-search-btn',
      'chat-header-pinned-btn',
      'chat-header-artifacts-btn',
      'chat-header-theme-toggle-btn',
      'chat-header-settings-btn',
    ]);
  });
});

// ── 4. Theme toggle icon swap follows themeMode ────────────────────────

describe('ChatHeader — theme toggle icon swap', () => {
  it('shows the sun icon when themeMode === "dark"', () => {
    const props = makeButtonProps({ themeMode: 'dark' });
    const { getByTestId } = render(ChatHeader, { props });
    const btn = getByTestId('chat-header-theme-toggle-btn');
    // lucide-svelte renders an inline <svg> per icon. The aria-label
    // also reflects the current mode, which is the most reliable check
    // since the DOM under the SVG is library-specific.
    expect(btn.getAttribute('aria-label')).toBe('Toggle theme, currently dark');
    // Sanity: a single svg child renders inside the button.
    expect(btn.querySelectorAll('svg').length).toBe(1);
  });

  it('shows the moon icon when themeMode === "light"', () => {
    const props = makeButtonProps({ themeMode: 'light' });
    const { getByTestId } = render(ChatHeader, { props });
    const btn = getByTestId('chat-header-theme-toggle-btn');
    expect(btn.getAttribute('aria-label')).toBe('Toggle theme, currently light');
    expect(btn.querySelectorAll('svg').length).toBe(1);
  });
});
