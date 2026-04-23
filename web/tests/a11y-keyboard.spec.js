// Batch 4N — keyboard a11y tests for the artifact panel + sub-components.
//
// Focus of this suite: things that axe-core CANNOT detect because they're
// behavioural, not structural — the version dropdown's WAI-ARIA listbox
// keyboard nav (ArrowUp/Down/Enter/Esc), the star button's space/enter
// activation, and the remote-update banner's Esc-to-dismiss path.
//
// We exercise the handlers directly (mirroring the shapes used in the
// component) rather than mounting full Svelte trees — this keeps the
// suite fast and deterministic, and matches the established pattern in
// edit-flow.spec.js and detail-view.spec.js.
//
// Plan refs: R2-5 (Accessibility), R4-3 (Esc precedence).

import { describe, it, expect, vi } from 'vitest';

// ── Version dropdown listbox keyboard nav ────────────────────────────────

describe('version-dropdown listbox keyboard nav (R2-5)', () => {
  // Mirror the `handleListboxKeydown` shape from ArtifactDetailHeader.svelte.
  // If the component drifts from this shape, the spec should be updated in
  // lockstep — same convention as edit-flow.spec.js.
  function makeListboxHandler({ options, getActiveIdx, setActiveIdx, commit, close }) {
    return (e) => {
      if (options.length === 0) return;
      const activeIdx = getActiveIdx();
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = activeIdx < 0 ? 0 : Math.min(options.length - 1, activeIdx + 1);
          setActiveIdx(next);
          return;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const next = activeIdx < 0 ? options.length - 1 : Math.max(0, activeIdx - 1);
          setActiveIdx(next);
          return;
        }
        case 'Home': {
          e.preventDefault();
          setActiveIdx(0);
          return;
        }
        case 'End': {
          e.preventDefault();
          setActiveIdx(options.length - 1);
          return;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (activeIdx >= 0 && activeIdx < options.length) {
            commit(options[activeIdx].version);
          }
          return;
        }
        case 'Escape': {
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
      }
    };
  }

  function makeEvent(key) {
    return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  }

  function makeOptions() {
    // Newest-first, matching the server's sort order.
    return [
      { version: 3 },
      { version: 2 },
      { version: 1 },
    ];
  }

  it('ArrowDown advances the active descendant by one', () => {
    let idx = 0;
    const setActiveIdx = vi.fn((i) => { idx = i; });
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx,
      commit: vi.fn(),
      close: vi.fn(),
    });
    handler(makeEvent('ArrowDown'));
    expect(setActiveIdx).toHaveBeenCalledWith(1);
    expect(idx).toBe(1);
  });

  it('ArrowDown clamps at the last option', () => {
    let idx = 2; // Last entry of a 3-item list.
    const setActiveIdx = vi.fn((i) => { idx = i; });
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx,
      commit: vi.fn(),
      close: vi.fn(),
    });
    handler(makeEvent('ArrowDown'));
    expect(idx).toBe(2);
  });

  it('ArrowUp from -1 wraps to the last option (so the listbox is immediately useful)', () => {
    let idx = -1;
    const setActiveIdx = vi.fn((i) => { idx = i; });
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx,
      commit: vi.fn(),
      close: vi.fn(),
    });
    handler(makeEvent('ArrowUp'));
    expect(idx).toBe(2);
  });

  it('ArrowUp clamps at index 0', () => {
    let idx = 0;
    const setActiveIdx = vi.fn((i) => { idx = i; });
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx,
      commit: vi.fn(),
      close: vi.fn(),
    });
    handler(makeEvent('ArrowUp'));
    expect(idx).toBe(0);
  });

  it('Home jumps to the first option, End jumps to the last', () => {
    let idx = 1;
    const setActiveIdx = vi.fn((i) => { idx = i; });
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx,
      commit: vi.fn(),
      close: vi.fn(),
    });
    handler(makeEvent('Home'));
    expect(idx).toBe(0);
    handler(makeEvent('End'));
    expect(idx).toBe(2);
  });

  it('Enter commits the active descendant', () => {
    let idx = 1;
    const commit = vi.fn();
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx: () => {},
      commit,
      close: vi.fn(),
    });
    handler(makeEvent('Enter'));
    expect(commit).toHaveBeenCalledWith(2); // option[1].version === 2
  });

  it('Space also commits the active descendant', () => {
    let idx = 0;
    const commit = vi.fn();
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx: () => {},
      commit,
      close: vi.fn(),
    });
    handler(makeEvent(' '));
    expect(commit).toHaveBeenCalledWith(3); // option[0].version === 3
  });

  it('Enter with no active descendant (idx === -1) is a no-op', () => {
    let idx = -1;
    const commit = vi.fn();
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => idx,
      setActiveIdx: () => {},
      commit,
      close: vi.fn(),
    });
    handler(makeEvent('Enter'));
    expect(commit).not.toHaveBeenCalled();
  });

  it('Escape closes the listbox and stops propagation (R4-3 precedence)', () => {
    const close = vi.fn();
    const commit = vi.fn();
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => 1,
      setActiveIdx: () => {},
      commit,
      close,
    });
    const e = makeEvent('Escape');
    const stopSpy = vi.spyOn(e, 'stopPropagation');
    handler(e);
    expect(close).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('unrelated keys are ignored', () => {
    const setActiveIdx = vi.fn();
    const commit = vi.fn();
    const close = vi.fn();
    const handler = makeListboxHandler({
      options: makeOptions(),
      getActiveIdx: () => 0,
      setActiveIdx,
      commit,
      close,
    });
    handler(makeEvent('a'));
    handler(makeEvent('Tab'));
    handler(makeEvent('Shift'));
    expect(setActiveIdx).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('keys are no-ops when there are zero options', () => {
    const setActiveIdx = vi.fn();
    const commit = vi.fn();
    const close = vi.fn();
    const handler = makeListboxHandler({
      options: [],
      getActiveIdx: () => -1,
      setActiveIdx,
      commit,
      close,
    });
    handler(makeEvent('ArrowDown'));
    handler(makeEvent('Enter'));
    handler(makeEvent('Escape'));
    expect(setActiveIdx).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

// ── Trigger-button keyboard activation ───────────────────────────────────

describe('version-dropdown trigger keyboard open (R2-5)', () => {
  // Mirrors `handleTriggerKeydown` from ArtifactDetailHeader.svelte.
  function makeTriggerHandler({ openFn, getIsOpen }) {
    return (e) => {
      if (getIsOpen()) return;
      if (
        e.key === 'ArrowDown'
        || e.key === 'ArrowUp'
        || e.key === 'Enter'
        || e.key === ' '
      ) {
        e.preventDefault();
        openFn();
      }
    };
  }

  function makeEvent(key) {
    return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  }

  it('ArrowDown opens the listbox when closed', () => {
    let isOpen = false;
    const openFn = vi.fn(() => { isOpen = true; });
    const handler = makeTriggerHandler({ openFn, getIsOpen: () => isOpen });
    const e = makeEvent('ArrowDown');
    handler(e);
    expect(openFn).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Enter and Space also open the listbox', () => {
    let isOpen = false;
    const openFn = vi.fn(() => { isOpen = true; });
    const handler = makeTriggerHandler({ openFn, getIsOpen: () => isOpen });
    handler(makeEvent('Enter'));
    expect(openFn).toHaveBeenCalledTimes(1);
    isOpen = false;
    handler(makeEvent(' '));
    expect(openFn).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the listbox is already open', () => {
    const openFn = vi.fn();
    const handler = makeTriggerHandler({ openFn, getIsOpen: () => true });
    handler(makeEvent('ArrowDown'));
    handler(makeEvent('Enter'));
    expect(openFn).not.toHaveBeenCalled();
  });

  it('non-activation keys do not open the listbox', () => {
    const openFn = vi.fn();
    const handler = makeTriggerHandler({ openFn, getIsOpen: () => false });
    handler(makeEvent('Tab'));
    handler(makeEvent('a'));
    handler(makeEvent('Escape'));
    expect(openFn).not.toHaveBeenCalled();
  });
});

// ── Star button keyboard activation ──────────────────────────────────────

describe('star button keyboard activation (R2-5)', () => {
  // Star buttons are <button type="button"> — native browsers fire `click`
  // on Space/Enter automatically. The component's contract is the
  // `aria-pressed` toggle, so we exercise the toggle helper directly.
  //
  // Mirrors the toggle logic in ArtifactList.svelte > handleStarClick.
  function makeStarToggle(initial) {
    let starred = initial;
    return {
      get pressed() { return starred; },
      toggle() { starred = !starred; return starred; },
    };
  }

  it('toggling flips the aria-pressed state', () => {
    const star = makeStarToggle(false);
    expect(star.pressed).toBe(false);
    star.toggle();
    expect(star.pressed).toBe(true);
    star.toggle();
    expect(star.pressed).toBe(false);
  });

  it('renders a dynamic aria-label that flips with state', () => {
    function labelFor(starred, name) {
      return starred
        ? `Unstar artifact ${name}`
        : `Star artifact ${name}`;
    }
    expect(labelFor(false, 'plan-x')).toBe('Star artifact plan-x');
    expect(labelFor(true, 'plan-x')).toBe('Unstar artifact plan-x');
  });
});

// ── Remote-update banner Esc dismissal ───────────────────────────────────

describe('remote-update banner Esc dismissal (R4-3)', () => {
  // Mirrors `handleInteractiveKeydown` in RemoteUpdateBanner.svelte. Esc
  // anywhere inside the banner dismisses it AND stops propagation so the
  // App-global Esc handler does not fire.
  function makeBannerKeydownHandler(onDismiss) {
    return (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onDismiss?.();
      }
    };
  }

  function makeEvent(key) {
    return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  }

  it('Esc fires onDismiss and stops propagation', () => {
    const onDismiss = vi.fn();
    const handler = makeBannerKeydownHandler(onDismiss);
    const e = makeEvent('Escape');
    const stopSpy = vi.spyOn(e, 'stopPropagation');
    handler(e);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('non-Esc keys are passed through (do not dismiss)', () => {
    const onDismiss = vi.fn();
    const handler = makeBannerKeydownHandler(onDismiss);
    handler(makeEvent('Enter'));
    handler(makeEvent('Tab'));
    handler(makeEvent('a'));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

// ── Esc precedence (R4-3) ────────────────────────────────────────────────

describe('Esc precedence — only one layer handles each press (R4-3)', () => {
  // The plan defines a 5-layer precedence chain; each handler that responds
  // calls `event.stopPropagation()`. We simulate the chain by attaching
  // listeners in capture order and asserting that the inner-most one wins.
  it('inner-layer stopPropagation prevents outer-layer handler from firing', () => {
    const inner = vi.fn((e) => { e.stopPropagation(); });
    const outer = vi.fn();

    const innerEl = document.createElement('div');
    const outerEl = document.createElement('div');
    outerEl.appendChild(innerEl);
    document.body.appendChild(outerEl);

    innerEl.addEventListener('keydown', inner);
    outerEl.addEventListener('keydown', outer);

    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    innerEl.dispatchEvent(e);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    outerEl.remove();
  });

  it('without stopPropagation, both layers fire — confirms our handlers MUST stop it', () => {
    // Sanity-check the inverse so the test above isn't a tautology.
    const inner = vi.fn(); // No stopPropagation.
    const outer = vi.fn();

    const innerEl = document.createElement('div');
    const outerEl = document.createElement('div');
    outerEl.appendChild(innerEl);
    document.body.appendChild(outerEl);

    innerEl.addEventListener('keydown', inner);
    outerEl.addEventListener('keydown', outer);

    innerEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledTimes(1);

    outerEl.remove();
  });
});
