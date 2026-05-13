// Tests for LeaveChannelDialog.svelte — v0.4.0 plan Step 2.11.
//
// This dialog is the "heavy-investment leave" guard: the parent (Sidebar
// in Step 2.12) mounts it only when the user has invested enough in the
// channel that an accidental leave would sting — > 50 messages sent, a
// pinned authorship, or a starred channel (auto-unstar warning per
// Design Spec §2.6). If none of those hold, the parent skips the dialog
// entirely and the leave proceeds silently.
//
// What this suite pins:
//
//   1. Layout / copy per trigger condition
//      - The title interpolates the channel name.
//      - Singular vs plural messageCount copy is correct.
//      - The starred warning renders iff `isStarred`.
//      - The pinned warning renders iff `hasPinnedMessages`.
//
//   2. A11y — focus + keyboard
//      - role="dialog" + aria-modal="true" + aria-labelledby resolves.
//      - Default focus lands on Cancel (destructive default-focus
//        pattern — make the user actively pick the destructive action).
//      - Tab on the LAST focusable (Leave) cycles to Cancel.
//      - Shift+Tab on the FIRST focusable (Cancel) cycles to Leave.
//      - Escape calls onCancel (NOT onConfirm).
//      - Enter on the Leave button calls onConfirm.
//      - Enter when the Cancel button has focus does NOT call onConfirm
//        (this is the whole point of default-focus on Cancel — a user
//        landing there and hitting Enter should cancel, not destroy).
//      - Focus is restored to the element that was focused before
//        mount, on unmount.
//
//   3. Click wiring
//      - Cancel button click → onCancel.
//      - Leave button click → onConfirm.
//      - Overlay click → onCancel.
//      - Click inside the dialog content does NOT bubble to overlay.
//
// Notes on implementation:
//
// - We mount the real component via @testing-library/svelte's render().
//   The component does NOT use bits-ui Portal, so the DOM lives under
//   the test container and queries are straightforward.
//
// - The component sets default focus inside a `queueMicrotask` to defer
//   past Svelte's mount. We use a `flushMicrotasks()` helper that awaits
//   a chain of resolved Promises + Svelte tick to surface the focused
//   state before asserting.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import LeaveChannelDialog from '../src/components/LeaveChannelDialog.svelte';

// ── Helpers ────────────────────────────────────────────────────────────

function makeProps(overrides = {}) {
  return {
    channel: { id: 'project-alpha', name: 'project-alpha' },
    messageCount: 120,
    isStarred: false,
    hasPinnedMessages: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

// The component schedules its initial focus via queueMicrotask. To let
// that fire deterministically, await a microtask + a Svelte tick.
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

function fireKey(target, key, init = {}) {
  return fireEvent.keyDown(target, { key, bubbles: true, cancelable: true, ...init });
}

afterEach(() => {
  cleanup();
});

// ── 1. Layout / copy per trigger condition ─────────────────────────────

describe('LeaveChannelDialog — copy per trigger condition', () => {
  it('renders the channel name in the title with the # prefix', () => {
    const props = makeProps({ channel: { id: 'general', name: 'general' } });
    const { getByTestId } = render(LeaveChannelDialog, { props });
    const title = getByTestId('leave-channel-title');
    expect(title.textContent.trim()).toBe('Leave #general?');
  });

  it('uses singular copy for messageCount === 1', () => {
    const props = makeProps({ messageCount: 1 });
    const { getByTestId } = render(LeaveChannelDialog, { props });
    const body = getByTestId('leave-channel-body');
    expect(body.textContent).toContain("You've sent 1 message in this channel.");
    // Make sure we're not double-rendering "messages" anywhere.
    expect(body.textContent).not.toContain('1 messages');
  });

  it('uses plural copy for messageCount > 1', () => {
    const props = makeProps({ messageCount: 73 });
    const { getByTestId } = render(LeaveChannelDialog, { props });
    const body = getByTestId('leave-channel-body');
    expect(body.textContent).toContain("You've sent 73 messages in this channel.");
  });

  it('renders the starred-warning line only when isStarred', () => {
    const propsOn = makeProps({ isStarred: true });
    const { queryByTestId, unmount } = render(LeaveChannelDialog, { props: propsOn });
    expect(queryByTestId('leave-channel-starred-warning')).not.toBeNull();
    expect(queryByTestId('leave-channel-starred-warning').textContent.trim()).toBe(
      'Leaving will remove this channel from your starred list.'
    );
    unmount();

    const propsOff = makeProps({ isStarred: false });
    const { queryByTestId: q2 } = render(LeaveChannelDialog, { props: propsOff });
    expect(q2('leave-channel-starred-warning')).toBeNull();
  });

  it('renders the pinned-warning line only when hasPinnedMessages', () => {
    const propsOn = makeProps({ hasPinnedMessages: true });
    const { queryByTestId, unmount } = render(LeaveChannelDialog, { props: propsOn });
    expect(queryByTestId('leave-channel-pinned-warning')).not.toBeNull();
    expect(queryByTestId('leave-channel-pinned-warning').textContent.trim()).toBe(
      'You have pinned messages here that will remain accessible to other members.'
    );
    unmount();

    const propsOff = makeProps({ hasPinnedMessages: false });
    const { queryByTestId: q2 } = render(LeaveChannelDialog, { props: propsOff });
    expect(q2('leave-channel-pinned-warning')).toBeNull();
  });

  it('renders BOTH warnings when both triggers are active', () => {
    const props = makeProps({ isStarred: true, hasPinnedMessages: true });
    const { queryByTestId } = render(LeaveChannelDialog, { props });
    expect(queryByTestId('leave-channel-starred-warning')).not.toBeNull();
    expect(queryByTestId('leave-channel-pinned-warning')).not.toBeNull();
  });
});

// ── 2. A11y — focus + keyboard ─────────────────────────────────────────

describe('LeaveChannelDialog — a11y / focus / keyboard', () => {
  it('declares role=dialog, aria-modal, and a resolvable aria-labelledby', () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    const dialog = getByTestId('leave-channel-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    // The labelled element must exist in the document. We resolve via
    // document.getElementById rather than querySelector because the id
    // contains characters (a `-`) that are safe but the test should not
    // depend on CSS.escape (not present in jsdom).
    const labelled = document.getElementById(labelId);
    expect(labelled).not.toBeNull();
    expect(labelled.textContent).toContain('Leave');
  });

  it('defaults focus to the Cancel button (NOT the destructive Leave button)', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await flushMicrotasks();
    const cancel = getByTestId('leave-channel-cancel');
    expect(document.activeElement).toBe(cancel);
  });

  it('Escape on the dialog calls onCancel, not onConfirm', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await flushMicrotasks();
    const dialog = getByTestId('leave-channel-dialog');
    fireKey(dialog, 'Escape');
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('Enter on the Leave button calls onConfirm', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await flushMicrotasks();
    const leave = getByTestId('leave-channel-confirm');
    leave.focus();
    fireKey(leave, 'Enter');
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('Enter on the Cancel button does NOT call onConfirm', async () => {
    // Cancel has default focus. A user landing there and pressing Enter
    // should NOT confirm. (The native button activation on Enter would
    // call its onclick → onCancel; that's fine. The key invariant: NO
    // accidental confirm.)
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await flushMicrotasks();
    const cancel = getByTestId('leave-channel-cancel');
    cancel.focus();
    fireKey(cancel, 'Enter');
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('Tab focus trap: Tab on the last focusable (Leave) cycles to the first (Cancel)', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await flushMicrotasks();
    const cancel = getByTestId('leave-channel-cancel');
    const leave = getByTestId('leave-channel-confirm');
    leave.focus();
    expect(document.activeElement).toBe(leave);
    // Tab from the last focusable should wrap back to the first.
    fireKey(leave, 'Tab');
    expect(document.activeElement).toBe(cancel);
  });

  it('Tab focus trap: Shift+Tab on the first focusable (Cancel) cycles to the last (Leave)', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await flushMicrotasks();
    const cancel = getByTestId('leave-channel-cancel');
    const leave = getByTestId('leave-channel-confirm');
    cancel.focus();
    expect(document.activeElement).toBe(cancel);
    fireKey(cancel, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(leave);
  });

  it('restores focus to the element that was focused before mount, on unmount', async () => {
    // Plant a focusable trigger in the document so we have something for
    // the dialog to restore focus to.
    const trigger = document.createElement('button');
    trigger.textContent = 'open-dialog-trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const props = makeProps();
    const { unmount } = render(LeaveChannelDialog, { props });
    await flushMicrotasks();
    // Default focus has moved into the dialog.
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    // After unmount, the $effect cleanup restores focus to `trigger`.
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});

// ── 3. Click wiring ────────────────────────────────────────────────────

describe('LeaveChannelDialog — click wiring', () => {
  it('clicking Cancel calls onCancel', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await fireEvent.click(getByTestId('leave-channel-cancel'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('clicking Leave calls onConfirm', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await fireEvent.click(getByTestId('leave-channel-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('clicking the overlay calls onCancel', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    await fireEvent.click(getByTestId('leave-channel-overlay'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog content does NOT bubble to overlay cancel', async () => {
    const props = makeProps();
    const { getByTestId } = render(LeaveChannelDialog, { props });
    // Click the body region (not a button) — the content's stopPropagation
    // should prevent the overlay click handler from firing.
    await fireEvent.click(getByTestId('leave-channel-body'));
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
