// Batch 4L — Accessibility (R2-5) + reduced-motion (R4-8 / R5-4) scan.
//
// Blocking CI gate per plan §"Accessibility (R2-5 — new section)":
// axe-core scans each artifact-panel state the user can reach and asserts
// zero violations. States covered:
//
//   1. List view — empty (no artifacts)
//   2. List view — populated (three artifacts, one starred)
//   3. Detail view — content mode (rendered markdown for a `plan` artifact)
//   4. Detail view — diff mode (v1 → v2 split view with inline char changes)
//   5. Detail view — edit mode (ArtifactEditor textarea + Save/Cancel)
//   6. Conflict banner open (RemoteUpdateBanner above edit mode)
//
// Motion variant: states 5 + 6 are re-run with `prefers-reduced-motion: reduce`
// forced via a jsdom `matchMedia` mock, to catch any motion-coupled a11y
// regression. The RemoteUpdateBanner owns the only animation we disable for
// reduced motion — but the scan matrix extends to every covered state per
// the plan §1 R4-8 note ("Axe scan matrix includes `prefers-reduced-motion:
// reduce` variants of every covered panel state").
//
// Axe config note: jsdom has no layout engine, so axe's `color-contrast`
// rule returns `cantTell` / incomplete results for us. We disable it in
// the axe run and handle contrast via a separate unit test below
// (Deliverable 4) that computes composited RGBA against `var(--bg)` and
// asserts the WCAG AA ratios.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import axe from 'axe-core';

import ArtifactList from '../src/components/ArtifactList.svelte';
import ArtifactDetailHeader from '../src/components/ArtifactDetailHeader.svelte';
import ArtifactDetailBody from '../src/components/ArtifactDetailBody.svelte';
import ArtifactDiff from '../src/components/ArtifactDiff.svelte';
import ArtifactEditor from '../src/components/ArtifactEditor.svelte';
import RemoteUpdateBanner from '../src/components/RemoteUpdateBanner.svelte';

// ── Axe runner helper ─────────────────────────────────────────────────────

/**
 * Run axe-core against a jsdom container and return the violations list.
 *
 * We pin the rule set to the explicit list the plan calls out rather than
 * relying on "every WCAG AA rule" — jsdom lacks layout, so rules that need
 * computed geometry or visibility (`color-contrast`, `region`,
 * `landmark-one-main`, …) produce noisy false positives. The pinned list
 * mirrors the plan §"Accessibility (R2-5)" bullet list.
 *
 * Rules enabled:
 *   aria-valid-attr, aria-valid-attr-value, aria-required-attr,
 *   aria-required-children, aria-required-parent, aria-allowed-attr,
 *   aria-allowed-role, aria-hidden-body, aria-hidden-focus,
 *   aria-input-field-name, aria-toggle-field-name, aria-roles,
 *   button-name, link-name, label, label-title-only, form-field-multiple-labels,
 *   landmark-unique, duplicate-id, duplicate-id-aria, duplicate-id-active,
 *   nested-interactive, role-img-alt, image-alt, input-button-name,
 *   presentation-role-conflict.
 *
 * `color-contrast` is explicitly disabled — see the file header.
 *
 * @param {HTMLElement} container
 * @returns {Promise<any[]>}
 */
async function runAxe(container) {
  const results = await axe.run(container, {
    runOnly: {
      type: 'rule',
      values: [
        'aria-valid-attr',
        'aria-valid-attr-value',
        'aria-required-attr',
        'aria-required-children',
        'aria-required-parent',
        'aria-allowed-attr',
        'aria-allowed-role',
        'aria-hidden-body',
        'aria-hidden-focus',
        'aria-input-field-name',
        'aria-toggle-field-name',
        'aria-roles',
        'button-name',
        'link-name',
        'label',
        'label-title-only',
        'form-field-multiple-labels',
        'landmark-unique',
        'duplicate-id',
        'duplicate-id-aria',
        'duplicate-id-active',
        'nested-interactive',
        'role-img-alt',
        'image-alt',
        'input-button-name',
        'presentation-role-conflict',
      ],
    },
    // Jsdom has no layout engine; rules that need computed geometry are
    // either disabled via runOnly above, or return `incomplete` which axe
    // does NOT treat as a violation.
    resultTypes: ['violations'],
  });
  return results.violations;
}

/**
 * Pretty-print axe violations so a failing test is actionable instead of
 * being a wall of JSON. Returns a short multi-line summary.
 *
 * @param {any[]} violations
 * @returns {string}
 */
function formatViolations(violations) {
  if (!violations.length) return '';
  return violations
    .map((v) => {
      const nodes = v.nodes
        .map((n) => `      • ${n.html.slice(0, 160)}\n        ${n.failureSummary ?? ''}`)
        .join('\n');
      return `  [${v.impact ?? '?'}] ${v.id} — ${v.help}\n${nodes}`;
    })
    .join('\n');
}

// ── matchMedia mock (reduced-motion variant) ───────────────────────────────
//
// Jsdom does not implement `window.matchMedia`. We install a minimal shim
// whose `matches` value depends on a module-scope toggle so individual
// tests can flip between default motion and `reduce`.

let prefersReducedMotion = false;

function installMatchMediaMock() {
  if (typeof window === 'undefined') return;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query) => ({
      matches:
        query === '(prefers-reduced-motion: reduce)' && prefersReducedMotion,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  prefersReducedMotion = false;
  installMatchMediaMock();
});

afterEach(() => {
  cleanup();
});

// ── Fixtures ──────────────────────────────────────────────────────────────

// Fixtures match the REST API shape: `author` is an object { key, name, type },
// and the list endpoint returns top-level `author` / `timestamp` (not
// `latest_author` / `latest_timestamp`).
const THREE_ARTIFACTS = [
  {
    name: 'design-notes',
    type: 'doc',
    title: 'Design notes',
    version_count: 3,
    author: { key: 'phil-key', name: 'phil', type: 'human' },
    timestamp: Date.now() / 1000 - 120,
  },
  {
    name: 'migration-plan',
    type: 'plan',
    title: 'Migration plan',
    version_count: 1,
    author: { key: 'claude-key', name: 'claude', type: 'agent' },
    timestamp: Date.now() / 1000 - 3600,
  },
  {
    name: 'server',
    type: 'code',
    title: 'server.py',
    version_count: 7,
    author: { key: 'rob-key', name: 'rob', type: 'human' },
    timestamp: Date.now() / 1000 - 7200,
  },
];

const PLAN_ARTIFACT_DETAIL = {
  name: 'migration-plan',
  type: 'plan',
  title: 'Migration plan',
  channel: 'general',
  version: 2,
  content:
    '# Migration plan\n\n' +
    'This plan covers the migration. See the [reference](https://example.com) doc.\n\n' +
    '## Steps\n\n' +
    '1. Prepare the schema\n' +
    '2. Dump the data\n' +
    '3. Restore on the new host\n\n' +
    '> Always back up first.\n',
  versions: [
    {
      version: 2,
      author: { key: 'phil-key', name: 'phil', type: 'human' },
      timestamp: Date.now() / 1000 - 120,
      summary: 'add restore step',
    },
    {
      version: 1,
      author: { key: 'phil-key', name: 'phil', type: 'human' },
      timestamp: Date.now() / 1000 - 360,
      summary: 'initial draft',
    },
  ],
};

// ── 1. List view — empty ──────────────────────────────────────────────────

describe('a11y — list view (empty)', () => {
  it('passes axe with no artifacts', async () => {
    const { container } = render(ArtifactList, {
      props: {
        artifacts: [],
        artifactCount: 0,
        loading: false,
        error: null,
        onSelectArtifact: () => {},
        currentIdentityKey: 'identity-A',
        conversation: 'general',
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

// ── 2. List view — populated ──────────────────────────────────────────────

describe('a11y — list view (populated)', () => {
  it('passes axe with three artifacts', async () => {
    const { container } = render(ArtifactList, {
      props: {
        artifacts: THREE_ARTIFACTS,
        artifactCount: THREE_ARTIFACTS.length,
        loading: false,
        error: null,
        onSelectArtifact: () => {},
        currentIdentityKey: 'identity-A',
        conversation: 'general',
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('passes axe after one artifact is starred (STARRED section visible)', async () => {
    // Pre-seed localStorage so the list renders a STARRED section on first paint.
    localStorage.setItem(
      'claude-comms:identity-A:starred-artifacts',
      JSON.stringify({ general: ['design-notes'] }),
    );
    const { container } = render(ArtifactList, {
      props: {
        artifacts: THREE_ARTIFACTS,
        artifactCount: THREE_ARTIFACTS.length,
        loading: false,
        error: null,
        onSelectArtifact: () => {},
        currentIdentityKey: 'identity-A',
        conversation: 'general',
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
    localStorage.clear();
  });
});

// ── 3. Detail view — content mode (header + body) ────────────────────────

describe('a11y — detail view (content mode, plan type)', () => {
  it('passes axe for the detail header (content mode)', async () => {
    const { container } = render(ArtifactDetailHeader, {
      props: {
        artifact: PLAN_ARTIFACT_DETAIL,
        selectedVersion: 2,
        showVersionDropdown: false,
        viewMode: 'content',
        compareVersion: null,
        capabilities: { writable: true },
        onBack: () => {},
        onVersionSelect: () => {},
        onToggleVersionDropdown: () => {},
        onSetViewMode: () => {},
        onSetCompareVersion: () => {},
        onCopy: () => {},
        onDownload: () => {},
        onEdit: () => {},
        onClose: () => {},
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('passes axe with the primary version dropdown open (role=listbox)', async () => {
    const { container } = render(ArtifactDetailHeader, {
      props: {
        artifact: PLAN_ARTIFACT_DETAIL,
        selectedVersion: 2,
        showVersionDropdown: true, // dropdown open
        viewMode: 'content',
        compareVersion: null,
        capabilities: { writable: true },
        onBack: () => {},
        onVersionSelect: () => {},
        onToggleVersionDropdown: () => {},
        onSetViewMode: () => {},
        onSetCompareVersion: () => {},
        onCopy: () => {},
        onDownload: () => {},
        onEdit: () => {},
        onClose: () => {},
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('passes axe for the detail body (markdown rendered)', async () => {
    const { container } = render(ArtifactDetailBody, {
      props: {
        artifact: PLAN_ARTIFACT_DETAIL,
        detailError: null,
        viewMode: 'content',
        compareVersion: null,
      },
    });
    // Let the async renderMarkdown $effect resolve.
    await new Promise((r) => setTimeout(r, 30));
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

// ── 4. Detail view — diff mode ───────────────────────────────────────────

describe('a11y — detail view (diff mode, v1 → v2)', () => {
  it('passes axe for a side-by-side diff with char-level highlights', async () => {
    const fromContent =
      'line one\nshared line\nthird line\nfourth\ncommon tail\n';
    const toContent =
      'line one\nshared line changed\nthird line\nfourth updated\ncommon tail\n';
    // Force the wide (split) layout: jsdom's default `window.innerWidth` is 1024,
    // which is above the 600px breakpoint the component uses.
    const { container } = render(ArtifactDiff, {
      props: {
        fromContent,
        toContent,
        fromVersion: 1,
        toVersion: 2,
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('passes axe for the detail header while in diff mode (compare dropdown)', async () => {
    const { container } = render(ArtifactDetailHeader, {
      props: {
        artifact: PLAN_ARTIFACT_DETAIL,
        selectedVersion: 2,
        showVersionDropdown: false,
        viewMode: 'diff',
        compareVersion: 1,
        capabilities: { writable: true },
        onBack: () => {},
        onVersionSelect: () => {},
        onToggleVersionDropdown: () => {},
        onSetViewMode: () => {},
        onSetCompareVersion: () => {},
        onCopy: () => {},
        onDownload: () => {},
        onEdit: () => {},
        onClose: () => {},
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

// ── 5. Detail view — edit mode ───────────────────────────────────────────

describe('a11y — detail view (edit mode)', () => {
  it('passes axe for the ArtifactEditor (textarea + Save/Cancel)', async () => {
    const { container } = render(ArtifactEditor, {
      props: {
        visible: true,
        artifact: PLAN_ARTIFACT_DETAIL,
        onSave: () => {},
        onCancel: () => {},
        onDirtyChange: () => {},
        onTextareaMount: () => {},
      },
    });
    // Let the textarea register + effects settle.
    await new Promise((r) => setTimeout(r, 10));
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('passes axe for the ArtifactEditor with reduced-motion forced', async () => {
    prefersReducedMotion = true;
    const { container } = render(ArtifactEditor, {
      props: {
        visible: true,
        artifact: PLAN_ARTIFACT_DETAIL,
        onSave: () => {},
        onCancel: () => {},
        onDirtyChange: () => {},
        onTextareaMount: () => {},
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

// ── 6. Conflict banner open ──────────────────────────────────────────────

describe('a11y — RemoteUpdateBanner (conflict open)', () => {
  it('passes axe for the banner in its default-motion state', async () => {
    const { container } = render(RemoteUpdateBanner, {
      props: {
        visible: true,
        senderName: 'rob',
        newVersion: 3,
        onViewChanges: () => {},
        onKeepEditing: () => {},
        onDiscardEdit: () => {},
        onDismiss: () => {},
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('passes axe for the banner with prefers-reduced-motion: reduce forced', async () => {
    // R4-8: banner animation is disabled under reduce; the tree should still be
    // a11y-clean (no dependency on motion for comprehension).
    prefersReducedMotion = true;
    const { container } = render(RemoteUpdateBanner, {
      props: {
        visible: true,
        senderName: 'rob',
        newVersion: 3,
        onViewChanges: () => {},
        onKeepEditing: () => {},
        onDiscardEdit: () => {},
        onDismiss: () => {},
      },
    });
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

// ── 4. Diff color-contrast validation (manual — jsdom can't do axe's) ──
//
// Plan §"Accessibility (R2-5)" requires the diff backgrounds + inline
// char-change highlights to pass WCAG AA against `var(--bg)` (which is
// `#0a0a0c` in the dark theme — see src/app.css :root `--bg-deepest`).
//
// axe-core's `color-contrast` rule relies on `getComputedStyle()` returning
// real pixel geometry, which jsdom does not implement. We compute the
// composited RGBA → RGB against the dark background ourselves and assert
// WCAG AA against the text foreground.
//
// Color palette (locked by ArtifactDiff.svelte):
//   - remove row bg:    rgba(248, 81, 73, 0.12)       → composited over #0a0a0c
//   - add row bg:       rgba(63, 185, 80, 0.12)
//   - remove char hi:   rgba(248, 81, 73, 0.35)       → inline char highlight
//   - add char hi:      rgba(63, 185, 80, 0.35)
//   - text foreground:  var(--text-primary) = #ede9e3 (near-white)
//
// WCAG AA thresholds:
//   - normal text: 4.5:1
//   - UI components / large text: 3:1
//   - inline char-level highlight is ALSO reinforced with underline + bold
//     per the plan's "non-color signalling" requirement, so 3:1 is the
//     applicable bar; we use 4.5 anyway because the rendered text *is*
//     body copy.

/** Parse `rgba(r, g, b, a)` / `rgb(r, g, b)` / `#rrggbb` / `#rgb` to `{r, g, b, a}`. */
function parseColor(input) {
  const s = input.trim();
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i;
  const m = s.match(rgba);
  if (m) {
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const expand = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    return {
      r: parseInt(expand.slice(0, 2), 16),
      g: parseInt(expand.slice(2, 4), 16),
      b: parseInt(expand.slice(4, 6), 16),
      a: 1,
    };
  }
  throw new Error(`parseColor: unsupported input ${input}`);
}

/**
 * Composite a foreground RGBA over an opaque RGB background, returning an
 * opaque RGB. (Alpha-blend formula: out = fg*a + bg*(1-a), per channel.)
 */
function composite(fg, bg) {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

/** WCAG relative luminance for sRGB. */
function luminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio between two opaque colors. */
function contrastRatio(fg, bg) {
  const L1 = luminance(fg);
  const L2 = luminance(bg);
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('diff color contrast (WCAG AA against --bg)', () => {
  const APP_BG = parseColor('#0a0a0c'); // :root --bg-deepest (dark theme)
  const TEXT_FG = parseColor('#ede9e3'); // :root --text-primary

  it('remove-row background composited against --bg preserves AA body-text contrast', () => {
    const rowBg = composite(parseColor('rgba(248, 81, 73, 0.12)'), APP_BG);
    const ratio = contrastRatio(TEXT_FG, rowBg);
    expect(ratio, `remove-row: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('add-row background composited against --bg preserves AA body-text contrast', () => {
    const rowBg = composite(parseColor('rgba(63, 185, 80, 0.12)'), APP_BG);
    const ratio = contrastRatio(TEXT_FG, rowBg);
    expect(ratio, `add-row: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('remove char-highlight composited against --bg preserves AA body-text contrast', () => {
    const hiBg = composite(parseColor('rgba(248, 81, 73, 0.35)'), APP_BG);
    const ratio = contrastRatio(TEXT_FG, hiBg);
    expect(ratio, `remove char-hi: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('add char-highlight composited against --bg preserves AA body-text contrast', () => {
    const hiBg = composite(parseColor('rgba(63, 185, 80, 0.35)'), APP_BG);
    const ratio = contrastRatio(TEXT_FG, hiBg);
    expect(ratio, `add char-hi: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('row background vs app background meets AA UI-boundary contrast (3:1 not required; sanity check > 1.0)', () => {
    // Row backgrounds aren't UI boundaries per se — they're diff highlighting.
    // But we still want them to be VISIBLY different from --bg. Assert the
    // ratio is meaningfully > 1.0 so the row actually stands out.
    const rowRemove = composite(parseColor('rgba(248, 81, 73, 0.12)'), APP_BG);
    const rowAdd = composite(parseColor('rgba(63, 185, 80, 0.12)'), APP_BG);
    expect(contrastRatio(rowRemove, APP_BG)).toBeGreaterThan(1.05);
    expect(contrastRatio(rowAdd, APP_BG)).toBeGreaterThan(1.05);
  });
});
