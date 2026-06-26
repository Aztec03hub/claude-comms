// Regression test for the "invisible code-block text" bug.
//
// The inline composer textarea uses a "transparent-glyph + overlay" technique:
// its own glyphs are `color: transparent` and the separate `.input-overlay`
// paints the visible, syntax-highlighted text. That transparency rule used to
// be written as the broad descendant selector `.input-wrap textarea`
// (specificity 0,1,1). The dedicated block-mode textarea (`.block-textarea`,
// specificity 0,1,0) lives INSIDE `.input-wrap`, so the broad rule beat its
// own `color` and forced its glyphs transparent, so typed code was invisible.
//
// The fix scopes the transparency rules to the inline textarea via a dedicated
// `.inline-textarea` class. This test proves the CASCADE OUTCOME (not merely
// that a class exists): it parses the component's real <style> rules and uses
// `element.matches()` against the live rendered DOM. The rendered elements keep
// their authored classes (plus Svelte's scope class) and are attached to the
// document, so descendant combinators like `.input-wrap textarea.inline-textarea`
// resolve exactly as the browser cascade would when deciding applicability.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import MessageInput from '../src/components/MessageInput.svelte';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENT_PATH = resolve(__dirname, '../src/components/MessageInput.svelte');

const PARTICIPANTS = {
  'phil-key': { key: 'phil-key', name: 'phil', type: 'human', connections: { 'web-1': {} } },
};

function makeStore() {
  return {
    participants: PARTICIPANTS,
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    sendMessage: () => {},
    notifyTyping: () => {},
  };
}

/**
 * Parse the component's <style> block into a flat list of
 * { selector, declarations } records. Comments are stripped first; the CSS in
 * this component is flat (no nested rules) so a single brace pass is exact.
 */
function parseStyleRules() {
  const src = readFileSync(COMPONENT_PATH, 'utf-8');
  const styleMatch = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  if (!styleMatch) throw new Error('no <style> block found in MessageInput.svelte');
  const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    const declarations = m[2].trim();
    if (selector) rules.push({ selector, declarations });
  }
  return rules;
}

/** Pull the `color:` value out of a declaration block, or null if absent. */
function colorOf(declarations) {
  const m = declarations.match(/(?:^|;)\s*color\s*:\s*([^;]+?)\s*(?:;|$)/);
  return m ? m[1].trim() : null;
}

/** matches() that swallows pseudo-element selectors jsdom can't evaluate. */
function matchesSafe(el, selector) {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

async function enterBlockMode() {
  const store = makeStore();
  const { container } = render(MessageInput, {
    props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
  });
  const inline = container.querySelector('textarea[data-testid="message-input"]');
  // Trigger B: ``` on its own line + Shift+Enter opens the dedicated block textarea.
  inline.value = '```';
  inline.setSelectionRange(3, 3);
  await fireEvent.input(inline, { target: inline });
  await tick();
  await fireEvent.keyDown(inline, { key: 'Enter', shiftKey: true });
  await tick();
  await Promise.resolve();
  await tick();
  const block = container.querySelector('[data-testid="block-textarea"]');
  return { container, inline, block };
}

afterEach(() => cleanup());

describe('MessageInput block textarea visibility (regression: invisible code-block text)', () => {
  it('block textarea glyph color is NOT forced transparent by the inline overlay rules', async () => {
    const { inline, block } = await enterBlockMode();
    expect(block).toBeTruthy();

    const rules = parseStyleRules();
    // Base color rules only (drop pseudo-element selectors like ::selection).
    const colorRules = rules
      .map((r) => ({ selector: r.selector, color: colorOf(r.declarations) }))
      .filter((r) => r.color !== null && !r.selector.includes('::'));

    const transparentRules = colorRules.filter((r) => r.color === 'transparent');
    const visibleRules = colorRules.filter((r) => r.color !== 'transparent');

    // Sanity: the transparent-glyph overlay technique is still present.
    expect(transparentRules.length).toBeGreaterThan(0);

    // CASCADE OUTCOME 1, the bug: NO transparent-color rule may apply to the
    // block textarea. If none match, it cannot be transparent at any specificity.
    for (const r of transparentRules) {
      expect(
        matchesSafe(block, r.selector),
        `block textarea must not match transparent-color rule "${r.selector}"`,
      ).toBe(false);
    }

    // CASCADE OUTCOME 2: the block textarea is targeted by a VISIBLE color rule
    // (its own `.block-textarea` rule), so its glyphs render.
    expect(visibleRules.some((r) => matchesSafe(block, r.selector))).toBe(true);

    // CASCADE OUTCOME 3: the inline overlay technique is unchanged: the inline
    // textarea IS still targeted by a transparent-glyph rule.
    expect(transparentRules.some((r) => matchesSafe(inline, r.selector))).toBe(true);
    // ...and is NOT targeted by any visible-color textarea rule that would
    // defeat the overlay (only the overlay paints inline text).
    const inlineTextareaVisible = visibleRules.filter(
      (r) => matchesSafe(inline, r.selector) && /textarea/.test(r.selector),
    );
    expect(inlineTextareaVisible).toHaveLength(0);
  });

  it('focused DOM check: block has block-textarea (not inline-textarea); inline has inline-textarea', async () => {
    const { inline, block } = await enterBlockMode();
    expect(block).toBeTruthy();
    expect(block.classList.contains('block-textarea')).toBe(true);
    expect(block.classList.contains('inline-textarea')).toBe(false);
    expect(inline.classList.contains('inline-textarea')).toBe(true);
  });

  it('block selection paints VISIBLE glyphs while the inline selection stays transparent', async () => {
    await enterBlockMode();
    const rules = parseStyleRules();

    const blockSelection = rules.find((r) => /\.block-textarea[^,{]*::selection/.test(r.selector));
    expect(blockSelection, '.block-textarea::selection rule must exist').toBeTruthy();
    expect(colorOf(blockSelection.declarations)).not.toBe('transparent');

    const inlineSelection = rules.find((r) => /\.inline-textarea[^,{]*::selection/.test(r.selector));
    expect(inlineSelection, '.inline-textarea::selection rule must exist').toBeTruthy();
    // Load-bearing: keeping the inline selected glyphs transparent prevents the
    // "doubled text" regression (overlay + textarea both painting).
    expect(colorOf(inlineSelection.declarations)).toBe('transparent');
  });
});
