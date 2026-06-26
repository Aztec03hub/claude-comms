// EmojiPicker — category tabs + search actually filter the grid
// (WEB-E finding #7).
//
// Regression: the 8 category tabs set `activeCategory` and the search box
// bound `searchQuery`, but the grid ALWAYS iterated `frequentEmojis` with a
// hardcoded "Frequently Used" label. 7 of 8 tabs and the type-to-filter
// affordance did nothing. These tests pin that BOTH controls now change what
// renders.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import EmojiPicker from '../src/components/EmojiPicker.svelte';

afterEach(() => {
  cleanup();
});

function renderPicker(overrides = {}) {
  return render(EmojiPicker, {
    props: {
      onSelect: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    },
  });
}

function gridLabel() {
  return document.querySelector('[data-testid="emoji-grid-label"]').textContent.trim();
}

function gridEmojis() {
  return Array.from(document.querySelectorAll('[data-testid="emoji-item"]')).map((b) =>
    b.textContent.trim(),
  );
}

describe('EmojiPicker — filtering', () => {
  it('defaults to the Frequently-used grid', () => {
    renderPicker();
    expect(gridLabel().toLowerCase()).toContain('frequently used');
    const emojis = gridEmojis();
    expect(emojis).toContain('👍');
    expect(emojis.length).toBeGreaterThan(8);
  });

  it('typing a search query filters the grid across all categories', async () => {
    renderPicker();
    const search = document.querySelector('[data-testid="emoji-search"]');
    await fireEvent.input(search, { target: { value: 'pizza' } });
    await tick();

    expect(gridLabel()).toBe('Search results');
    const emojis = gridEmojis();
    expect(emojis).toContain('🍕');
    // The default frequent set is no longer shown wholesale.
    expect(emojis).not.toContain('👍');
    expect(emojis.length).toBe(1);
  });

  it('shows an empty state when nothing matches the query', async () => {
    renderPicker();
    const search = document.querySelector('[data-testid="emoji-search"]');
    await fireEvent.input(search, { target: { value: 'zzzznotanemoji' } });
    await tick();

    expect(document.querySelector('[data-testid="emoji-empty"]')).not.toBeNull();
    expect(gridEmojis().length).toBe(0);
  });

  it('clicking a category tab switches the grid dataset', async () => {
    renderPicker();
    const foodTab = document.querySelector('[data-testid="emoji-category-food"]');
    expect(foodTab).not.toBeNull();
    await fireEvent.click(foodTab);
    await tick();

    expect(gridLabel().toLowerCase()).toContain('food');
    const emojis = gridEmojis();
    expect(emojis).toContain('🍕');
    // Frequent-only glyphs are gone now that the Food dataset renders.
    expect(emojis).not.toContain('👍');
  });

  it('still submits free-text on Enter (existing behaviour preserved)', async () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    const search = document.querySelector('[data-testid="emoji-search"]');
    await fireEvent.input(search, { target: { value: 'shipit' } });
    await tick();
    await fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith({ emoji: 'shipit', name: 'shipit', code: 'shipit' });
  });
});
