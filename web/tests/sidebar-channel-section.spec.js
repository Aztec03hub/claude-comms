// SidebarChannelSection (v0.4.0 Step 2.9) spec.
//
// Mirrors the MemberList M-FIX (v0.3.3) section-toggle invariants for the
// new channel sidebar: header ALWAYS renders, chevron rotates, collapse
// state persists per-section in localStorage, expanded body shows either
// the empty-state line or the row list.
//
// SidebarChannelRow is the child component (agent 2.8 in Wave E). In this
// worktree we ship a minimal placeholder stub (see worklog §9) so Vite's
// import-analysis pass succeeds during the verification gate. At
// integration time the orchestrator MUST take agent 2.8's real component
// over the placeholder. These tests query the placeholder's
// ``data-testid="sidebar-channel-row-{id}"`` markers to assert the
// section's row-rendering pipeline (count, ordering, active highlight,
// callback pass-through), which is the behavior owned by this step.
// Tests that depend on the real row's visual or interactive behavior
// belong in agent 2.8's spec, not here.
//
// Step 2.9 of the v0.4.0 release plan
// (.worklogs/architecture-and-orchestration-plan.md Part II §III.4
// around line 1390).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { Star, Hash, Globe } from 'lucide-svelte';

import SidebarChannelSection from '../src/components/SidebarChannelSection.svelte';

const STARRED_KEY = 'claude-comms.sidebarChannelSection.starred';
const ACTIVE_KEY = 'claude-comms.sidebarChannelSection.active';
const AVAILABLE_KEY = 'claude-comms.sidebarChannelSection.available';

function clearAllStorageKeys() {
  try {
    localStorage.removeItem(STARRED_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(AVAILABLE_KEY);
  } catch {
    // ignore
  }
}

function makeChannel(id, overrides = {}) {
  return {
    id,
    name: id,
    unread: 0,
    starred: false,
    muted: false,
    ...overrides,
  };
}

function defaultProps(overrides = {}) {
  return {
    label: 'Starred',
    icon: Star,
    channels: [],
    activeChannelId: null,
    emptyState: 'No starred channels yet.',
    storageKey: STARRED_KEY,
    defaultExpanded: true,
    onChannelClick: vi.fn(),
    onChannelContextMenu: vi.fn(),
    onStarToggle: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  clearAllStorageKeys();
});

afterEach(() => {
  cleanup();
  clearAllStorageKeys();
});

describe('SidebarChannelSection — header renders unconditionally (M-FIX parity)', () => {
  it('renders header with label and count=0 when channels array is empty', () => {
    const { getByTestId } = render(SidebarChannelSection, defaultProps());

    const header = getByTestId('sidebar-channel-section-header-Starred');
    expect(header).toBeTruthy();
    expect(header.textContent).toContain('Starred');

    const count = getByTestId('sidebar-channel-section-count-Starred');
    expect(count.textContent.trim()).toBe('0');
  });

  it('renders empty-state copy inside the body when channels is empty (default-expanded)', () => {
    const { getByTestId } = render(
      SidebarChannelSection,
      defaultProps({ emptyState: 'No starred channels yet.' }),
    );

    const empty = getByTestId('sidebar-channel-section-empty-Starred');
    expect(empty.textContent).toContain('No starred channels yet.');

    // Body region exists (default-expanded) even when no rows.
    expect(getByTestId('sidebar-channel-section-body-Starred')).toBeTruthy();
  });

  it('does not crash when handler callbacks are passed (forwarded to row); section still renders header + body', () => {
    // The section forwards onChannelClick / onChannelContextMenu /
    // onStarToggle to the row component. We can't introspect the
    // placeholder's prop receipt directly from here (Svelte 5's component
    // boundary hides destructured props), but we can verify the forwarding
    // wires up without runtime error AND that the row stub renders one
    // marker per channel, which it only does if the parent successfully
    // passed `channel` through. The real assertion that callbacks fire on
    // click / contextmenu / star-button belongs to agent 2.8's spec.
    const handlers = {
      onChannelClick: vi.fn(),
      onChannelContextMenu: vi.fn(),
      onStarToggle: vi.fn(),
    };
    const { getByTestId, container } = render(
      SidebarChannelSection,
      defaultProps({
        label: 'Available',
        icon: Globe,
        channels: [makeChannel('c1'), makeChannel('c2')],
        emptyState: 'No more channels to join.',
        storageKey: AVAILABLE_KEY,
        ...handlers,
      }),
    );

    // Header + body render normally.
    expect(getByTestId('sidebar-channel-section-header-Available')).toBeTruthy();
    expect(getByTestId('sidebar-channel-section-body-Available')).toBeTruthy();

    // Two row markers — one per channel — proving the parent passed
    // `channel` through; the same {...} props pass-through delivers the
    // three callbacks alongside.
    const rows = container.querySelectorAll('[data-testid^="sidebar-channel-row-"]');
    expect(rows).toHaveLength(2);
  });

  it('renders one SidebarChannelRow per channel in order; marks active row via data-is-active', () => {
    const channels = [
      makeChannel('general', { name: 'general' }),
      makeChannel('random', { name: 'random' }),
      makeChannel('alpha', { name: 'alpha' }),
    ];
    const { getByTestId, container } = render(
      SidebarChannelSection,
      defaultProps({
        label: 'Active',
        icon: Hash,
        channels,
        activeChannelId: 'random',
        emptyState: 'No active channels.',
        storageKey: ACTIVE_KEY,
      }),
    );

    // Count badge reflects rendered count.
    expect(
      getByTestId('sidebar-channel-section-count-Active').textContent.trim(),
    ).toBe('3');

    // Stub placeholder rows mounted in order.
    const rows = container.querySelectorAll('[data-testid^="sidebar-channel-row-"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-testid')).toBe('sidebar-channel-row-general');
    expect(rows[1].getAttribute('data-testid')).toBe('sidebar-channel-row-random');
    expect(rows[2].getAttribute('data-testid')).toBe('sidebar-channel-row-alpha');

    // Active highlight prop passes through to the matching row.
    expect(rows[0].dataset.isActive).toBe('false');
    expect(rows[1].dataset.isActive).toBe('true');
    expect(rows[2].dataset.isActive).toBe('false');

    // Empty-state placeholder is absent when rows are present.
    expect(() => getByTestId('sidebar-channel-section-empty-Active')).toThrow();
  });
});

describe('SidebarChannelSection — collapse/expand persistence', () => {
  it('chevron toggles aria-expanded; collapsed body is omitted from DOM; persists to localStorage', async () => {
    const { getByTestId } = render(SidebarChannelSection, defaultProps());
    const header = getByTestId('sidebar-channel-section-header-Starred');

    // Default-expanded.
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('sidebar-channel-section-body-Starred')).toBeTruthy();

    // Collapse.
    await fireEvent.click(header);
    await tick();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(() => getByTestId('sidebar-channel-section-body-Starred')).toThrow();
    expect(localStorage.getItem(STARRED_KEY)).toBe('0');

    // Re-expand.
    await fireEvent.click(header);
    await tick();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('sidebar-channel-section-body-Starred')).toBeTruthy();
    expect(localStorage.getItem(STARRED_KEY)).toBe('1');
  });

  it('rehydrates collapsed state from localStorage on mount', () => {
    localStorage.setItem(STARRED_KEY, '0');
    const { getByTestId } = render(SidebarChannelSection, defaultProps());
    const header = getByTestId('sidebar-channel-section-header-Starred');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(() => getByTestId('sidebar-channel-section-body-Starred')).toThrow();
  });

  it('uses defaultExpanded prop when storageKey is absent from localStorage', () => {
    const { getByTestId } = render(
      SidebarChannelSection,
      defaultProps({
        label: 'Available',
        icon: Globe,
        storageKey: AVAILABLE_KEY,
        defaultExpanded: false,
        emptyState: 'No more channels to join.',
      }),
    );
    const header = getByTestId('sidebar-channel-section-header-Available');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(() => getByTestId('sidebar-channel-section-body-Available')).toThrow();
  });
});

describe('SidebarChannelSection — chevron rotation CSS hook', () => {
  it('expanded chevron carries the .expanded class for CSS rotation', async () => {
    const { getByTestId } = render(SidebarChannelSection, defaultProps());
    const header = getByTestId('sidebar-channel-section-header-Starred');
    const chevron = header.querySelector('.sidebar-channel-section-chevron');

    expect(chevron.classList.contains('expanded')).toBe(true);

    await fireEvent.click(header);
    await tick();
    expect(chevron.classList.contains('expanded')).toBe(false);

    await fireEvent.click(header);
    await tick();
    expect(chevron.classList.contains('expanded')).toBe(true);
  });
});

describe('SidebarChannelSection — ARIA wiring', () => {
  it('header aria-controls points at the body region id; body carries role=region and matching aria-label', () => {
    const { getByTestId } = render(SidebarChannelSection, defaultProps());
    const header = getByTestId('sidebar-channel-section-header-Starred');
    const body = getByTestId('sidebar-channel-section-body-Starred');

    const controls = header.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(body.id).toBe(controls);
    expect(body.getAttribute('role')).toBe('region');
    expect(body.getAttribute('aria-label')).toBe('Starred');
  });

  it('renders unique body ids across sibling sections (no DOM id collisions in real Sidebar shell)', () => {
    const a = render(
      SidebarChannelSection,
      defaultProps({ label: 'Starred', storageKey: STARRED_KEY }),
    );
    const b = render(
      SidebarChannelSection,
      defaultProps({
        label: 'Active',
        icon: Hash,
        storageKey: ACTIVE_KEY,
        emptyState: 'No active channels.',
      }),
    );
    const c = render(
      SidebarChannelSection,
      defaultProps({
        label: 'Available',
        icon: Globe,
        storageKey: AVAILABLE_KEY,
        emptyState: 'No more channels to join.',
      }),
    );

    const idA = a
      .getByTestId('sidebar-channel-section-header-Starred')
      .getAttribute('aria-controls');
    const idB = b
      .getByTestId('sidebar-channel-section-header-Active')
      .getAttribute('aria-controls');
    const idC = c
      .getByTestId('sidebar-channel-section-header-Available')
      .getAttribute('aria-controls');

    expect(new Set([idA, idB, idC]).size).toBe(3);
  });
});

describe('SidebarChannelSection — count badge accuracy', () => {
  it('count badge always reflects channels.length, including when collapsed', async () => {
    const channels = [makeChannel('a'), makeChannel('b'), makeChannel('c')];
    const { getByTestId } = render(
      SidebarChannelSection,
      defaultProps({
        label: 'Active',
        icon: Hash,
        channels,
        emptyState: 'No active channels.',
        storageKey: ACTIVE_KEY,
      }),
    );

    expect(
      getByTestId('sidebar-channel-section-count-Active').textContent.trim(),
    ).toBe('3');

    // Collapse — count still visible in header.
    await fireEvent.click(getByTestId('sidebar-channel-section-header-Active'));
    await tick();
    expect(
      getByTestId('sidebar-channel-section-count-Active').textContent.trim(),
    ).toBe('3');
  });
});
