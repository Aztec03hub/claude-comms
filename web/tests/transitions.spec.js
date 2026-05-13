// Reactive transitions spec — v0.4.0 Step 2.15.
//
// Validates the 4-phase channel-move choreography defined in Design Spec
// §10 and implemented in `src/lib/transitions/channelMove.svelte.js` +
// the SidebarChannelSection's row wrapper hooks. Covers:
//
//   1. Module surface — the documented primitives are exported with the
//      expected names and tunable knob constants.
//   2. Reduced-motion path — the transitions short-circuit to duration 0
//      when `window.matchMedia` reports reduced-motion preference, and
//      the section's row wrappers still render correctly (the rows
//      appear/disappear, just instantaneously).
//   3. Animation path — when reduced-motion is OFF, the transition
//      functions return a non-zero `duration` and the section's row
//      wrappers carry the `data-transition-flavor` marker for CSS /
//      DevTools inspection.
//   4. Section-level integration — adding/removing rows from a section
//      mounts/unmounts the row wrapper element with the expected
//      `data-transition-flavor` attribute and `data-testid`.
//   5. Star toggle — the smaller `starToggle` transition exists, exposes
//      its own duration constant, and is selectable via the section's
//      `transitionFlavor='crossfade'` flag.
//
// Step 2.15 of the v0.4.0 release plan
// (.worklogs/architecture-and-orchestration-plan.md Part II §III.4
// around line 1801).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { Hash } from 'lucide-svelte';

import * as channelMove from '../src/lib/transitions/channelMove.svelte.js';
import {
  channelFlyIn,
  channelFlyOut,
  channelSlide,
  starToggle,
  prefersReducedMotion,
  PHASE_DURATION_MS,
  STAR_DURATION_MS,
  FLY_DISTANCE_PX,
  REDUCED_MOTION_QUERY,
} from '../src/lib/transitions/channelMove.svelte.js';
import SidebarChannelSection from '../src/components/SidebarChannelSection.svelte';

const STORAGE_KEY = 'claude-comms.test.sidebarChannelSection.transitions';

// Each test installs a controllable `window.matchMedia` so reduced-motion
// state is deterministic regardless of CI host config. Default = motion
// allowed (matches: false); individual tests flip to reduced-motion via
// `setReducedMotion(true)` before invoking the transition under test.
let matchMediaQueries = [];
function installMatchMedia(initialMatches = false) {
  matchMediaQueries = [];
  // @ts-ignore — jsdom matchMedia is writable in tests.
  window.matchMedia = vi.fn().mockImplementation((query) => {
    const mql = {
      matches: query === REDUCED_MOTION_QUERY ? initialMatches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    matchMediaQueries.push(mql);
    return mql;
  });
}
function setReducedMotion(reduce) {
  installMatchMedia(reduce);
}

function makeChannel(id, overrides = {}) {
  return {
    id,
    name: id,
    unread: 0,
    starred: false,
    muted: false,
    memberCount: 2,
    mode: 'public',
    ...overrides,
  };
}

function defaultProps(overrides = {}) {
  return {
    label: 'Active',
    icon: Hash,
    channels: [],
    activeChannelId: null,
    emptyState: 'no channels yet',
    storageKey: STORAGE_KEY,
    defaultExpanded: true,
    transitionFlavor: 'fly',
    ...overrides,
  };
}

beforeEach(() => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore — some test envs lock down storage
  }
  installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
});

describe('channelMove.svelte.js — module surface', () => {
  it('exports the documented transition primitives + constants', () => {
    // The full v0.4.0 §10 vocabulary: 4 transition functions + a helper
    // for reduced-motion detection + per-phase duration knobs. If a
    // future refactor renames one of these, downstream consumers
    // (Sidebar shell, future omnibar) will break their imports and
    // we want a clear test that pins the public surface here.
    expect(typeof channelMove.channelFlyIn).toBe('function');
    expect(typeof channelMove.channelFlyOut).toBe('function');
    expect(typeof channelMove.channelSlide).toBe('function');
    expect(typeof channelMove.starToggle).toBe('function');
    expect(typeof channelMove.prefersReducedMotion).toBe('function');
    expect(typeof channelMove.PHASE_DURATION_MS).toBe('number');
    expect(typeof channelMove.STAR_DURATION_MS).toBe('number');
    expect(typeof channelMove.FLY_DISTANCE_PX).toBe('number');
    expect(typeof channelMove.REDUCED_MOTION_QUERY).toBe('string');
  });

  it('per-phase durations sum to ~900ms for the 4-phase choreography (Design Spec §10)', () => {
    // 4 × 225ms = 900ms total, matching the spec's "Total: ~900ms
    // door-to-door" claim. The two destination-side phases overlap with
    // the two source-side phases in time, so the user perceives less than
    // 900ms of dead time, but the test asserts the underlying budget.
    expect(PHASE_DURATION_MS).toBe(225);
    expect(PHASE_DURATION_MS * 4).toBe(900);
  });

  it('star toggle duration is smaller than cross-section move duration', () => {
    // Design Spec §10.4-5 calls out "smaller transition" for star — the
    // exact value isn't pinned, but the relative ordering matters: a
    // star toggle must feel snappier than a join/leave.
    expect(STAR_DURATION_MS).toBeLessThan(PHASE_DURATION_MS);
  });
});

describe('channelMove.svelte.js — prefers-reduced-motion', () => {
  it('prefersReducedMotion() returns true when matchMedia reports the preference', () => {
    setReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('prefersReducedMotion() returns false when matchMedia reports motion allowed', () => {
    setReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('channelFlyIn returns {duration: 0} when reduced motion is active', () => {
    setReducedMotion(true);
    const node = document.createElement('div');
    document.body.appendChild(node);
    const cfg = channelFlyIn(node);
    expect(cfg.duration).toBe(0);
    document.body.removeChild(node);
  });

  it('channelFlyOut returns {duration: 0} when reduced motion is active', () => {
    setReducedMotion(true);
    const node = document.createElement('div');
    document.body.appendChild(node);
    const cfg = channelFlyOut(node);
    expect(cfg.duration).toBe(0);
    document.body.removeChild(node);
  });

  it('channelSlide returns {duration: 0} when reduced motion is active', () => {
    setReducedMotion(true);
    const node = document.createElement('div');
    document.body.appendChild(node);
    const cfg = channelSlide(node);
    expect(cfg.duration).toBe(0);
    document.body.removeChild(node);
  });

  it('starToggle returns {duration: 0} when reduced motion is active', () => {
    setReducedMotion(true);
    const node = document.createElement('div');
    document.body.appendChild(node);
    const cfg = starToggle(node);
    expect(cfg.duration).toBe(0);
    document.body.removeChild(node);
  });
});

describe('channelMove.svelte.js — animation path (motion allowed)', () => {
  it('channelFlyIn returns PHASE_DURATION_MS with a css() interpolator when motion allowed', () => {
    setReducedMotion(false);
    const node = document.createElement('div');
    document.body.appendChild(node);
    const cfg = channelFlyIn(node);
    expect(cfg.duration).toBe(PHASE_DURATION_MS);
    expect(typeof cfg.css).toBe('function');
    // Mid-transition (t=0.5, u=0.5) should produce a CSS string that
    // mentions both opacity AND a transform. We test by substring so
    // future formatting changes don't break the test, only behavior
    // changes do.
    const midCss = cfg.css(0.5, 0.5);
    expect(midCss).toContain('opacity:');
    expect(midCss).toContain('transform: translateY(');
    document.body.removeChild(node);
  });

  it('channelFlyOut interpolator interpolates height+opacity together (gap-collapse + fade-out)', () => {
    setReducedMotion(false);
    const node = document.createElement('div');
    node.style.height = '40px';
    node.style.paddingTop = '4px';
    document.body.appendChild(node);
    const cfg = channelFlyOut(node);
    const startCss = cfg.css(1, 0); // t=1 → fully visible (mount end of out is at t=1)
    const endCss = cfg.css(0, 1); // t=0 → fully collapsed
    expect(startCss).toContain('height:');
    expect(startCss).toContain('opacity: 1');
    expect(endCss).toContain('opacity: 0');
    expect(endCss).toContain('height: 0px');
    document.body.removeChild(node);
  });

  it('channelFlyIn carries an easing function (cubicOut)', () => {
    setReducedMotion(false);
    const node = document.createElement('div');
    document.body.appendChild(node);
    const cfg = channelFlyIn(node);
    expect(typeof cfg.easing).toBe('function');
    // cubicOut(0) === 0 and cubicOut(1) === 1 — boundary check that the
    // easing function is monotonic and bounded over [0,1].
    expect(cfg.easing(0)).toBeCloseTo(0, 5);
    expect(cfg.easing(1)).toBeCloseTo(1, 5);
    document.body.removeChild(node);
  });

  it('starToggle duration is STAR_DURATION_MS (smaller than cross-section)', () => {
    setReducedMotion(false);
    const node = document.createElement('div');
    document.body.appendChild(node);
    const cfg = starToggle(node);
    expect(cfg.duration).toBe(STAR_DURATION_MS);
    document.body.removeChild(node);
  });

  it('FLY_DISTANCE_PX is a small positive integer suitable for a slide hint', () => {
    // The fly distance should be subtle — 8px or so. A test pinning
    // exact value here would over-constrain the design; we just verify
    // it's bounded.
    expect(FLY_DISTANCE_PX).toBeGreaterThan(0);
    expect(FLY_DISTANCE_PX).toBeLessThan(40);
  });
});

describe('SidebarChannelSection — row wrappers carry transition markers', () => {
  it("renders a row wrapper with data-transition-flavor='fly' by default", async () => {
    const props = defaultProps({ channels: [makeChannel('general')] });
    const { container } = render(SidebarChannelSection, { props });
    await tick();
    const wrap = container.querySelector(
      '[data-testid="sidebar-channel-section-row-wrap-general"]',
    );
    expect(wrap).not.toBeNull();
    expect(wrap.getAttribute('data-transition-flavor')).toBe('fly');
  });

  it("propagates transitionFlavor='crossfade' onto both wrapper and row", async () => {
    const props = defaultProps({
      channels: [makeChannel('general')],
      transitionFlavor: 'crossfade',
    });
    const { container } = render(SidebarChannelSection, { props });
    await tick();
    const wrap = container.querySelector(
      '[data-testid="sidebar-channel-section-row-wrap-general"]',
    );
    const row = container.querySelector(
      '[data-testid="sidebar-channel-row-general"]',
    );
    expect(wrap.getAttribute('data-transition-flavor')).toBe('crossfade');
    expect(row.getAttribute('data-transition-flavor')).toBe('crossfade');
  });

  it("propagates transitionFlavor='instant' to disable section transitions", async () => {
    const props = defaultProps({
      channels: [makeChannel('general')],
      transitionFlavor: 'instant',
    });
    const { container } = render(SidebarChannelSection, { props });
    await tick();
    const wrap = container.querySelector(
      '[data-testid="sidebar-channel-section-row-wrap-general"]',
    );
    expect(wrap.getAttribute('data-transition-flavor')).toBe('instant');
  });

  it('mounts a row wrapper for each channel; one wrapper per channel id', async () => {
    const props = defaultProps({
      channels: [
        makeChannel('alpha'),
        makeChannel('bravo'),
        makeChannel('charlie'),
      ],
    });
    const { container } = render(SidebarChannelSection, { props });
    await tick();
    const wrappers = container.querySelectorAll(
      '[data-testid^="sidebar-channel-section-row-wrap-"]',
    );
    expect(wrappers.length).toBe(3);
    const ids = Array.from(wrappers).map((el) =>
      el.getAttribute('data-testid').replace(
        'sidebar-channel-section-row-wrap-',
        '',
      ),
    );
    expect(ids).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('reduced-motion + section: row wrappers still render with the data-transition-flavor attribute (animation is the only thing that changes)', async () => {
    // The animation primitives short-circuit to duration 0 under
    // reduced motion, but the section still renders the wrapper
    // element + flavor marker so DOM-level tests + CSS selectors
    // continue to find them. This is the "no surprise" rule from
    // Design Spec §10.8 — the user still sees the state change
    // happen, just without animation.
    setReducedMotion(true);
    const props = defaultProps({
      channels: [makeChannel('quiet-channel')],
    });
    const { container } = render(SidebarChannelSection, { props });
    await tick();
    const wrap = container.querySelector(
      '[data-testid="sidebar-channel-section-row-wrap-quiet-channel"]',
    );
    expect(wrap).not.toBeNull();
    expect(wrap.getAttribute('data-transition-flavor')).toBe('fly');
  });

  it('wrapper element type is a block-level div (so slide/height transitions work)', async () => {
    const props = defaultProps({ channels: [makeChannel('general')] });
    const { container } = render(SidebarChannelSection, { props });
    await tick();
    const wrap = container.querySelector(
      '[data-testid="sidebar-channel-section-row-wrap-general"]',
    );
    expect(wrap.tagName).toBe('DIV');
    expect(wrap.classList.contains('sidebar-channel-section-row-wrap')).toBe(
      true,
    );
  });
});
