// overlay-top-layer-guard.spec.js - Tier-1 source-scan guard for the
// overlay / top-layer overhaul (design §E Tier-1).
//
// WHY a source scan (not a render): jsdom 29.0.2 - the vitest DOM -
// implements NONE of the top-layer APIs (no showModal / showPopover /
// popover attribute / :popover-open / :modal / elementFromPoint), so the
// "actually painted on top" behaviour can ONLY be asserted in real
// Chromium (Playwright Tier-2, e2e/scenarios/14-overlay-top-layer.spec.ts).
// This tier is a pure readFileSync lint over the component sources that
// bites at EDIT time.
//
// RULES (active for every file NOT in ALLOWED):
//   1. Overlay-shaped without the primitive fails. A component that looks
//      like a floating overlay - role="dialog|menu|tooltip|listbox|
//      menuitem", OR position:fixed combined with a z-index - MUST
//      reference the approved primitive (use:topLayer / <Modal / <Popover)
//      or an allowed escape (bits-ui Dialog./ContextMenu.).
//   2. Ban raw z-index outside the token scale. Every `z-index:` must be a
//      `var(--z-*)` token (or 0/auto/inherit/...). A bare integer fails
//      with the file - this is the rule that would have caught a "9999
//      left behind" or a new ad-hoc "73".
//
// ── STRICT MODE (Phase 2 complete) ───────────────────────────────────────
// Every floating overlay has been migrated to the primitive and every
// residual surface tokenised onto the --z-* scale, so ALLOWED is now shrunk
// to its irreducible core. Files in ALLOWED are skipped by BOTH rules; the
// ONLY remaining entries are:
//
//   * The PASSIVE notification surfaces (toasts + banners). These MUST stay
//     out of the native top layer - a top-layer toast would steal focus /
//     inert the page, wrong for a passive notification - so they keep a
//     `position: fixed` + `var(--z-toast)`/`var(--z-banner)` token. Because
//     Rule 1 flags `position:fixed` paired with any z-index, they are
//     exempted here by design (design §F.5).
//   * The three bits-ui components (ContextMenu / ChannelModal /
//     ConfirmDialog). bits-ui portals them to <body> with its own tested
//     focus-trap; design §F.1 keeps them as-is and exempts them.
//
// EVERYTHING else - all migrated overlays, all docked panels, every in-flow
// component, App.svelte and app.css - now passes BOTH rules ON MERIT (uses
// the primitive and carries only `var(--z-*)` tokens). Adding anything new
// here should be a deliberate, documented exception, not a convenience.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const COMPONENTS_DIR = resolve(SRC, 'components');
const APP_SVELTE = resolve(SRC, 'App.svelte');
const APP_CSS = resolve(SRC, 'app.css');

// ── STRICT ALLOWED set (basenames). See header for the rationale. ───────
// Only the passive toasts/banners and the three bits-ui components remain.
const ALLOWED = new Set([
  // Passive notification surfaces - intentionally NOT top layer (design §F.5).
  'NotificationToast.svelte',
  'UndoToast.svelte',
  'RemoteUpdateBanner.svelte',
  'ConnectionStatus.svelte',
  // bits-ui components - portal to <body> with their own focus-trap (design §F.1).
  'ContextMenu.svelte',
  'ChannelModal.svelte',
  'ConfirmDialog.svelte',
  // NOTE: every other overlay/panel/in-flow file (and App.svelte / app.css) is
  // deliberately ABSENT - each must pass BOTH rules on merit.
]);

// Approved primitive / escape references that satisfy Rule 1.
const PRIMITIVE_RE = /use:topLayer|<Modal\b|<Popover\b|bits-ui|Dialog\.|ContextMenu\./;

// Overlay shape: an overlay role, OR position:fixed paired with a z-index.
const OVERLAY_ROLE_RE = /role="(?:dialog|menu|tooltip|listbox|menuitem)"/;
const POSITION_FIXED_RE = /position:\s*fixed/;
const HAS_Z_INDEX_RE = /z-index:/;

// Allowed z-index values: a --z-* token, or the structural keywords.
const Z_TOKEN_RE = /^var\(\s*--z-[a-z-]+\s*\)$/;
const Z_KEYWORDS = new Set(['0', 'auto', 'inherit', 'initial', 'unset', 'revert']);
const Z_INDEX_DECL_RE = /z-index:\s*([^;}\n]+)/g;

function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Strip HTML/Svelte (`<!-- -->`) and CSS/JS block (`/* *\/`) comments so the
 * rules never trip on PROSE that merely mentions `z-index:` /
 * `position: fixed` (e.g. a migration note documenting the old trap). Only
 * real code/markup is scanned.
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Read a file with comments stripped, for rule scanning. */
function scan(file) {
  return stripComments(read(file));
}

function isOverlayShaped(src) {
  if (OVERLAY_ROLE_RE.test(src)) return true;
  if (POSITION_FIXED_RE.test(src) && HAS_Z_INDEX_RE.test(src)) return true;
  return false;
}

/**
 * Return the list of offending bare z-index values in `src` (empty = clean).
 */
function badZIndexValues(src) {
  const bad = [];
  for (const m of src.matchAll(Z_INDEX_DECL_RE)) {
    const value = m[1].trim();
    if (Z_TOKEN_RE.test(value)) continue;
    if (Z_KEYWORDS.has(value)) continue;
    bad.push(value);
  }
  return bad;
}

const componentFiles = readdirSync(COMPONENTS_DIR)
  .filter((f) => f.endsWith('.svelte'))
  .map((f) => resolve(COMPONENTS_DIR, f));

// Files subject to Rule 1 (overlay shape): components + App.svelte.
const rule1Files = [...componentFiles, APP_SVELTE];
// Files subject to Rule 2 (z-index ban): components + App.svelte + app.css.
const rule2Files = [...componentFiles, APP_SVELTE, APP_CSS];

describe('overlay top-layer guard - Tier 1 source scan (design §E)', () => {
  it('every non-ALLOWED overlay-shaped component references the primitive (Rule 1)', () => {
    const violations = [];
    for (const file of rule1Files) {
      const name = basename(file);
      if (ALLOWED.has(name)) continue;
      const src = scan(file);
      if (isOverlayShaped(src) && !PRIMITIVE_RE.test(src)) {
        violations.push(name);
      }
    }
    expect(
      violations,
      `Overlay-shaped components missing use:topLayer/<Modal>/<Popover>: ${violations.join(', ')}. ` +
        'Migrate to the primitive (or, if intentionally residual, add to ALLOWED with a Phase-2 note).',
    ).toEqual([]);
  });

  it('every non-ALLOWED file uses only --z-* token z-index values (Rule 2)', () => {
    const violations = [];
    for (const file of rule2Files) {
      const name = basename(file);
      if (ALLOWED.has(name)) continue;
      const bad = badZIndexValues(scan(file));
      if (bad.length > 0) violations.push(`${name}: ${bad.join(', ')}`);
    }
    expect(
      violations,
      `Raw (non-token) z-index found. Use var(--z-*) from src/app.css: ${violations.join(' | ')}`,
    ).toEqual([]);
  });

  // ── StatusEditor: the marquee migration must pass on merit ──────────────
  it('StatusEditor is NOT in ALLOWED (it passes by using the primitive)', () => {
    expect(ALLOWED.has('StatusEditor.svelte')).toBe(false);
  });

  it('StatusEditor references the top-layer primitive (Rule 1, on merit)', () => {
    const src = scan(resolve(COMPONENTS_DIR, 'StatusEditor.svelte'));
    // It is overlay-shaped (role="dialog") AND must reference the primitive.
    expect(isOverlayShaped(src)).toBe(true);
    expect(PRIMITIVE_RE.test(src)).toBe(true);
    // Concretely: it renders inside <Popover> (the non-modal wrapper).
    expect(src).toMatch(/<Popover\b/);
  });

  it('StatusEditor carries NO bare z-index and NO position:fixed (Rule 2, on merit)', () => {
    const src = scan(resolve(COMPONENTS_DIR, 'StatusEditor.svelte'));
    expect(badZIndexValues(src)).toEqual([]);
    // The fixed-position trap (and its 90/91 z-index) is gone; the top
    // layer positions the popover.
    expect(src).not.toMatch(/position:\s*fixed/);
  });

  // ── Token scale is defined exactly once, in app.css ─────────────────────
  it('the --z-* token scale is defined in app.css :root', () => {
    const css = read(APP_CSS);
    for (const token of [
      '--z-base',
      '--z-sticky',
      '--z-banner',
      '--z-sidebar',
      '--z-panel',
      '--z-toast',
    ]) {
      expect(css, `app.css must define ${token}`).toMatch(
        new RegExp(`${token}:\\s*\\d+`),
      );
    }
  });

  // ── Guard self-documentation: STRICT mode irreducible core ──────────────
  it('ALLOWED is shrunk to its strict-mode core (toasts/banners + bits-ui)', () => {
    // Phase 2 reduced ALLOWED to exactly the passive notification surfaces
    // (design §F.5) plus the three bits-ui components (design §F.1). If this
    // grows, a real overlay is probably dodging the primitive - scrutinise it.
    expect([...ALLOWED].sort()).toEqual(
      [
        'ChannelModal.svelte',
        'ConfirmDialog.svelte',
        'ConnectionStatus.svelte',
        'ContextMenu.svelte',
        'NotificationToast.svelte',
        'RemoteUpdateBanner.svelte',
        'UndoToast.svelte',
      ].sort(),
    );
  });
});
