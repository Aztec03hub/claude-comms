/**
 * channelMove.svelte.js — Sidebar reactive transitions for v0.4.0.
 *
 * Choreographs the 4-phase animation specified in
 * `.worklogs/channel-management-design-spec.md` §10 when a channel moves
 * between sidebar sections (join, leave, star, unstar). Each phase is
 * ~225ms for a total ~900ms door-to-door, with `prefers-reduced-motion`
 * users getting an instant snap (0ms duration) — the row still leaves
 * its old slot and appears in its new slot, just without slide/fade.
 *
 * The 4 phases composed from this module's primitives:
 *   1. fade-out from old section   → `channelFlyOut` on the leaving row
 *   2. gap-collapse in old section → `channelSlide` out (height → 0)
 *   3. gap-grow in new section     → `channelSlide` in  (0 → height)
 *   4. fade-in to new section      → `channelFlyIn`  on the arriving row
 *
 * Star/unstar uses the same primitives but with smaller `STAR_DURATION`
 * (~150ms per phase) — design-spec §10.4-10.5 calls this out as a
 * "smaller transition" than join/leave. Close (archive/delete) animates
 * as fade-out + collapse in place (no destination section), which is
 * just `channelFlyOut` followed by `channelSlide` on the row's wrapper.
 *
 * Implementation note: instead of writing a coordinator that drives all
 * four phases imperatively, we compose Svelte's built-in `fly`/`fade`/
 * `slide` transitions on the section's `{#each}` block. Svelte handles
 * the phase sequencing implicitly: a row leaving its `{#each}` plays
 * its `out:` transition while the row entering plays its `in:` — the
 * section's height adjusts via the `transition:slide` wrapped around
 * the row. When the store moves a channel between sections, the same
 * row keys disappear from one section's array and reappear in another
 * — each section independently plays its in/out transition, producing
 * the 4-phase choreography on screen.
 *
 * SSR-safe: every function reads `window`/`document` only when called
 * at runtime (Svelte transitions only run client-side anyway). The
 * `prefersReducedMotion()` helper short-circuits with `false` in
 * environments without `window.matchMedia`.
 */

import { fade, slide } from 'svelte/transition';
import { cubicOut } from 'svelte/easing';

/**
 * Per-phase duration matching Design Spec §10.1 — `var(--transition-slow)`
 * is 0.35s for cross-section moves, but the spec also describes a 4-phase
 * choreography totalling ~900ms. We use 225ms per phase here so the four
 * phases land at 900ms total. The phase-3 gap-grow and phase-4 fade-in
 * happen on the destination section in parallel, so the user perceives
 * roughly 2x225ms = 450ms from "row leaves old slot" → "row settled in
 * new slot," which feels snappy.
 *
 * Exported as named constants so the test suite can assert on them
 * without re-importing the design spec.
 */
export const PHASE_DURATION_MS = 225;

/**
 * Star toggle is smaller — the row doesn't always change sections (e.g.,
 * starring a row already in the Active section just toggles its star
 * icon and doesn't reflow). 150ms per phase keeps it subtle.
 */
export const STAR_DURATION_MS = 150;

/**
 * Slight vertical slide distance applied alongside the fade for `flyIn`/
 * `flyOut` — design-spec §10.2 phase-3 says "no transform" on the fade-in,
 * but anecdotally a tiny 8px slide reads as more intentional than a pure
 * opacity fade. Matches the value the orchestrator spec called out.
 */
export const FLY_DISTANCE_PX = 8;

/**
 * `prefers-reduced-motion: reduce` query string. Hoisted to a constant
 * so test suites can monkey-patch `window.matchMedia` deterministically
 * without string-duping.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Returns `true` when the user has the OS-level reduced-motion preference
 * enabled. Defensive against:
 *  - SSR (no `window` / no `matchMedia`)
 *  - older browsers (`matchMedia` returns `null` for unknown queries)
 *  - jsdom (which implements `matchMedia` as a no-op returning `matches: false`)
 *
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    return Boolean(mql && mql.matches);
  } catch {
    // matchMedia can throw on malformed queries in old engines.
    return false;
  }
}

/**
 * Internal helper: build a TransitionConfig that snaps instantly when
 * reduced-motion is active. Used by every exported transition below so
 * the reduced-motion path is a single source of truth.
 *
 * @param {() => import('svelte/transition').TransitionConfig} build
 * @returns {import('svelte/transition').TransitionConfig}
 */
function withReducedMotionFallback(build) {
  if (prefersReducedMotion()) {
    return { duration: 0 };
  }
  return build();
}

/**
 * Measure-then-interpolate helper: capture the node's current height +
 * vertical paddings/margins/borders at transition kickoff, then return
 * a css() function that drives all of them from 0 (collapsed) to their
 * measured values (expanded) — same trick Svelte's built-in `slide` uses
 * internally. We do this in `channelFlyIn`/`channelFlyOut` so a single
 * `in:` / `out:` directive can produce BOTH the height collapse/grow
 * AND the fade/slide of contents, satisfying Svelte's "no `transition:`
 * alongside `in:`/`out:` on the same element" rule
 * (https://svelte.dev/e/transition_conflict).
 *
 * @param {Element} node
 */
function measureBoxStyles(node) {
  // jsdom returns "" for unset computed values; treat those as 0 to keep
  // arithmetic stable. Casting via parseFloat skips "px"/"em" suffixes.
  const style = getComputedStyle(node);
  return {
    height: parseFloat(style.height) || 0,
    paddingTop: parseFloat(style.paddingTop) || 0,
    paddingBottom: parseFloat(style.paddingBottom) || 0,
    marginTop: parseFloat(style.marginTop) || 0,
    marginBottom: parseFloat(style.marginBottom) || 0,
    borderTopWidth: parseFloat(style.borderTopWidth) || 0,
    borderBottomWidth: parseFloat(style.borderBottomWidth) || 0,
  };
}

/**
 * `channelFlyIn` — combined transition for a row arriving in a section.
 * Animates BOTH the wrapper's box geometry (height + padding + margin +
 * border, like `slide`) AND the row contents' opacity + a slight slide
 * (like `fly`), so a single `in:channelFlyIn` directive produces phases
 * 3 (gap-grow) and 4 (fade-in) of Design Spec §10.2.
 *
 * Combining the two effects in one transition (rather than stacking
 * `transition:slide` + `in:fly`) is required because Svelte rejects
 * `transition:` alongside `in:` on the same element.
 *
 * Reduced motion users get an instant 0ms snap.
 *
 * @param {Element} node
 * @param {{ duration?: number }} [params]
 * @returns {import('svelte/transition').TransitionConfig}
 */
export function channelFlyIn(node, params = {}) {
  return withReducedMotionFallback(() => {
    const box = measureBoxStyles(node);
    return {
      duration: params.duration ?? PHASE_DURATION_MS,
      easing: cubicOut,
      css: (t, u) =>
        // Box geometry (height/padding/margin/border) scales 0→1 with t,
        // so the section's vertical reflow looks like `slide` did.
        `overflow: hidden;` +
        `opacity: ${t};` +
        `height: ${t * box.height}px;` +
        `padding-top: ${t * box.paddingTop}px;` +
        `padding-bottom: ${t * box.paddingBottom}px;` +
        `margin-top: ${t * box.marginTop}px;` +
        `margin-bottom: ${t * box.marginBottom}px;` +
        `border-top-width: ${t * box.borderTopWidth}px;` +
        `border-bottom-width: ${t * box.borderBottomWidth}px;` +
        // Contents float in from a slight upward offset (u runs 1→0 over
        // the transition, so we get translateY(-8px) → translateY(0)).
        `transform: translateY(${u * -FLY_DISTANCE_PX}px);`,
    };
  });
}

/**
 * `channelFlyOut` — combined transition for a row leaving a section.
 * Mirror of `channelFlyIn`: collapses height + opacity + translates the
 * contents up by FLY_DISTANCE_PX. One directive produces phases 1 (fade
 * out) and 2 (gap-collapse) of Design Spec §10.3.
 *
 * Reduced motion users get an instant 0ms snap.
 *
 * @param {Element} node
 * @param {{ duration?: number }} [params]
 * @returns {import('svelte/transition').TransitionConfig}
 */
export function channelFlyOut(node, params = {}) {
  return withReducedMotionFallback(() => {
    const box = measureBoxStyles(node);
    return {
      duration: params.duration ?? PHASE_DURATION_MS,
      easing: cubicOut,
      css: (t, u) =>
        `overflow: hidden;` +
        `opacity: ${t};` +
        `height: ${t * box.height}px;` +
        `padding-top: ${t * box.paddingTop}px;` +
        `padding-bottom: ${t * box.paddingBottom}px;` +
        `margin-top: ${t * box.marginTop}px;` +
        `margin-bottom: ${t * box.marginBottom}px;` +
        `border-top-width: ${t * box.borderTopWidth}px;` +
        `border-bottom-width: ${t * box.borderBottomWidth}px;` +
        `transform: translateY(${u * -FLY_DISTANCE_PX}px);`,
    };
  });
}

/**
 * `channelSlide` — direct re-wrap of `svelte/transition`'s `slide` for
 * callers that want JUST the height-collapse/grow effect without the
 * opacity/translate. Useful when a row is moving WITHIN a section (e.g.,
 * a star toggle on a row already in Active) — there the row isn't
 * leaving the section, just rearranging vertically inside it. Falls back
 * to instant under reduced motion.
 *
 * Note: `slide` is bidirectional, so it can be used as either
 * `transition:channelSlide`, `in:channelSlide`, or `out:channelSlide` —
 * but NOT alongside `in:`/`out:` on the same element if you also use
 * `transition:` (Svelte's transition_conflict rule).
 *
 * @param {Element} node
 * @param {{ duration?: number; axis?: 'x' | 'y' }} [params]
 * @returns {import('svelte/transition').TransitionConfig}
 */
export function channelSlide(node, params = {}) {
  return withReducedMotionFallback(() =>
    slide(node, {
      duration: params.duration ?? PHASE_DURATION_MS,
      easing: cubicOut,
      axis: params.axis ?? 'y',
    }),
  );
}

/**
 * `starToggle` — smaller transition pair for star/unstar (Design Spec §10.4-5).
 * When a row toggles its starred state, the row crossfades from one section to
 * the other. Same shape as `channelFlyIn`/`channelFlyOut` but with
 * `STAR_DURATION_MS` instead of `PHASE_DURATION_MS`.
 *
 * Star toggles also honor reduced motion (snap to final state).
 *
 * @param {Element} _node
 * @param {{ direction?: 'in' | 'out' }} [params]
 * @returns {import('svelte/transition').TransitionConfig}
 */
export function starToggle(_node, params = {}) {
  return withReducedMotionFallback(() => ({
    duration: STAR_DURATION_MS,
    easing: cubicOut,
    css: (t) => `opacity: ${t};`,
    // direction is informational only — the css interpolates t naturally
    // (0→1 for `in`, 1→0 for `out`), so callers can pass `params.direction`
    // for documentation but the math doesn't branch on it.
    ...(params.direction ? { _direction: params.direction } : {}),
  }));
}

/**
 * Re-export `fade` from `svelte/transition` so callers can pull all the
 * sidebar-related transition primitives from one module without a second
 * import. Used by close (archive/delete) flows where a row fades out
 * without a destination — `out:fade` is sufficient there, no slide.
 */
export { fade };
