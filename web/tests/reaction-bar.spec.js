// ReactionBar — who-reacted tooltip + "See all" + long-press (M5 / M8).
//
// Verifies:
//   - tooltip lists <= MAX_TOOLTIP_NAMES (3) names, then "+N others"
//   - "You" is rendered for self in the tooltip
//   - the "See all" control fires onOpenDetails(emoji, rect)
//   - REGRESSION GUARD: clicking a pill still toggles (onToggleReaction)
//   - a11y: the tooltip is role="tooltip" and the "See all" button is present

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import ReactionBar from '../src/components/ReactionBar.svelte';

const SELF = 'aaaaaaaa';

// Resolver mirroring the store's resolveReactor contract.
function makeResolver(names = {}, selfKey = SELF) {
  return (key) => ({ name: names[key] ?? key, isSelf: key === selfKey });
}

function reaction(emoji, users, active = false) {
  return { emoji, users, count: users.length, active };
}

afterEach(() => cleanup());

describe('ReactionBar tooltip', () => {
  it('lists up to 3 names then "+N others"', () => {
    const names = {
      bbbbbbbb: 'Alice',
      cccccccc: 'Bob',
      dddddddd: 'Carol',
      eeeeeeee: 'Dave',
      ffffffff: 'Eve',
    };
    const { getByRole } = render(ReactionBar, {
      props: {
        reactions: [
          reaction('👍', ['bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee', 'ffffffff']),
        ],
        resolveReactor: makeResolver(names),
      },
    });
    const tooltip = getByRole('tooltip');
    expect(tooltip.textContent).toContain('Alice, Bob, Carol');
    expect(tooltip.textContent).toContain('+2 others');
    expect(tooltip.textContent).not.toContain('Dave');
  });

  it('renders "You" for the self reactor and no overflow under 4 reactors', () => {
    const { getByRole } = render(ReactionBar, {
      props: {
        reactions: [reaction('🎉', [SELF, 'bbbbbbbb'], true)],
        resolveReactor: makeResolver({ bbbbbbbb: 'Alice' }),
      },
    });
    const tooltip = getByRole('tooltip');
    expect(tooltip.textContent).toContain('You, Alice');
    expect(tooltip.textContent).not.toContain('others');
  });

  it('exposes a reachable "See all" control that opens the panel', async () => {
    const onOpenDetails = vi.fn();
    const { getByText } = render(ReactionBar, {
      props: {
        reactions: [reaction('👍', ['bbbbbbbb'])],
        resolveReactor: makeResolver({ bbbbbbbb: 'Alice' }),
        onOpenDetails,
      },
    });
    const seeAll = getByText('See all');
    await fireEvent.click(seeAll);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
    expect(onOpenDetails.mock.calls[0][0]).toBe('👍');
  });
});

describe('ReactionBar regression: pill click still toggles', () => {
  it('fires onToggleReaction with the emoji on a plain click', async () => {
    const onToggleReaction = vi.fn();
    const onOpenDetails = vi.fn();
    const { getByLabelText } = render(ReactionBar, {
      props: {
        reactions: [reaction('👍', ['bbbbbbbb'])],
        resolveReactor: makeResolver({ bbbbbbbb: 'Alice' }),
        onToggleReaction,
        onOpenDetails,
      },
    });
    const pill = getByLabelText(/👍 reaction/);
    await fireEvent.click(pill);
    expect(onToggleReaction).toHaveBeenCalledWith('👍');
    // A plain click must NOT open the panel.
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it('still calls onAddReaction from the + button', async () => {
    const onAddReaction = vi.fn();
    const { getByLabelText } = render(ReactionBar, {
      props: {
        reactions: [reaction('👍', ['bbbbbbbb'])],
        resolveReactor: makeResolver(),
        onAddReaction,
      },
    });
    await fireEvent.click(getByLabelText('Add reaction'));
    expect(onAddReaction).toHaveBeenCalledTimes(1);
  });
});
