// Global Vitest setup — registered via `setupFiles` in vitest.config.js.
//
// Fixes an intermittent CI failure where the run exits 1 with
// "1 unhandled error: ReferenceError: document is not defined" even though
// all test files pass. The error is mis-attributed to whichever spec is
// executing in the reused worker when it fires (commonly
// channel-modal-bugfix.spec.js), but its real origin is bits-ui.
//
// Root cause: bits-ui's body-scroll-lock (Dialog / Popover / etc.) registers
// a scroll lock on mount and, on unmount, schedules a ~24ms `setTimeout` to
// reset `document.body` styles
// (node_modules/bits-ui/.../body-scroll-lock.svelte.js:
//  scheduleCleanupIfNoNewLocks -> resetBodyStyle). If the jsdom environment
// is torn down before that timer fires, the timer's callback runs with
// `document` undefined and throws. Vitest surfaces it as an unhandled error
// that fails the whole run. It is timing-dependent, hence intermittent.
//
// Fix: after every test we unmount rendered components, then — only when a
// bits-ui body lock is still pending and real timers are in use — let the
// stray cleanup timer run while `document` still exists. The guard keeps the
// added latency on the handful of Dialog/Popover specs only; everything else
// pays nothing.
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/svelte';

// Slightly longer than bits-ui's default 24ms cleanup delay so the pending
// timer is guaranteed to fire before we return and the env is torn down.
const BITS_UI_SCROLL_LOCK_DRAIN_MS = 40;

afterEach(async () => {
  cleanup();

  // A still-active fake-timer clock would never advance our drain timer,
  // so skip — fake-timer specs control their own clock and reset it.
  if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) return;
  if (typeof document === 'undefined' || !document.body) return;

  // bits-ui sets `--scrollbar-width` (and overflow styles) on <body> while a
  // scroll lock is held; `resetBodyStyle` removes them in the delayed timer.
  // Their presence after unmount means a cleanup timer is still pending.
  const bodyStyle = document.body.getAttribute('style') ?? '';
  const lockPending =
    document.body.style.getPropertyValue('--scrollbar-width') !== '' ||
    bodyStyle.includes('--scrollbar-width') ||
    bodyStyle.includes('overflow');
  if (!lockPending) return;

  await new Promise((resolve) => setTimeout(resolve, BITS_UI_SCROLL_LOCK_DRAIN_MS));
});
