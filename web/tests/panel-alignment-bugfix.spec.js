// v0.4.4 hotfix - SearchPanel + SettingsPanel alignment regression coverage.
//
// Phil's Layer B real-browser pass against v0.4.3 caught SearchPanel +
// SettingsPanel rendering with an 82px BLANK SPACE above them - i.e.
// not visually connected to the ChatHeader. ArtifactPanel rendered
// flush. Root cause: pre-v0.4.2 the inline chat header lived OUTSIDE
// the chat container at exactly 82px tall, and the right-side panels
// were offset by ``top: 82px`` so they wouldn't cover it. v0.4.2 moved
// ChatHeader INSIDE ChatView (which is itself a sibling of the panels
// within the same ``<main class="center">`` flex column), making the
// 82px offset vestigial. ArtifactPanel was already updated to
// ``top: 0``; SearchPanel + SettingsPanel were missed.
//
// Why automated Playwright E2E missed this (W-13 anti-pattern per the
// v0.4.4 iteration log): the first-run screenshot baseline codifies
// whatever state existed at capture. Visual regression detects DRIFT,
// not whether baseline is correct. SearchPanel + SettingsPanel got
// their "unattached" rendering captured as baseline.
//
// The v0.4.4 fix is a 2-line CSS change in each panel: ``top: 82px``
// → ``top: 0``, mirroring ArtifactPanel's working CSS exactly.
//
// This suite pins:
//   1. ArtifactPanel uses ``top: 0`` (the reference pattern; freezes
//      the canonical alignment so any future regression there
//      surfaces too).
//   2. SearchPanel uses ``top: 0`` (Bug 5).
//   3. SettingsPanel uses ``top: 0`` (Bug 6).
//   4. Neither SearchPanel nor SettingsPanel contains the regressed
//      ``top: 82px`` constant anywhere in the file (defends against
//      a future variant being introduced elsewhere in the same file).
//   5. All three panels share the same ``right: 0`` + ``bottom: 0``
//      anchor - a cross-component invariant pin (P-2) that detects
//      any drift in panel positioning conventions.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
function readPanelSrc(filename) {
  return readFileSync(
    resolve(HERE, '..', 'src', 'components', filename),
    'utf8',
  );
}

/**
 * Extract the CSS block for a given panel selector. Returns the
 * substring from the selector opening brace to the matching closing
 * brace. We use a simple bracket counter to handle nested rules
 * defensively even though our panel CSS is currently flat.
 */
function cssBlockFor(src, selector) {
  const start = src.indexOf(`.${selector} {`);
  if (start < 0) return '';
  // Walk to the matching closing brace.
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  return '';
}

describe('Slide-in panel alignment - v0.4.4 hotfix CSS top:0 contract', () => {
  it('ArtifactPanel sets top: 0 (the reference pattern)', () => {
    const src = readPanelSrc('ArtifactPanel.svelte');
    const block = cssBlockFor(src, 'artifact-panel');
    expect(block).toBeTruthy();
    expect(block).toMatch(/top:\s*0;/);
  });

  it('SearchPanel sets top: 0 (Bug 5 fix)', () => {
    const src = readPanelSrc('SearchPanel.svelte');
    const block = cssBlockFor(src, 'search-panel');
    expect(block).toBeTruthy();
    expect(block).toMatch(/top:\s*0;/);
  });

  it('SettingsPanel sets top: 0 (Bug 6 fix)', () => {
    const src = readPanelSrc('SettingsPanel.svelte');
    const block = cssBlockFor(src, 'settings-panel');
    expect(block).toBeTruthy();
    expect(block).toMatch(/top:\s*0;/);
  });

  it('source-level pin: SearchPanel.svelte contains no ``top: 82px`` (the regressed value)', () => {
    const src = readPanelSrc('SearchPanel.svelte');
    expect(src).not.toMatch(/top:\s*82px/);
  });

  it('source-level pin: SettingsPanel.svelte contains no ``top: 82px``', () => {
    const src = readPanelSrc('SettingsPanel.svelte');
    expect(src).not.toMatch(/top:\s*82px/);
  });

  it('cross-component invariant: all three panels anchor right:0 + bottom:0 (P-2 pin)', () => {
    // Triple-side pin (P-2 per the iteration log). Drift in any one
    // panel's anchor produces a failing test that names the offender,
    // not just "panels misaligned somewhere."
    const cases = [
      { file: 'ArtifactPanel.svelte', selector: 'artifact-panel' },
      { file: 'SearchPanel.svelte', selector: 'search-panel' },
      { file: 'SettingsPanel.svelte', selector: 'settings-panel' },
    ];
    for (const { file, selector } of cases) {
      const src = readPanelSrc(file);
      const block = cssBlockFor(src, selector);
      expect(block, `${file}: no ${selector} block found`).toBeTruthy();
      expect(block, `${file}: ${selector} missing right:0`).toMatch(
        /right:\s*0;/,
      );
      expect(block, `${file}: ${selector} missing bottom:0`).toMatch(
        /bottom:\s*0;/,
      );
    }
  });
});
