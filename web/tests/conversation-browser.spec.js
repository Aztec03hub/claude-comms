// ConversationBrowser.svelte coverage (v0.4.0 Step 2.14 dual-mode refactor).
//
// The browser is the body of the "Browse" tab inside ChannelDirectoryModal
// when `embedded={true}`, and a standalone slide-out panel otherwise. The
// 4 new props (`filterValue`, `sortKey`, `embedded`, `onChannelClick`)
// were stubbed by §I.17 Wave 0 and are implemented here in Step 2.14.
//
// Coverage targets per Step 2.14's verification gate:
//   - Standalone-mode rendering (back-compat)
//   - Internal filter input visible standalone, hidden when embedded
//   - `filterValue` prop overrides internal $state when provided
//   - `onChannelClick` invoked on row click in embedded mode
//   - All four sub-section headers render with correct partitioning
//   - Each sub-section is alpha-sorted
//   - `sortKey` SORT-LOCK: non-'alphabetical' values produce console.warn
//
// Fixtures are hand-rolled store mocks matching the ChannelRow shape the
// store would produce; we don't need a real ChatStore here because the
// component reads from `store.channelsById` only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import ConversationBrowser from '../src/components/ConversationBrowser.svelte';
import { EMPTY_STATES } from '../src/lib/copy/emptyStates.js';

// ── Fixture helpers ────────────────────────────────────────────────────

function makeChannel(id, overrides = {}) {
  return {
    id,
    name: id,
    topic: '',
    member: false,
    memberCount: 1,
    lastActivity: null,
    mode: 'public',
    visibility: 'listed',
    starred: false,
    muted: false,
    muteLevel: 'off',
    unread: 0,
    unreadHasMention: false,
    unreadFrom: null,
    createdAt: null,
    createdBy: null,
    archived: false,
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

/**
 * Build a store mock whose `channelsById` covers each sub-section:
 *   Public listed (non-member, public, listed):
 *     - 'alpha'   public/listed/non-member
 *     - 'bravo'   public/listed/non-member
 *   Public unlisted (accessible) — member of an unlisted public:
 *     - 'charlie' public/unlisted/member
 *   My private channels:
 *     - 'delta'   private/member
 *   Archived:
 *     - 'echo'    archived=true
 *
 * Override via `extra` for tests that need different partitions.
 */
function makeStore(extra = {}) {
  const channelsById = {
    alpha: makeChannel('alpha', { mode: 'public', visibility: 'listed', member: false, topic: 'Apple alpha' }),
    bravo: makeChannel('bravo', { mode: 'public', visibility: 'listed', member: false, topic: 'Banana bravo' }),
    charlie: makeChannel('charlie', { mode: 'public', visibility: 'unlisted', member: true, topic: 'Hidden charlie' }),
    delta: makeChannel('delta', { mode: 'private', visibility: 'listed', member: true, topic: 'Secret delta' }),
    echo: makeChannel('echo', { archived: true, member: false, mode: 'public', visibility: 'listed' }),
    ...extra,
  };
  return {
    channelsById,
    channels: Object.values(channelsById),
  };
}

function renderBrowser(props = {}) {
  return render(ConversationBrowser, {
    props: {
      store: makeStore(),
      onClose: vi.fn(),
      onJoinChannel: vi.fn(),
      ...props,
    },
  });
}

afterEach(() => {
  cleanup();
});

// ── Standalone-mode rendering (back-compat) ────────────────────────────

describe('ConversationBrowser — standalone mode (back-compat)', () => {
  it('renders the outer panel chrome (header + close button)', () => {
    const { getByTestId } = renderBrowser();
    const root = getByTestId('conversation-browser');
    expect(root).toBeTruthy();
    expect(root.getAttribute('data-embedded')).toBe('false');
    expect(getByTestId('conversation-browser-close')).toBeTruthy();
  });

  it('shows the internal filter input when not embedded', () => {
    const { getByTestId } = renderBrowser();
    expect(getByTestId('browser-filter-row')).toBeTruthy();
    expect(getByTestId('browser-filter-input')).toBeTruthy();
  });

  it('invokes onClose when the X button is clicked', async () => {
    const onClose = vi.fn();
    const { getByTestId } = renderBrowser({ onClose });
    await fireEvent.click(getByTestId('conversation-browser-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('typing into the internal filter input narrows the row list', async () => {
    const { getByTestId, queryByTestId } = renderBrowser();
    const input = getByTestId('browser-filter-input');
    await fireEvent.input(input, { target: { value: 'alpha' } });
    expect(getByTestId('browser-item-alpha')).toBeTruthy();
    expect(queryByTestId('browser-item-bravo')).toBeNull();
  });

  it('default row click in standalone mode calls onJoinChannel with channel name', async () => {
    const onJoinChannel = vi.fn();
    const { getByTestId } = renderBrowser({ onJoinChannel });
    await fireEvent.click(getByTestId('browser-item-alpha'));
    expect(onJoinChannel).toHaveBeenCalledTimes(1);
    expect(onJoinChannel).toHaveBeenCalledWith('alpha');
  });
});

// ── Sub-section headers (Spec §4.4) ────────────────────────────────────

describe('ConversationBrowser — sub-section headers (Spec §4.4)', () => {
  it('renders all four sub-section headers with the expected labels', () => {
    const { getByTestId } = renderBrowser();
    expect(getByTestId('browser-section-header-Public listed')).toBeTruthy();
    expect(
      getByTestId('browser-section-header-Public unlisted (accessible)'),
    ).toBeTruthy();
    expect(getByTestId('browser-section-header-My private channels')).toBeTruthy();
    expect(getByTestId('browser-section-header-Archived')).toBeTruthy();
  });

  it('Public listed contains only public/listed/non-member channels', () => {
    const { getByTestId, queryByTestId } = renderBrowser();
    // alpha + bravo → Public listed
    expect(getByTestId('browser-item-alpha')).toBeTruthy();
    expect(getByTestId('browser-item-bravo')).toBeTruthy();
    // header count = 2
    const header = getByTestId('browser-section-header-Public listed');
    expect(header.textContent).toContain('2');
    // charlie (unlisted+member), delta (private), echo (archived) are NOT here
    expect(queryByTestId('browser-section-header-Public listed').textContent).not.toContain('5');
  });

  it('Public unlisted (accessible) contains public/unlisted/member channels', () => {
    const { getByTestId } = renderBrowser();
    expect(getByTestId('browser-item-charlie')).toBeTruthy();
    const header = getByTestId('browser-section-header-Public unlisted (accessible)');
    expect(header.textContent).toContain('1');
  });

  it('My private channels contains private/member channels', () => {
    const { getByTestId } = renderBrowser();
    expect(getByTestId('browser-item-delta')).toBeTruthy();
    const header = getByTestId('browser-section-header-My private channels');
    expect(header.textContent).toContain('1');
  });

  it('Archived contains archived channels regardless of mode/visibility', () => {
    const { getByTestId } = renderBrowser();
    expect(getByTestId('browser-item-echo')).toBeTruthy();
    const header = getByTestId('browser-section-header-Archived');
    expect(header.textContent).toContain('1');
  });

  it('each sub-section is alpha-sorted by name (localeCompare)', () => {
    // Build a store with intentionally out-of-order ids; expect DOM order
    // to follow alphabetical-by-name within each section.
    const channelsById = {
      zzz_pub: makeChannel('zzz_pub', { name: 'zebra', mode: 'public', visibility: 'listed', member: false }),
      aaa_pub: makeChannel('aaa_pub', { name: 'aardvark', mode: 'public', visibility: 'listed', member: false }),
      mmm_pub: makeChannel('mmm_pub', { name: 'mango', mode: 'public', visibility: 'listed', member: false }),
    };
    const { container } = render(ConversationBrowser, {
      props: {
        store: { channelsById, channels: Object.values(channelsById) },
        onClose: vi.fn(),
        onJoinChannel: vi.fn(),
      },
    });
    // Find all rows in the Public listed section by data-testid prefix.
    const rows = container.querySelectorAll('[data-testid^="browser-item-"]');
    const names = Array.from(rows).map((r) =>
      r.querySelector('.browser-item-name')?.textContent?.trim(),
    );
    expect(names).toEqual(['aardvark', 'mango', 'zebra']);
  });
});

// ── Embedded mode (parent-controlled) ──────────────────────────────────

describe('ConversationBrowser — embedded mode', () => {
  it('embedded={true} hides the internal filter input', () => {
    const { getByTestId, queryByTestId } = renderBrowser({ embedded: true });
    const root = getByTestId('conversation-browser');
    expect(root.getAttribute('data-embedded')).toBe('true');
    expect(queryByTestId('browser-filter-row')).toBeNull();
    expect(queryByTestId('browser-filter-input')).toBeNull();
  });

  it('embedded={true} hides the outer panel chrome (no close button)', () => {
    const { queryByTestId } = renderBrowser({ embedded: true });
    expect(queryByTestId('conversation-browser-close')).toBeNull();
  });

  it('filterValue prop drives row filtering when embedded', () => {
    const { getByTestId, queryByTestId } = renderBrowser({
      embedded: true,
      filterValue: 'alpha',
    });
    expect(getByTestId('browser-item-alpha')).toBeTruthy();
    expect(queryByTestId('browser-item-bravo')).toBeNull();
  });

  it('filterValue="" (empty string) is parent-controlled — shows all rows', () => {
    const { getByTestId } = renderBrowser({
      embedded: true,
      filterValue: '',
    });
    expect(getByTestId('browser-item-alpha')).toBeTruthy();
    expect(getByTestId('browser-item-bravo')).toBeTruthy();
    expect(getByTestId('browser-item-charlie')).toBeTruthy();
  });

  it('filterValue also matches on topic, case-insensitive', () => {
    const { getByTestId, queryByTestId } = renderBrowser({
      embedded: true,
      filterValue: 'BANANA',
    });
    // bravo's topic is "Banana bravo"
    expect(getByTestId('browser-item-bravo')).toBeTruthy();
    expect(queryByTestId('browser-item-alpha')).toBeNull();
  });

  it('onChannelClick is called on row click in embedded mode (instead of onJoinChannel)', async () => {
    const onChannelClick = vi.fn();
    const onJoinChannel = vi.fn();
    const { getByTestId } = renderBrowser({
      embedded: true,
      onChannelClick,
      onJoinChannel,
    });
    await fireEvent.click(getByTestId('browser-item-alpha'));
    expect(onChannelClick).toHaveBeenCalledTimes(1);
    expect(onChannelClick).toHaveBeenCalledWith('alpha');
    // onJoinChannel must NOT be called when onChannelClick is provided.
    expect(onJoinChannel).not.toHaveBeenCalled();
  });

  it('keyboard activation (Enter) on a row invokes onChannelClick when embedded', async () => {
    const onChannelClick = vi.fn();
    const { getByTestId } = renderBrowser({
      embedded: true,
      onChannelClick,
    });
    const row = getByTestId('browser-item-charlie');
    row.focus();
    await fireEvent.keyDown(row, { key: 'Enter' });
    expect(onChannelClick).toHaveBeenCalledWith('charlie');
  });
});

// ── SORT-LOCK invariant ────────────────────────────────────────────────

describe('ConversationBrowser — SORT-LOCK invariant', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('sortKey="alphabetical" produces NO warning', () => {
    renderBrowser({ embedded: true, sortKey: 'alphabetical' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sortKey defaulted (undefined) produces NO warning', () => {
    renderBrowser();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('non-alphabetical sortKey logs a console.warn AND falls back to alpha', () => {
    const { container } = renderBrowser({
      embedded: true,
      sortKey: 'recency',
    });
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).toContain('sortKey="recency"');
    expect(msg.toLowerCase()).toContain('sort-lock');

    // And the actual row order is still alphabetical (alpha before bravo).
    const rows = container.querySelectorAll('[data-testid^="browser-item-"]');
    const firstTwoNames = Array.from(rows)
      .slice(0, 2)
      .map((r) => r.querySelector('.browser-item-name')?.textContent?.trim());
    expect(firstTwoNames).toEqual(['alpha', 'bravo']);
  });
});

// ── Empty state ────────────────────────────────────────────────────────

describe('ConversationBrowser — empty state', () => {
  it('renders empty-state copy when no channels match the filter', async () => {
    const { getByText } = renderBrowser({
      embedded: true,
      filterValue: 'nonexistent-needle',
    });
    // v0.4.2 Polish P5: ConversationBrowser now sources empty-state copy
    // from EMPTY_STATES, so the assertion matches the canonical template
    // string (which includes a trailing period via filterEmpty()).
    expect(
      getByText(EMPTY_STATES.filterEmpty('nonexistent-needle')),
    ).toBeTruthy();
  });

  it('renders default empty-state copy when no channels exist at all', () => {
    const store = { channelsById: {}, channels: [] };
    const { getByText } = render(ConversationBrowser, {
      props: { store, onClose: vi.fn(), onJoinChannel: vi.fn() },
    });
    expect(getByText(EMPTY_STATES.directoryNoChannelsTitle)).toBeTruthy();
    expect(getByText(EMPTY_STATES.directoryNoChannelsHint)).toBeTruthy();
  });
});
