// Author-rendering regression tests.
//
// Background: the REST API returns `author` as an object `{ key, name, type }`
// (both at the list-endpoint level and per-version on the detail endpoint).
// Several call sites in the artifact panel previously rendered it as
// `{v.author ?? 'unknown'}` which stringifies an object as `[object Object]`.
//
// These tests mount the affected components with the real API shape and
// assert that:
//   1. No rendered text contains the literal `[object Object]` substring.
//   2. The author's `name` is surfaced for the user to read.
// They are the fast, defensive guardrail — the a11y suite exercises the same
// components with the same shape, but this spec makes the contract explicit
// so a future regression fails here with a clear, focused error message.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import ArtifactList from '../src/components/ArtifactList.svelte';
import ArtifactDetailHeader from '../src/components/ArtifactDetailHeader.svelte';

// ── Fixtures ─────────────────────────────────────────────────────────────

/** API-shaped artifact summary: list endpoint returns `author` + `timestamp`. */
const LIST_ARTIFACT = {
  name: 'design-notes',
  type: 'doc',
  title: 'Design notes',
  version_count: 3,
  author: { key: 'phil-key', name: 'phil', type: 'human' },
  timestamp: Date.now() / 1000 - 120,
  summary: 'initial draft',
};

/** API-shaped artifact detail: versions[].author is an object. */
const DETAIL_ARTIFACT = {
  name: 'migration-plan',
  type: 'plan',
  title: 'Migration plan',
  channel: 'general',
  version: 2,
  content: '# Migration plan\n\nContent.\n',
  versions: [
    {
      version: 2,
      author: { key: 'phil-key', name: 'phil', type: 'human' },
      timestamp: Date.now() / 1000 - 120,
      summary: 'add restore step',
    },
    {
      version: 1,
      author: { key: 'claude-key', name: 'claude', type: 'agent' },
      timestamp: Date.now() / 1000 - 360,
      summary: 'initial draft',
    },
  ],
};

afterEach(() => {
  cleanup();
});

describe('author rendering — object shape must not stringify to [object Object]', () => {
  it('ArtifactList renders author.name instead of the whole author object', () => {
    const { container } = render(ArtifactList, {
      props: {
        artifacts: [LIST_ARTIFACT],
        artifactCount: 1,
        loading: false,
        error: null,
        onSelectArtifact: () => {},
        currentIdentityKey: 'identity-A',
        conversation: 'general',
      },
    });
    const html = container.innerHTML;
    expect(html).not.toContain('[object Object]');
    // The author's name is surfaced.
    expect(html).toContain('phil');
  });

  it('ArtifactDetailHeader renders activeVersionEntry.author.name in the primary dropdown trigger', () => {
    const { container } = render(ArtifactDetailHeader, {
      props: {
        artifact: DETAIL_ARTIFACT,
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
    const html = container.innerHTML;
    expect(html).not.toContain('[object Object]');
    // The selected version's author name shows in the button label.
    expect(html).toContain('phil');
  });

  it('ArtifactDetailHeader — open primary dropdown: every row shows author.name', () => {
    const { container } = render(ArtifactDetailHeader, {
      props: {
        artifact: DETAIL_ARTIFACT,
        selectedVersion: 2,
        showVersionDropdown: true, // open the dropdown so list rows render
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
    const html = container.innerHTML;
    expect(html).not.toContain('[object Object]');
    // Both version authors should be surfaced by name.
    expect(html).toContain('phil');
    expect(html).toContain('claude');
  });

  it('ArtifactDetailHeader — diff mode, compare dropdown open: author.name still surfaces', () => {
    const { container } = render(ArtifactDetailHeader, {
      props: {
        artifact: DETAIL_ARTIFACT,
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
    const html = container.innerHTML;
    expect(html).not.toContain('[object Object]');
  });

  it('falls back to "unknown" gracefully when author is missing entirely', () => {
    // Defensive: a malformed server response where a version entry omits
    // `author` must render the text "unknown" rather than a crash or an
    // object-stringified blob.
    const noAuthor = {
      ...DETAIL_ARTIFACT,
      versions: [
        {
          version: 2,
          timestamp: Date.now() / 1000 - 120,
          summary: 'no author',
        },
      ],
      version: 2,
    };
    const { container } = render(ArtifactDetailHeader, {
      props: {
        artifact: noAuthor,
        selectedVersion: 2,
        showVersionDropdown: true,
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
    const html = container.innerHTML;
    expect(html).not.toContain('[object Object]');
    expect(html).toContain('unknown');
  });
});
