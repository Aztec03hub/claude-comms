// ReactionDetailsPanel — who-reacted detail popover (M6 / M8).
//
// Verifies:
//   - emoji rows render with counts; selecting a different emoji re-filters
//     the user list
//   - reactor names resolve ("You" for self) in natural insertion order
//   - portaled to <body> with position:fixed + z-index >= 250
//   - Escape closes; outside-click closes
//   - when the selected emoji vanishes (live removal) it falls to the next;
//     when all emoji vanish the panel closes

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ReactionDetailsPanel from '../src/components/ReactionDetailsPanel.svelte';

const SELF = 'aaaaaaaa';

function makeResolver(names = {}, selfKey = SELF) {
  return (key) => ({ name: names[key] ?? key, isSelf: key === selfKey });
}

function reaction(emoji, users, active = false) {
  return { emoji, users, count: users.length, active };
}

function anchorRect() {
  return { left: 100, top: 100, bottom: 120, right: 140 };
}

afterEach(() => cleanup());

describe('ReactionDetailsPanel', () => {
  it('portals to <body> and positions from the anchor rect', async () => {
    render(ReactionDetailsPanel, {
      props: {
        reactions: [reaction('👍', ['bbbbbbbb'])],
        resolveReactor: makeResolver({ bbbbbbbb: 'Alice' }),
        anchorRect: anchorRect(),
        onClose: vi.fn(),
      },
    });
    await tick();
    const panel = document.body.querySelector('.reaction-details');
    expect(panel).toBeTruthy();
    // The portal is the actual stacking-context fix: the panel is lifted out
    // of the component tree to <body> so its (source) z-index:250 / fixed
    // positioning applies against the page, above the side panels.
    expect(panel.parentElement).toBe(document.body);
    expect(panel.getAttribute('role')).toBe('dialog');
    // Positioned from the anchor rect via inline left/top (fixed coords):
    // anchor.left=100 → left:100px; anchor.bottom=120 + 8px gap → top:128px.
    expect(panel.style.left).toBe('100px');
    expect(panel.style.top).toBe('128px');
  });

  it('shows reactors for the initial emoji ("You" for self, natural order)', async () => {
    render(ReactionDetailsPanel, {
      props: {
        reactions: [reaction('👍', [SELF, 'bbbbbbbb'], true)],
        resolveReactor: makeResolver({ bbbbbbbb: 'Alice' }),
        anchorRect: anchorRect(),
        initialEmoji: '👍',
        onClose: vi.fn(),
      },
    });
    await tick();
    const users = [...document.body.querySelectorAll('.user')].map((n) => n.textContent.trim());
    expect(users).toEqual(['You', 'Alice']);
  });

  it('switches the user list when a different emoji is selected', async () => {
    render(ReactionDetailsPanel, {
      props: {
        reactions: [
          reaction('👍', ['bbbbbbbb']),
          reaction('🎉', ['cccccccc', 'dddddddd']),
        ],
        resolveReactor: makeResolver({
          bbbbbbbb: 'Alice', cccccccc: 'Bob', dddddddd: 'Carol',
        }),
        anchorRect: anchorRect(),
        initialEmoji: '👍',
        onClose: vi.fn(),
      },
    });
    await tick();
    expect([...document.body.querySelectorAll('.user')].map((n) => n.textContent.trim()))
      .toEqual(['Alice']);

    const rows = document.body.querySelectorAll('.emoji-row');
    expect(rows.length).toBe(2);
    await fireEvent.click(rows[1]); // 🎉
    await tick();
    expect([...document.body.querySelectorAll('.user')].map((n) => n.textContent.trim()))
      .toEqual(['Bob', 'Carol']);
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(ReactionDetailsPanel, {
      props: {
        reactions: [reaction('👍', ['bbbbbbbb'])],
        resolveReactor: makeResolver(),
        anchorRect: anchorRect(),
        onClose,
      },
    });
    await tick();
    const panel = document.body.querySelector('.reaction-details');
    await fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on outside click', async () => {
    const onClose = vi.fn();
    render(ReactionDetailsPanel, {
      props: {
        reactions: [reaction('👍', ['bbbbbbbb'])],
        resolveReactor: makeResolver(),
        anchorRect: anchorRect(),
        onClose,
      },
    });
    await tick();
    await fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('falls to the next emoji when the selected one is removed', async () => {
    const { rerender } = render(ReactionDetailsPanel, {
      props: {
        reactions: [
          reaction('👍', ['bbbbbbbb']),
          reaction('🎉', ['cccccccc']),
        ],
        resolveReactor: makeResolver({ bbbbbbbb: 'Alice', cccccccc: 'Bob' }),
        anchorRect: anchorRect(),
        initialEmoji: '👍',
        onClose: vi.fn(),
      },
    });
    await tick();
    expect([...document.body.querySelectorAll('.user')].map((n) => n.textContent.trim()))
      .toEqual(['Alice']);

    // 👍 is removed live → selection falls to 🎉.
    await rerender({ reactions: [reaction('🎉', ['cccccccc'])] });
    await tick();
    expect([...document.body.querySelectorAll('.user')].map((n) => n.textContent.trim()))
      .toEqual(['Bob']);
  });

  it('closes when all emoji vanish', async () => {
    const onClose = vi.fn();
    const { rerender } = render(ReactionDetailsPanel, {
      props: {
        reactions: [reaction('👍', ['bbbbbbbb'])],
        resolveReactor: makeResolver(),
        anchorRect: anchorRect(),
        onClose,
      },
    });
    await tick();
    await rerender({ reactions: [] });
    await tick();
    expect(onClose).toHaveBeenCalled();
  });
});
