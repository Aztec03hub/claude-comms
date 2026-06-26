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
// ── PHASE 1 SEEDING (read this before editing ALLOWED) ───────────────────
// The rules are ACTIVE, but ALLOWED is seeded to TODAY's reality so the
// pre-migration tree stays green: it lists every currently-unmigrated
// overlay, the passive toasts/banners, the docked panels, the bits-ui
// components, and app.css (whose legacy z-index values are tokenised in
// Phase 2). Files in ALLOWED are skipped by BOTH rules.
//
// StatusEditor.svelte is INTENTIONALLY NOT in ALLOWED: it was migrated to
// <Popover>/use:topLayer in this PR, so it must pass the rules by actually
// using the primitive and carrying no bare z-index. The explicit
// assertions at the bottom pin that.
//
// PHASE 2 shrinks ALLOWED toward EMPTY: as each overlay migrates to the
// primitive (and each residual surface moves onto the --z-* tokens),
// delete its entry here. When ALLOWED is empty the guard is fully strict.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const COMPONENTS_DIR = resolve(SRC, 'components');
const APP_SVELTE = resolve(SRC, 'App.svelte');
const APP_CSS = resolve(SRC, 'app.css');

// ── Phase 1 ALLOWED seed (see header). Basenames. ───────────────────────
// Every entry is a pre-existing violator kept green until Phase 2 migrates
// it. The bits-ui components (ContextMenu / ChannelModal / ConfirmDialog /
// LeaveChannelDialog) are also here: design §F.1 keeps them on bits-ui;
// they portal to <body> so the bug class does not apply.
const ALLOWED = new Set([
  // residual passive surfaces (stay non-top-layer; move to --z-* in Phase 2)
  'NotificationToast.svelte',
  'UndoToast.svelte',
  'RemoteUpdateBanner.svelte',
  'ConnectionStatus.svelte',
  // docked panels (stacking-context creators; tokenised in Phase 2)
  'Sidebar.svelte',
  'SettingsPanel.svelte',
  'SearchPanel.svelte',
  'ArtifactPanel.svelte',
  'ThreadPanel.svelte',
  'PinnedPanel.svelte',
  'ConversationBrowser.svelte',
  'UserProfileView.svelte',
  'ArtifactList.svelte',
  'MemberList.svelte',
  'MessageBubble.svelte',
  'MessageActions.svelte',
  'MessageInput.svelte',
  'ChatView.svelte',
  'ScrollToBottom.svelte',
  // bits-ui components (design §F.1: KEEP, exempt)
  'ContextMenu.svelte',
  'ChannelModal.svelte',
  'ConfirmDialog.svelte',
  'LeaveChannelDialog.svelte',
  // unmigrated floating overlays (Phase 2 targets)
  'InviteParticipantDialog.svelte',
  'ProfileCard.svelte',
  'NotificationPolicyMenu.svelte',
  'ForwardPicker.svelte',
  'KeyboardShortcutsHelp.svelte',
  'ReactionBar.svelte',
  'ChannelContextMenu.svelte',
  'ArtifactDetailHeader.svelte',
  'ReadReceipt.svelte',
  'EmojiPicker.svelte',
  'ChannelDirectoryModal.svelte',
  'TypeNameConfirmDialog.svelte',
  'MentionDropdown.svelte',
  'MemberContextMenu.svelte',
  'ReactionDetailsPanel.svelte',
  // root + global stylesheet (App quick-join / mobile-sidebar block; legacy
  // app.css z-index values) - tokenised in Phase 2.
  'App.svelte',
  'app.css',
  // NOTE: StatusEditor.svelte is deliberately ABSENT - it must pass on merit.
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

  // ── Guard self-documentation: Phase 2 shrinks ALLOWED toward empty ──────
  it('ALLOWED is a finite seed that Phase 2 will shrink (documented)', () => {
    // Sanity: the seed is non-empty today (Phase 1) and StatusEditor proves
    // the rules are live. This assertion exists so a future reader sees the
    // intent; Phase 2 deletes entries until the set is empty.
    expect(ALLOWED.size).toBeGreaterThan(0);
  });
});
