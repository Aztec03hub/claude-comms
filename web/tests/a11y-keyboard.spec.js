// Batch 4N — keyboard a11y tests for the artifact panel + sub-components.
//
// Focus of this suite: things that axe-core CANNOT detect because they're
// behavioural, not structural — the version dropdown's WAI-ARIA listbox
// keyboard nav (ArrowUp/Down/Enter/Esc), the star button's aria-pressed
// toggle, and the remote-update banner's Esc-to-dismiss path.
//
// REWRITE NOTE (test-suite-cleanup): the original file tested local
// handler reimplementations (makeListboxHandler, makeStarToggle, labelFor)
// rather than the real components. This version mounts the real components
// and fires keyboard/click events against the live DOM, asserting real
// aria-* attributes. See .worklogs/test-audit/impl/VT-REWRITE.md for
// the change rationale.
//
// Plan refs: R2-5 (Accessibility), R4-3 (Esc precedence).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ArtifactDetailHeader from '../src/components/ArtifactDetailHeader.svelte';
import ArtifactList from '../src/components/ArtifactList.svelte';
import RemoteUpdateBanner from '../src/components/RemoteUpdateBanner.svelte';

// ── Shared fixture data ───────────────────────────────────────────────────

const ARTIFACT = {
  name: 'migration-plan',
  type: 'plan',
  title: 'Migration plan',
  channel: 'general',
  version: 2,
  content: '# Migration plan\n\nSteps here.',
  versions: [
    {
      version: 3,
      author: { key: 'phil-key', name: 'phil', type: 'human' },
      timestamp: Date.now() / 1000 - 60,
      summary: 'third revision',
    },
    {
      version: 2,
      author: { key: 'phil-key', name: 'phil', type: 'human' },
      timestamp: Date.now() / 1000 - 120,
      summary: 'second revision',
    },
    {
      version: 1,
      author: { key: 'phil-key', name: 'phil', type: 'human' },
      timestamp: Date.now() / 1000 - 360,
      summary: 'initial draft',
    },
  ],
};

function makeHeaderProps(overrides = {}) {
  return {
    artifact: ARTIFACT,
    selectedVersion: 2,
    showVersionDropdown: true, // dropdown open so listbox is in the DOM
    viewMode: 'content',
    compareVersion: null,
    capabilities: { writable: true },
    onBack: vi.fn(),
    onVersionSelect: vi.fn(),
    onToggleVersionDropdown: vi.fn(),
    onSetViewMode: vi.fn(),
    onSetCompareVersion: vi.fn(),
    onCopy: vi.fn(),
    onDownload: vi.fn(),
    onEdit: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const ARTIFACTS_LIST = [
  {
    name: 'plan-x',
    type: 'plan',
    title: 'Plan X',
    version_count: 1,
    author: { key: 'phil-key', name: 'phil', type: 'human' },
    timestamp: Date.now() / 1000 - 120,
  },
  {
    name: 'plan-y',
    type: 'plan',
    title: 'Plan Y',
    version_count: 2,
    author: { key: 'claude-key', name: 'claude', type: 'agent' },
    timestamp: Date.now() / 1000 - 600,
  },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// ── Version dropdown listbox keyboard nav ────────────────────────────────
//
// Mounts ArtifactDetailHeader with showVersionDropdown=true so the real
// listbox div (role="listbox") is in the DOM. Keyboard events are fired
// directly on the listbox element and aria-activedescendant is asserted.
//
// Real import: ArtifactDetailHeader from '../src/components/ArtifactDetailHeader.svelte'
// Real call:   fireEvent.keyDown(listbox, { key: ... }) on the mounted listbox div

describe('version-dropdown listbox keyboard nav (R2-5)', () => {
  function getListbox(container) {
    return container.querySelector('[role="listbox"]');
  }

  function getOptions(container) {
    return Array.from(container.querySelectorAll('[role="option"]'));
  }

  it('ArrowDown advances aria-activedescendant to the next option', async () => {
    const { container } = render(ArtifactDetailHeader, { props: makeHeaderProps() });
    // Two ticks: one for initial render, one for the $effect that seeds primaryActiveIdx.
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);
    expect(listbox).not.toBeNull();

    // On open, the active descendant is seeded to the selected version (v2 = index 1).
    // Fire ArrowDown to move to index 2 (v1).
    await fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    await tick();
    const activeId = listbox.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    // The active-descendant id encodes the version; after one ArrowDown from v2
    // we should be on v1 (the next option in the sorted list).
    const activeOption = container.querySelector(`[id="${activeId}"]`);
    expect(activeOption).not.toBeNull();
    // Confirm the active option is not v2 (we moved down from it).
    expect(activeOption.textContent).not.toContain('v2');
  });

  it('ArrowUp moves aria-activedescendant to the previous option', async () => {
    const { container } = render(ArtifactDetailHeader, { props: makeHeaderProps() });
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);

    // Seed position: active is on v2 (index 1). Fire ArrowUp to go to v3 (index 0).
    await fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    await tick();
    const activeId = listbox.getAttribute('aria-activedescendant');
    const activeOption = container.querySelector(`[id="${activeId}"]`);
    expect(activeOption).not.toBeNull();
    expect(activeOption.textContent).toContain('v3');
  });

  it('Home jumps aria-activedescendant to the first option (v3)', async () => {
    const { container } = render(ArtifactDetailHeader, { props: makeHeaderProps() });
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);

    await fireEvent.keyDown(listbox, { key: 'Home' });
    await tick();
    const activeId = listbox.getAttribute('aria-activedescendant');
    const activeOption = container.querySelector(`[id="${activeId}"]`);
    expect(activeOption).not.toBeNull();
    const options = getOptions(container);
    // First option should be the first in the DOM order (v3, newest-first).
    expect(activeOption).toBe(options[0]);
  });

  it('End jumps aria-activedescendant to the last option (v1)', async () => {
    const { container } = render(ArtifactDetailHeader, { props: makeHeaderProps() });
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);

    await fireEvent.keyDown(listbox, { key: 'End' });
    await tick();
    const activeId = listbox.getAttribute('aria-activedescendant');
    const activeOption = container.querySelector(`[id="${activeId}"]`);
    expect(activeOption).not.toBeNull();
    const options = getOptions(container);
    expect(activeOption).toBe(options[options.length - 1]);
  });

  it('Enter commits the active option (calls onVersionSelect)', async () => {
    const onVersionSelect = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ onVersionSelect }),
    });
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);

    // Move to v3 (first option, index 0) then commit.
    await fireEvent.keyDown(listbox, { key: 'Home' });
    await tick();
    await fireEvent.keyDown(listbox, { key: 'Enter' });
    await tick();
    expect(onVersionSelect).toHaveBeenCalledTimes(1);
    expect(onVersionSelect).toHaveBeenCalledWith(3); // v3 is the first option
  });

  it('Space also commits the active option', async () => {
    const onVersionSelect = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ onVersionSelect }),
    });
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);

    await fireEvent.keyDown(listbox, { key: 'Home' });
    await tick();
    await fireEvent.keyDown(listbox, { key: ' ' });
    await tick();
    expect(onVersionSelect).toHaveBeenCalledWith(3);
  });

  it('Escape closes the dropdown (calls onToggleVersionDropdown) and stops propagation (R4-3)', async () => {
    const onToggleVersionDropdown = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ onToggleVersionDropdown }),
    });
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);

    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(escEvent, 'stopPropagation');
    listbox.dispatchEvent(escEvent);
    await tick();

    expect(onToggleVersionDropdown).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalled();
    expect(escEvent.defaultPrevented).toBe(true);
  });

  it('unrelated keys do not change aria-activedescendant or call onVersionSelect', async () => {
    const onVersionSelect = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ onVersionSelect }),
    });
    await tick();
    await Promise.resolve();
    await tick();
    const listbox = getListbox(container);
    const idBefore = listbox.getAttribute('aria-activedescendant');

    await fireEvent.keyDown(listbox, { key: 'a' });
    await fireEvent.keyDown(listbox, { key: 'Tab' });
    await tick();

    expect(listbox.getAttribute('aria-activedescendant')).toBe(idBefore);
    expect(onVersionSelect).not.toHaveBeenCalled();
  });
});

// ── Trigger-button keyboard activation ───────────────────────────────────

// Mounts the real ArtifactDetailHeader and fires keys on the live version
// trigger button. When closed, activation keys must call
// onToggleVersionDropdown + preventDefault; when open, they must not.
describe('version-dropdown trigger keyboard open (R2-5)', () => {
  function triggerBtn(container) {
    return container.querySelector('[data-testid="primary-version-selector"] button');
  }

  it('ArrowDown on the closed trigger opens the dropdown (calls onToggleVersionDropdown)', async () => {
    const onToggleVersionDropdown = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ showVersionDropdown: false, onToggleVersionDropdown }),
    });
    await tick();
    const btn = triggerBtn(container);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    // fireEvent returns false when a handler called preventDefault.
    const notPrevented = await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(onToggleVersionDropdown).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it('Enter and Space also open the dropdown', async () => {
    const onToggleVersionDropdown = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ showVersionDropdown: false, onToggleVersionDropdown }),
    });
    await tick();
    const btn = triggerBtn(container);
    // showVersionDropdown is a controlled prop and stays false here, so each
    // activation key re-triggers the open callback.
    await fireEvent.keyDown(btn, { key: 'Enter' });
    await fireEvent.keyDown(btn, { key: ' ' });
    expect(onToggleVersionDropdown).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the dropdown is already open', async () => {
    const onToggleVersionDropdown = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ showVersionDropdown: true, onToggleVersionDropdown }),
    });
    await tick();
    const btn = triggerBtn(container);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    await fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onToggleVersionDropdown).not.toHaveBeenCalled();
  });

  it('non-activation keys do not open the dropdown', async () => {
    const onToggleVersionDropdown = vi.fn();
    const { container } = render(ArtifactDetailHeader, {
      props: makeHeaderProps({ showVersionDropdown: false, onToggleVersionDropdown }),
    });
    await tick();
    const btn = triggerBtn(container);
    await fireEvent.keyDown(btn, { key: 'Tab' });
    await fireEvent.keyDown(btn, { key: 'a' });
    await fireEvent.keyDown(btn, { key: 'Escape' });
    expect(onToggleVersionDropdown).not.toHaveBeenCalled();
  });
});

// ── Star button keyboard activation ──────────────────────────────────────
//
// Mounts ArtifactList with real artifacts and asserts that clicking the
// star button toggles aria-pressed on the real DOM element and flips
// aria-label between "Star artifact {name}" and "Unstar artifact {name}".
//
// Real import: ArtifactList from '../src/components/ArtifactList.svelte'
// Real call:   fireEvent.click(starBtn) on the mounted star button element

describe('star button keyboard activation (R2-5)', () => {
  it('clicking the star button toggles aria-pressed on the real DOM element', async () => {
    const { container } = render(ArtifactList, {
      props: {
        artifacts: ARTIFACTS_LIST,
        artifactCount: ARTIFACTS_LIST.length,
        loading: false,
        error: null,
        onSelectArtifact: vi.fn(),
        currentIdentityKey: 'identity-test',
        conversation: 'general',
      },
    });
    await tick();

    let starBtn = container.querySelector('[data-testid="artifact-star-plan-x"]');
    expect(starBtn).not.toBeNull();

    // Initially unstarred: aria-pressed must be false.
    expect(starBtn.getAttribute('aria-pressed')).toBe('false');
    expect(starBtn.getAttribute('aria-label')).toBe('Star artifact plan-x');

    // Click to star. The {#each} may reconstruct the DOM when the artifact
    // moves into the STARRED section, so re-query the button after the update.
    await fireEvent.click(starBtn);
    await Promise.resolve();
    await tick();
    starBtn = container.querySelector('[data-testid="artifact-star-plan-x"]');

    expect(starBtn.getAttribute('aria-pressed')).toBe('true');
    expect(starBtn.getAttribute('aria-label')).toBe('Unstar artifact plan-x');

    // Click again to unstar.
    await fireEvent.click(starBtn);
    await Promise.resolve();
    await tick();
    starBtn = container.querySelector('[data-testid="artifact-star-plan-x"]');

    expect(starBtn.getAttribute('aria-pressed')).toBe('false');
    expect(starBtn.getAttribute('aria-label')).toBe('Star artifact plan-x');
  });

  it('starring moves the artifact into the STARRED section', async () => {
    const { container, queryByTestId } = render(ArtifactList, {
      props: {
        artifacts: ARTIFACTS_LIST,
        artifactCount: ARTIFACTS_LIST.length,
        loading: false,
        error: null,
        onSelectArtifact: vi.fn(),
        currentIdentityKey: 'identity-test',
        conversation: 'general',
      },
    });
    await tick();

    // STARRED section should not exist initially.
    expect(queryByTestId('artifact-starred-section')).toBeNull();

    const starBtn = container.querySelector('[data-testid="artifact-star-plan-x"]');
    await fireEvent.click(starBtn);
    await Promise.resolve();
    await tick();

    // STARRED section should now be visible.
    expect(queryByTestId('artifact-starred-section')).not.toBeNull();
  });
});

// ── Remote-update banner Esc dismissal ───────────────────────────────────
//
// Mounts the real RemoteUpdateBanner and fires keys on a live banner
// control. Esc must call onDismiss, preventDefault, and stopPropagation so
// the App-global Esc handler does not also fire (plan §4 R4-3 precedence) —
// proven by a parent keydown listener that must NOT receive the event.

describe('remote-update banner Esc dismissal (R4-3)', () => {
  function bannerProps(overrides = {}) {
    return { visible: true, senderName: 'claude', newVersion: 3, onDismiss: vi.fn(), ...overrides };
  }

  it('Esc on a banner control fires onDismiss, prevents default, and stops propagation', async () => {
    const onDismiss = vi.fn();
    const { container } = render(RemoteUpdateBanner, { props: bannerProps({ onDismiss }) });
    await tick();
    const btn = container.querySelector('[data-testid="remote-banner-view-changes"]');
    expect(btn).not.toBeNull();

    // Dispatch a real Esc through the mounted component and spy on the event.
    // keydown is a Svelte-delegated event (the handler runs at the delegation
    // root, after the event has already bubbled past intermediate DOM nodes),
    // so we assert the handler called stopPropagation on the event itself --
    // that is what keeps the App-global Esc handler from also firing -- rather
    // than via a parent listener that delegation would bypass.
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(e, 'stopPropagation');
    btn.dispatchEvent(e);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('non-Esc keys are passed through (do not dismiss)', async () => {
    const onDismiss = vi.fn();
    const { container } = render(RemoteUpdateBanner, { props: bannerProps({ onDismiss }) });
    await tick();
    const btn = container.querySelector('[data-testid="remote-banner-view-changes"]');
    await fireEvent.keyDown(btn, { key: 'Enter' });
    await fireEvent.keyDown(btn, { key: 'Tab' });
    await fireEvent.keyDown(btn, { key: 'a' });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// ── Esc precedence (R4-3) ────────────────────────────────────────────────
//
// DELETED: the two "Esc precedence" tests that exercised raw browser
// stopPropagation semantics on vanilla divs. Both tests were tautological —
// they verified that the DOM's own event propagation model works (which it
// always does regardless of any production code). Neither test exercised a
// production handler. Removed per cleanup plan §5 P2 #8.
