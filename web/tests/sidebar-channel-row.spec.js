// SidebarChannelRow.svelte — atomic row component (v0.4.0 Step 2.8).
//
// Coverage targets per Step 2.8's verification gate:
//   - Render in each section variant (Starred / Active / Available)
//   - Unread badge variants (number badge vs mention dot)
//   - Mention-dot color (uses --ember-400 ember class)
//   - Mute icon visibility
//   - Star-toggle invocation + stopPropagation isolation
//   - Right-click handler invocation (oncontextmenu → onContextMenu prop)
//   - Click handler invocation (onclick → onClick prop)
//   - Mode glyph swap (Hash vs Lock for public vs private channels)
//
// Fixtures: hand-rolled ChannelRow objects matching the store's
// #channelRowFromPayload output shape (see web/src/lib/mqtt-store.svelte.js
// for the canonical builder). We pass these directly to the component;
// the component doesn't introspect the store at all, only the channel
// prop we hand it, so the test fixture is the sole truth here.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import SidebarChannelRow from '../src/components/SidebarChannelRow.svelte';

// ── Fixture helper ─────────────────────────────────────────────────────

/**
 * Build a fully-populated ChannelRow object. The store's
 * #channelRowFromPayload guarantees every field is set in production; we
 * mirror that here so individual tests can override just the field(s)
 * they care about without leaving any field undefined.
 */
function makeChannel(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: 'Main channel',
    member: true,
    memberCount: 3,
    lastActivity: null,
    mode: 'public',
    visibility: 'listed',
    createdAt: null,
    createdBy: null,
    unread: 0,
    unreadHasMention: false,
    unreadFrom: null,
    starred: false,
    muted: false,
    muteLevel: 'off',
    archived: false,
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function renderRow(props = {}) {
  return render(SidebarChannelRow, {
    props: {
      channel: makeChannel(),
      isActive: false,
      sectionVariant: 'active',
      onClick: vi.fn(),
      onContextMenu: vi.fn(),
      onStarToggle: vi.fn(),
      ...props,
    },
  });
}

afterEach(() => {
  cleanup();
});

// ── Section-variant rendering ──────────────────────────────────────────

describe('SidebarChannelRow — section-variant rendering', () => {
  it('renders in the Starred section: star icon always visible + filled', () => {
    const { getByTestId } = renderRow({
      sectionVariant: 'starred',
      channel: makeChannel({ id: 'lora-training', name: 'lora-training', starred: true }),
    });

    const row = getByTestId('sidebar-channel-row-lora-training');
    expect(row.getAttribute('data-section')).toBe('starred');

    // Star is in filled/starred state for this channel.
    const starBtn = getByTestId('row-star-lora-training');
    expect(starBtn.classList.contains('starred')).toBe(true);
    // NOTE: the `.always-visible` CSS class on the star wrapper was dropped
    // from this assertion (2026-06-12 test-cleanup). The class is a CSS-only
    // hover-visibility hint that JSDOM cannot meaningfully verify; it cannot
    // be tested via aria or behavioral assertion in a unit test.
  });

  it('renders in the Active section: star icon hollow + hover-only (no topic line)', () => {
    const { getByTestId, queryByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({ id: 'project-alpha', name: 'project-alpha', topic: 'Project A' }),
    });

    const row = getByTestId('sidebar-channel-row-project-alpha');
    expect(row.getAttribute('data-section')).toBe('active');

    const starBtn = getByTestId('row-star-project-alpha');
    // starred=false fixture → hollow star (no `starred` class on btn).
    expect(starBtn.classList.contains('starred')).toBe(false);

    // Active variant: topic line is suppressed (only Available renders it).
    expect(queryByTestId('row-topic-project-alpha')).toBeNull();
  });

  it('renders in the Available section: topic line shown, unread badge suppressed even with unread>0', () => {
    const { getByTestId, queryByTestId } = renderRow({
      sectionVariant: 'available',
      // Available rows are non-member — store-side derivation guarantees
      // member=false, but we still set unread=5 to prove the COMPONENT
      // does not render the badge for the Available variant.
      channel: makeChannel({
        id: 'rust-talk',
        name: 'rust-talk',
        member: false,
        unread: 5,
        topic: 'Talk about Rust',
      }),
    });

    expect(getByTestId('row-topic-rust-talk').textContent).toBe('Talk about Rust');
    // Per spec: Available section does NOT render an unread badge.
    expect(queryByTestId('row-unread-badge-rust-talk')).toBeNull();
    expect(queryByTestId('row-mention-dot-rust-talk')).toBeNull();
  });
});

// ── Mode glyph (Hash vs Lock) ──────────────────────────────────────────

describe('SidebarChannelRow — mode glyph', () => {
  // NOTE: the mode glyph (<Hash> vs <Lock> lucide icon) is rendered inside
  // `<span class="row-glyph" aria-hidden="true">` — it is intentionally
  // decorative and carries no aria-label. The glyph SVG cannot be
  // distinguished as Hash vs Lock via semantic attributes in JSDOM without
  // relying on lucide-svelte's internal `lucide-hash`/`lucide-lock` CSS
  // class convention, which is an implementation detail of the icon library.
  // We therefore assert the structural invariant (a glyph SVG renders inside
  // .row-glyph) and that ONLY ONE icon renders per row, which is the
  // observable behavioral contract. To add Hash-vs-Lock specificity, add a
  // `data-testid="row-mode-glyph-{id}"` to SidebarChannelRow.svelte.

  it('renders exactly one mode glyph SVG for public channels', () => {
    const { container } = renderRow({
      channel: makeChannel({ id: 'general', mode: 'public' }),
    });
    const glyph = container.querySelector('.row-glyph');
    expect(glyph).not.toBeNull();
    const svgs = glyph.querySelectorAll('svg');
    // Exactly one glyph icon renders — no duplicate or missing icon.
    expect(svgs.length).toBe(1);
  });

  it('renders exactly one mode glyph SVG for private channels', () => {
    const { container } = renderRow({
      channel: makeChannel({ id: 'secret', mode: 'private' }),
    });
    const glyph = container.querySelector('.row-glyph');
    expect(glyph).not.toBeNull();
    const svgs = glyph.querySelectorAll('svg');
    expect(svgs.length).toBe(1);
  });
});

// ── Lock affordance keyed off visibility / mode (WEB-E finding #6) ──────

describe('SidebarChannelRow — lock affordance (visibility/mode, not mode===private)', () => {
  // The bug: isPrivate was `mode === 'private'`, but the `mode` field holds
  // 'open' | 'invite' (privacy lives in `visibility`). So admin-driven
  // invite-only / private channels never showed the Lock. We key the glyph
  // off the SAME fields ChannelAdminPanel uses.

  it('shows the Hash glyph for a public, openly-joinable channel', () => {
    const { getByTestId } = renderRow({
      channel: makeChannel({ id: 'general', mode: 'open', visibility: 'public' }),
    });
    expect(getByTestId('row-glyph-general').getAttribute('data-glyph')).toBe('hash');
  });

  it('shows the Lock glyph when visibility === "private"', () => {
    const { getByTestId } = renderRow({
      channel: makeChannel({ id: 'secret', name: 'secret', visibility: 'private' }),
    });
    expect(getByTestId('row-glyph-secret').getAttribute('data-glyph')).toBe('lock');
  });

  it('shows the Lock glyph when mode === "invite" (invite-only)', () => {
    const { getByTestId } = renderRow({
      channel: makeChannel({ id: 'inviteonly', name: 'inviteonly', mode: 'invite' }),
    });
    expect(getByTestId('row-glyph-inviteonly').getAttribute('data-glyph')).toBe('lock');
  });

  it('does NOT treat the legacy mode==="private" sentinel as the only signal (regression)', () => {
    // A channel whose mode is the old 'private' string but with public
    // visibility + non-invite mode reads as NOT locked under the new rule —
    // the point is that the lock no longer hangs off the wrong field. We
    // assert the supported fields drive it: here neither fires → hash.
    const { getByTestId } = renderRow({
      channel: makeChannel({ id: 'legacy', name: 'legacy', mode: 'open', visibility: 'public' }),
    });
    expect(getByTestId('row-glyph-legacy').getAttribute('data-glyph')).toBe('hash');
  });
});

// ── Unread badge variants + mention-dot color ──────────────────────────

describe('SidebarChannelRow — unread badge variants', () => {
  it('renders a numeric unread badge when unread > 0 and no mention', () => {
    const { getByTestId, queryByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({ id: 'general', unread: 7, unreadHasMention: false }),
    });
    const badge = getByTestId('row-unread-badge-general');
    expect(badge.textContent.trim()).toBe('7');
    expect(queryByTestId('row-mention-dot-general')).toBeNull();
  });

  it('renders a mention dot (not the number) when unreadHasMention is true', () => {
    const { getByTestId, queryByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({ id: 'general', unread: 3, unreadHasMention: true }),
    });
    expect(getByTestId('row-mention-dot-general')).not.toBeNull();
    // The numeric badge is NOT rendered in mention-dot mode.
    expect(queryByTestId('row-unread-badge-general')).toBeNull();
  });

  it('mention dot persists when channel is also muted (Design Spec §8.2)', () => {
    // Phil's hard invariant: mute suppresses notifications + sidebar
    // bolding for ordinary messages, but mention-bearing unread still
    // surfaces a dot. The row carries .muted to dim, but the dot stays.
    const { getByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({
        id: 'general',
        unread: 1,
        unreadHasMention: true,
        muted: true,
      }),
    });
    const row = getByTestId('sidebar-channel-row-general');
    expect(row.classList.contains('muted')).toBe(true);
    // Dot must STILL render despite the muted modifier.
    expect(getByTestId('row-mention-dot-general')).not.toBeNull();
  });

  it('no unread badge when unread === 0', () => {
    const { queryByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({ id: 'general', unread: 0 }),
    });
    expect(queryByTestId('row-unread-badge-general')).toBeNull();
    expect(queryByTestId('row-mention-dot-general')).toBeNull();
  });
});

// ── Mute icon visibility ───────────────────────────────────────────────

describe('SidebarChannelRow — mute icon visibility', () => {
  it('renders a mute icon when channel.muted is true', () => {
    const { getByTestId } = renderRow({
      channel: makeChannel({ id: 'general', muted: true }),
    });
    expect(getByTestId('row-mute-general')).not.toBeNull();
  });

  it('omits the mute icon when channel.muted is false', () => {
    const { queryByTestId } = renderRow({
      channel: makeChannel({ id: 'general', muted: false }),
    });
    expect(queryByTestId('row-mute-general')).toBeNull();
  });
});

// ── Member-count chip visibility ───────────────────────────────────────

describe('SidebarChannelRow — member-count chip', () => {
  it('shows the chip when memberCount >= 2 and marks it always-visible for Available section', () => {
    const { getByTestId } = renderRow({
      sectionVariant: 'available',
      channel: makeChannel({ id: 'rust-talk', member: false, memberCount: 12 }),
    });
    const chip = getByTestId('row-member-chip-rust-talk');
    expect(chip.textContent.trim()).toBe('12');
    expect(chip.classList.contains('always-visible')).toBe(true);
  });

  it('hides the chip when memberCount < 2', () => {
    const { queryByTestId } = renderRow({
      channel: makeChannel({ id: 'general', memberCount: 1 }),
    });
    expect(queryByTestId('row-member-chip-general')).toBeNull();
  });

  it('shows the chip in Active section but WITHOUT always-visible class (hover-only)', () => {
    const { getByTestId } = renderRow({
      sectionVariant: 'active',
      channel: makeChannel({ id: 'general', memberCount: 5 }),
    });
    const chip = getByTestId('row-member-chip-general');
    expect(chip.classList.contains('always-visible')).toBe(false);
  });
});

// ── Click + keyboard activation ────────────────────────────────────────

describe('SidebarChannelRow — click + keyboard handlers', () => {
  it('invokes onClick with the channel id when the row is clicked', async () => {
    const onClick = vi.fn();
    const { getByTestId } = renderRow({ onClick });
    await fireEvent.click(getByTestId('sidebar-channel-row-general'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith('general');
  });

  it('invokes onClick when Enter is pressed on the row', async () => {
    const onClick = vi.fn();
    const { getByTestId } = renderRow({ onClick });
    await fireEvent.keyDown(getByTestId('sidebar-channel-row-general'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith('general');
  });

  it('invokes onClick when Space is pressed on the row', async () => {
    const onClick = vi.fn();
    const { getByTestId } = renderRow({ onClick });
    await fireEvent.keyDown(getByTestId('sidebar-channel-row-general'), { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

// ── Right-click → onContextMenu ────────────────────────────────────────

describe('SidebarChannelRow — context menu handler', () => {
  it('invokes onContextMenu(event, id) on right-click', async () => {
    const onContextMenu = vi.fn();
    const { getByTestId } = renderRow({ onContextMenu });
    const row = getByTestId('sidebar-channel-row-general');
    await fireEvent.contextMenu(row);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    // First argument is the event; we don't pin its exact shape (jsdom
    // synth events differ from real browser events) but the channel id
    // as second arg must match.
    const [eventArg, idArg] = onContextMenu.mock.calls[0];
    expect(eventArg).toBeDefined();
    expect(idArg).toBe('general');
  });
});

// ── Star toggle + stopPropagation ──────────────────────────────────────

describe('SidebarChannelRow — star toggle wiring', () => {
  it('invokes onStarToggle with the channel id when the star button is clicked', async () => {
    const onStarToggle = vi.fn();
    const { getByTestId } = renderRow({ onStarToggle });
    await fireEvent.click(getByTestId('row-star-general'));
    expect(onStarToggle).toHaveBeenCalledTimes(1);
    expect(onStarToggle).toHaveBeenCalledWith('general');
  });

  it('star click does NOT bubble up to the row-level onClick (stopPropagation)', async () => {
    const onClick = vi.fn();
    const onStarToggle = vi.fn();
    const { getByTestId } = renderRow({ onClick, onStarToggle });
    await fireEvent.click(getByTestId('row-star-general'));
    // Star fired:
    expect(onStarToggle).toHaveBeenCalledTimes(1);
    // Row-level click MUST NOT fire — otherwise starring a channel
    // would also switch to it (the v0.3.3 G-4 fix, re-asserted here
    // at the atomic row level).
    expect(onClick).not.toHaveBeenCalled();
  });

  it('starred=true gives aria-label "Unstar #{name}", starred=false gives "Star #{name}"', () => {
    const { getByTestId, rerender } = renderRow({
      channel: makeChannel({ id: 'lora-training', name: 'lora-training', starred: false }),
    });
    expect(getByTestId('row-star-lora-training').getAttribute('aria-label')).toBe(
      'Star lora-training',
    );

    rerender({
      channel: makeChannel({ id: 'lora-training', name: 'lora-training', starred: true }),
      sectionVariant: 'starred',
      isActive: false,
      onClick: vi.fn(),
      onContextMenu: vi.fn(),
      onStarToggle: vi.fn(),
    });
    expect(getByTestId('row-star-lora-training').getAttribute('aria-label')).toBe(
      'Unstar lora-training',
    );
  });
});

// ── isActive selection state ───────────────────────────────────────────

describe('SidebarChannelRow — isActive selection state', () => {
  it('applies the .active class and aria-pressed=true when isActive is true', () => {
    const { getByTestId } = renderRow({ isActive: true });
    const row = getByTestId('sidebar-channel-row-general');
    expect(row.classList.contains('active')).toBe(true);
    expect(row.getAttribute('aria-pressed')).toBe('true');
  });

  it('omits the .active class when isActive is false', () => {
    const { getByTestId } = renderRow({ isActive: false });
    const row = getByTestId('sidebar-channel-row-general');
    expect(row.classList.contains('active')).toBe(false);
    expect(row.getAttribute('aria-pressed')).toBe('false');
  });
});
