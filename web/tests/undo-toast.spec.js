// Tests for UndoToast.svelte — Polish Wave P3.
//
// The UndoToast is a lower-right toast that gives the user 15 seconds (by
// default) to undo a destructive but reversible action — specifically the
// silent `leaveChannel` / `archiveChannel` paths in the store, which return
// a `{ done, cancel }` envelope. Caller (Sidebar, wired in Batch 2)
// constructs the toast and routes its callbacks to the envelope:
//
//   const { done, cancel } = await store.leaveChannel(channelId);
//   mountUndoToast({
//     message: `Left #${channelName}`,
//     onUndo:   () => cancel(),   // revert the optimistic local action
//     onExpire: () => done(),     // commit the action (or no-op if already)
//   });
//
// What this suite pins:
//
//   1. Render contract — message, undoLabel default + custom, dismiss button.
//   2. Undo flow — click within window fires onUndo, NOT onExpire.
//   3. Expire flow — timer fires onExpire after timeoutMs, NOT onUndo.
//   4. Dismiss-X flow — fires onExpire (the design says dismissing without
//      undoing means the user accepted the action, so the action commits).
//   5. Custom timeoutMs is respected (not hardcoded to 15s).
//   6. prefers-reduced-motion path does not break the timer logic.
//
// Implementation notes:
//
// - `vi.useFakeTimers()` is used to drive the countdown deterministically.
//   The component schedules a single `setTimeout(expireCallback, timeoutMs)`
//   so `vi.advanceTimersByTime(timeoutMs)` triggers the expire path.
//
// - We exercise the click handlers via @testing-library/svelte's
//   `fireEvent.click`. Each test uses `vi.fn()` spies for both callbacks so
//   we can assert both "was called" and "was NOT called" — the second half
//   is the actually-interesting invariant in this component.
//
// - cleanup() runs after each test to unmount the component and clear its
//   internal $effect-cleanup (which clearTimeout's the pending timer). This
//   is important: if the timer leaks across tests, the next test's vi.fn()
//   spies could be called by a previous test's pending timer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import UndoToast from '../src/components/UndoToast.svelte';

// ── Helpers ────────────────────────────────────────────────────────────

function makeProps(overrides = {}) {
  return {
    message: 'Left #general',
    undoLabel: 'Undo',
    timeoutMs: 15000,
    onUndo: vi.fn(),
    onExpire: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Unmount any mounted components FIRST so their cleanup runs against the
  // fake-timers scheduler (clearTimeout on the pending expire), THEN
  // restore the real timers. Reversing this order can produce a real-timer
  // clearTimeout against a fake-timer handle, which is a no-op on the
  // pending fake timer — and that pending timer can fire during the NEXT
  // test's setup.
  cleanup();
  vi.useRealTimers();
});

// ── 1. Render contract ────────────────────────────────────────────────

describe('UndoToast — render contract', () => {
  it('renders the message text', () => {
    const props = makeProps({ message: 'Left #general' });
    const { getByTestId } = render(UndoToast, { props });
    const msg = getByTestId('undo-toast-message');
    expect(msg.textContent).toBe('Left #general');
  });

  it('renders the default undoLabel "Undo" when prop omitted', () => {
    // Explicitly DROP undoLabel from the props so the component default
    // ('Undo') kicks in. Don't pass undefined — pass nothing.
    const { undoLabel: _drop, ...rest } = makeProps();
    const { getByTestId } = render(UndoToast, { props: rest });
    const btn = getByTestId('undo-toast-undo');
    expect(btn.textContent.trim()).toBe('Undo');
  });

  it('renders a custom undoLabel when provided', () => {
    const props = makeProps({ undoLabel: 'Bring it back' });
    const { getByTestId } = render(UndoToast, { props });
    const btn = getByTestId('undo-toast-undo');
    expect(btn.textContent.trim()).toBe('Bring it back');
  });

  it('renders a dismiss (X) button as a real <button> element', () => {
    const props = makeProps();
    const { getByTestId } = render(UndoToast, { props });
    const dismiss = getByTestId('undo-toast-dismiss');
    expect(dismiss.tagName).toBe('BUTTON');
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss');
  });

  it('declares role=status with aria-live=polite for a11y', () => {
    const props = makeProps();
    const { getByTestId } = render(UndoToast, { props });
    const toast = getByTestId('undo-toast');
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
  });

  it('renders the Undo trigger as a real <button> element', () => {
    // Per the brief: "Undo button is a proper <button> element."
    const props = makeProps();
    const { getByTestId } = render(UndoToast, { props });
    const btn = getByTestId('undo-toast-undo');
    expect(btn.tagName).toBe('BUTTON');
    // type="button" prevents accidental form-submit if mounted inside a
    // <form>. Pinning this prevents a regression to default type="submit".
    expect(btn.getAttribute('type')).toBe('button');
  });
});

// ── 2. Undo flow ──────────────────────────────────────────────────────

describe('UndoToast — undo within window', () => {
  it('clicking Undo fires onUndo', async () => {
    const props = makeProps();
    const { getByTestId } = render(UndoToast, { props });
    await fireEvent.click(getByTestId('undo-toast-undo'));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
  });

  it('clicking Undo does NOT also fire onExpire', async () => {
    // Critical invariant: the user-undo and expire-commit paths are
    // mutually exclusive. If we ever introduce a code path that fires
    // both, the caller would both restore AND commit, leading to
    // double-action.
    const props = makeProps();
    const { getByTestId } = render(UndoToast, { props });
    await fireEvent.click(getByTestId('undo-toast-undo'));
    expect(props.onExpire).not.toHaveBeenCalled();
  });

  it('clicking Undo cancels the pending expire timer (timer does not fire after)', async () => {
    // After undoing, advancing past timeoutMs should NOT call onExpire.
    // This guards against a leaked timer that would fire onExpire post-undo.
    const props = makeProps({ timeoutMs: 5000 });
    const { getByTestId } = render(UndoToast, { props });
    await fireEvent.click(getByTestId('undo-toast-undo'));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onExpire).not.toHaveBeenCalled();
    // Crank the clock well past the original window.
    vi.advanceTimersByTime(10_000);
    // Timer must have been cleared by finalize().
    expect(props.onExpire).not.toHaveBeenCalled();
    expect(props.onUndo).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Expire flow ────────────────────────────────────────────────────

describe('UndoToast — countdown expiration', () => {
  it('fires onExpire after timeoutMs', async () => {
    const props = makeProps({ timeoutMs: 15_000 });
    render(UndoToast, { props });
    // Just before the deadline: nothing fired yet.
    vi.advanceTimersByTime(14_999);
    expect(props.onExpire).not.toHaveBeenCalled();
    // Tick past the deadline.
    vi.advanceTimersByTime(1);
    expect(props.onExpire).toHaveBeenCalledTimes(1);
  });

  it('countdown expiration does NOT call onUndo', () => {
    const props = makeProps({ timeoutMs: 1000 });
    render(UndoToast, { props });
    vi.advanceTimersByTime(1000);
    expect(props.onExpire).toHaveBeenCalledTimes(1);
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it('respects a custom timeoutMs (not hardcoded to 15s)', () => {
    // Pin that the prop is actually wired through, not ignored. We use a
    // tiny 250ms window — at 200ms expire must NOT have fired; at 250ms+
    // it must have.
    const props = makeProps({ timeoutMs: 250 });
    render(UndoToast, { props });
    vi.advanceTimersByTime(200);
    expect(props.onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(props.onExpire).toHaveBeenCalledTimes(1);
  });

  it('onExpire fires at most once even if multiple timer ticks elapse after expiry', () => {
    // Idempotency guard: advancing well past the deadline should not
    // produce a second onExpire (the timer is single-shot and finalize()
    // is dismissed-guarded).
    const props = makeProps({ timeoutMs: 500 });
    render(UndoToast, { props });
    vi.advanceTimersByTime(2000);
    expect(props.onExpire).toHaveBeenCalledTimes(1);
  });
});

// ── 4. Dismiss (X) flow ───────────────────────────────────────────────

describe('UndoToast — X dismiss behavior', () => {
  it('clicking X calls onExpire (caller treats as committed)', async () => {
    // Per the design rationale in the brief: "dismiss without clicking Undo
    // means the user accepted the action; if they wanted to undo they'd
    // have clicked Undo." So the dismiss path is wired to onExpire, NOT a
    // third onDismiss callback.
    const props = makeProps();
    const { getByTestId } = render(UndoToast, { props });
    await fireEvent.click(getByTestId('undo-toast-dismiss'));
    expect(props.onExpire).toHaveBeenCalledTimes(1);
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it('clicking X cancels the pending timer (no double-fire)', async () => {
    const props = makeProps({ timeoutMs: 5000 });
    const { getByTestId } = render(UndoToast, { props });
    await fireEvent.click(getByTestId('undo-toast-dismiss'));
    expect(props.onExpire).toHaveBeenCalledTimes(1);
    // Advance past what would have been the natural deadline — onExpire
    // must NOT be called a second time.
    vi.advanceTimersByTime(10_000);
    expect(props.onExpire).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Reduced motion + lifecycle robustness ──────────────────────────

describe('UndoToast — reduced motion + lifecycle', () => {
  it('does not break when prefers-reduced-motion matches', () => {
    // jsdom does not implement matchMedia by default — patch it to report
    // "reduce" so we exercise the reduceMotion = true code path.
    const origMatchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    });
    try {
      const props = makeProps({ timeoutMs: 1000 });
      const { getByTestId } = render(UndoToast, { props });
      // Component mounted without throwing — the progress bar should have
      // the `reduced` class applied.
      const bar = getByTestId('undo-toast-progress');
      expect(bar.classList.contains('reduced')).toBe(true);
      // And the timer still works.
      vi.advanceTimersByTime(1000);
      expect(props.onExpire).toHaveBeenCalledTimes(1);
    } finally {
      if (origMatchMedia) {
        window.matchMedia = origMatchMedia;
      } else {
        delete window.matchMedia;
      }
    }
  });

  it('unmounting before timer fires cleans up the timer (no late onExpire)', () => {
    // Critical lifecycle invariant: if the parent unmounts the toast (for
    // example because the user navigated away or the action was rolled
    // back externally), the pending expire timer MUST be cleared by the
    // $effect cleanup. Otherwise a stale onExpire would fire against a
    // possibly-stale closure reference.
    const props = makeProps({ timeoutMs: 5000 });
    const { unmount } = render(UndoToast, { props });
    unmount();
    vi.advanceTimersByTime(10_000);
    expect(props.onExpire).not.toHaveBeenCalled();
    expect(props.onUndo).not.toHaveBeenCalled();
  });
});
