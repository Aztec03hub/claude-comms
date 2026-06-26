// ArtifactDetailHeader — Compare dropdown outside-click close (#55 follow-up).
//
// The primary version dropdown's open state lives in ArtifactPanel, which
// already closes it on an outside mousedown. The "Compare:" (diff "from")
// dropdown's open state is local to ArtifactDetailHeader, so it needs its
// own <svelte:window onmousedown> guard — mirroring the panel's pattern.
// Before this fix the Compare dropdown could only be closed by re-clicking
// the trigger or making a selection; a click anywhere else left it open.
//
// These tests pin:
//   1. A mousedown OUTSIDE the compare selector subtree closes the dropdown.
//   2. A mousedown INSIDE the compare selector subtree keeps it open.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import ArtifactDetailHeader from '../src/components/ArtifactDetailHeader.svelte';

const DETAIL_ARTIFACT = {
  name: 'migration-plan',
  type: 'plan',
  title: 'Migration plan',
  channel: 'general',
  version: 2,
  content: '# Migration plan\n',
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

function renderHeader() {
  return render(ArtifactDetailHeader, {
    props: {
      artifact: DETAIL_ARTIFACT,
      selectedVersion: 2,
      showVersionDropdown: false,
      // Diff mode + multiple versions → the Compare selector renders.
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
}

afterEach(() => {
  cleanup();
});

describe('ArtifactDetailHeader — Compare dropdown outside-click', () => {
  it('closes the Compare dropdown on a mousedown outside the selector', async () => {
    const { container } = renderHeader();

    const selector = container.querySelector('[data-testid="compare-version-selector"]');
    expect(selector).not.toBeNull();

    // Open the Compare dropdown via its trigger button.
    const trigger = selector.querySelector('.artifact-version-btn');
    await fireEvent.click(trigger);
    expect(selector.querySelector('.artifact-version-dropdown')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    // Mousedown OUTSIDE the selector subtree (on the document body) closes it.
    await fireEvent.mouseDown(document.body);
    expect(selector.querySelector('.artifact-version-dropdown')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the Compare dropdown open on a mousedown inside the selector', async () => {
    const { container } = renderHeader();

    const selector = container.querySelector('[data-testid="compare-version-selector"]');
    const trigger = selector.querySelector('.artifact-version-btn');
    await fireEvent.click(trigger);
    const dropdown = selector.querySelector('.artifact-version-dropdown');
    expect(dropdown).not.toBeNull();

    // Mousedown INSIDE the selector subtree (the open listbox) must NOT close it.
    await fireEvent.mouseDown(dropdown);
    expect(selector.querySelector('.artifact-version-dropdown')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });
});
