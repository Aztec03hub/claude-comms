// Tests for TypeNameConfirmDialog.svelte — Polish Wave P2.
//
// This dialog is the "type the resource name to confirm" destructive-
// action guard, modelled on the GitHub / Linear pattern. The Polish
// Wave's Batch-2 wiring agent will mount it from
// ChannelDirectoryModal's Admin tab and the Sidebar context-menu
// Delete action, replacing v0.4.0's `window.confirm` / `window.prompt`
// placeholders.
//
// What this suite pins:
//
//   1. Layout / copy
//      - Title renders (default or override).
//      - Body renders.
//      - Resource name renders.
//      - The required-typed-name appears in the prompt.
//
//   2. The disabled-until-match gate
//      - Confirm disabled when input is empty.
//      - Confirm disabled on partial match.
//      - Confirm disabled on case mismatch (case-sensitive).
//      - Confirm enabled when input exactly matches requireTypedName.
//      - Confirm re-disabled if the user edits back to a mismatch.
//
//   3. A11y + keyboard
//      - role="dialog" + aria-modal + aria-labelledby resolves.
//      - Default focus is Cancel (destructive default-focus pattern).
//      - Escape calls onCancel, NEVER onConfirm.
//      - Enter on the Confirm button (when enabled) calls onConfirm.
//      - Enter on the Confirm button (when disabled) does NOT call
//        onConfirm.
//      - Enter on the input does NOT call onConfirm even when the
//        match is satisfied (typers Enter-through reflex guard).
//
//   4. Click wiring
//      - Cancel click → onCancel.
//      - Confirm click (when enabled) → onConfirm.
//      - Confirm click (when disabled) → no callback.
//      - Overlay click → onCancel.
//      - Content click does NOT bubble to overlay cancel.
//
// Implementation notes:
//
// - We mount the real component via @testing-library/svelte's render().
//   No portal escape hatch needed.
//
// - The component sets default focus via queueMicrotask. We use a
//   flushMicrotasks() helper that awaits a chain of resolved Promises
//   + Svelte tick before asserting focus.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import TypeNameConfirmDialog from '../src/components/TypeNameConfirmDialog.svelte';

// ── Helpers ────────────────────────────────────────────────────────────

function makeProps(overrides = {}) {
  return {
    resourceName: 'channel #general',
    requireTypedName: 'general',
    title: 'Delete channel?',
    body: 'This will delete the channel and all its history.',
    confirmLabel: 'Delete',
    severity: 'danger',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

function fireKey(target, key, init = {}) {
  return fireEvent.keyDown(target, { key, bubbles: true, cancelable: true, ...init });
}

// Type a string into a controlled input bound with `bind:value`. We
// dispatch a real input event so Svelte's two-way binding picks it up.
async function typeInto(input, value) {
  await fireEvent.input(input, { target: { value } });
}

afterEach(() => {
  cleanup();
});

// ── 1. Layout / copy ───────────────────────────────────────────────────

describe('TypeNameConfirmDialog: layout / copy', () => {
  it('renders the supplied title, body, and resourceName', () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });

    const title = getByTestId('type-name-confirm-title');
    expect(title.textContent.trim()).toBe('Delete channel?');

    const body = getByTestId('type-name-confirm-body');
    expect(body.textContent).toContain(
      'This will delete the channel and all its history.'
    );

    const resource = getByTestId('type-name-confirm-resource');
    expect(resource.textContent).toContain('channel #general');
  });

  it('falls back to the default title when none is provided', () => {
    const props = makeProps({ title: undefined });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const title = getByTestId('type-name-confirm-title');
    expect(title.textContent.trim()).toBe('Confirm destructive action');
  });

  it('renders the required-typed-name in the prompt', () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const required = getByTestId('type-name-confirm-required');
    // Quoted exactly as the user must type it.
    expect(required.textContent).toBe('"general"');
  });

  it('uses the supplied confirmLabel on the Confirm button', () => {
    const props = makeProps({ confirmLabel: 'Yes, delete' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const confirm = getByTestId('type-name-confirm-confirm');
    expect(confirm.textContent.trim()).toBe('Yes, delete');
  });

  it('falls back to the default confirmLabel when none is provided', () => {
    const props = makeProps({ confirmLabel: undefined });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const confirm = getByTestId('type-name-confirm-confirm');
    expect(confirm.textContent.trim()).toBe('Confirm');
  });
});

// ── 2. The disabled-until-match gate ───────────────────────────────────

describe('TypeNameConfirmDialog: disabled-until-match gate', () => {
  it('Confirm is disabled when the input is empty (initial state)', () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const confirm = getByTestId('type-name-confirm-confirm');
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
  });

  it('Confirm stays disabled on a partial-prefix match', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const input = getByTestId('type-name-confirm-input');
    const confirm = getByTestId('type-name-confirm-confirm');

    await typeInto(input, 'gene');
    await tick();
    expect(confirm.hasAttribute('disabled')).toBe(true);
  });

  it('Confirm stays disabled on a case mismatch (case-sensitive)', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const input = getByTestId('type-name-confirm-input');
    const confirm = getByTestId('type-name-confirm-confirm');

    await typeInto(input, 'General');
    await tick();
    expect(confirm.hasAttribute('disabled')).toBe(true);
  });

  it('Confirm enables when the input exactly matches requireTypedName', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const input = getByTestId('type-name-confirm-input');
    const confirm = getByTestId('type-name-confirm-confirm');

    await typeInto(input, 'general');
    await tick();
    expect(confirm.hasAttribute('disabled')).toBe(false);
    expect(confirm.getAttribute('aria-disabled')).toBe('false');
  });

  it('Confirm re-disables when the user edits back to a mismatch', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const input = getByTestId('type-name-confirm-input');
    const confirm = getByTestId('type-name-confirm-confirm');

    await typeInto(input, 'general');
    await tick();
    expect(confirm.hasAttribute('disabled')).toBe(false);

    // Backspace to a partial match — Confirm must re-disable.
    await typeInto(input, 'gener');
    await tick();
    expect(confirm.hasAttribute('disabled')).toBe(true);
  });

  it('Confirm matches a hashed name when the caller requires the # prefix', async () => {
    const props = makeProps({
      resourceName: 'channel #general',
      requireTypedName: '#general',
    });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const input = getByTestId('type-name-confirm-input');
    const confirm = getByTestId('type-name-confirm-confirm');

    // Without the prefix → still disabled.
    await typeInto(input, 'general');
    await tick();
    expect(confirm.hasAttribute('disabled')).toBe(true);

    // With the prefix → enabled.
    await typeInto(input, '#general');
    await tick();
    expect(confirm.hasAttribute('disabled')).toBe(false);
  });
});

// ── 3. A11y + keyboard ─────────────────────────────────────────────────

describe('TypeNameConfirmDialog: a11y / keyboard', () => {
  it('declares role=dialog, aria-modal, and a resolvable aria-labelledby', () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const dialog = getByTestId('type-name-confirm-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const labelled = document.getElementById(labelId);
    expect(labelled).not.toBeNull();
    expect(labelled.textContent).toContain('Delete channel');
  });

  it('default focus lands on Cancel (NOT the destructive Confirm)', async () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    await flushMicrotasks();
    const cancel = getByTestId('type-name-confirm-cancel');
    expect(document.activeElement).toBe(cancel);
  });

  it('Escape on the dialog calls onCancel, never onConfirm', async () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    await flushMicrotasks();
    const dialog = getByTestId('type-name-confirm-dialog');
    fireKey(dialog, 'Escape');
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('Enter on the Confirm button (when enabled) calls onConfirm', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    await flushMicrotasks();
    const input = getByTestId('type-name-confirm-input');
    const confirm = getByTestId('type-name-confirm-confirm');

    await typeInto(input, 'general');
    await tick();
    confirm.focus();
    fireKey(confirm, 'Enter');
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('Enter on the Confirm button (when disabled) does NOT call onConfirm', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    await flushMicrotasks();
    const confirm = getByTestId('type-name-confirm-confirm');
    // No typing — gate is closed.
    confirm.focus();
    fireKey(confirm, 'Enter');
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('Enter on the input does NOT call onConfirm even when the match holds', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    await flushMicrotasks();
    const input = getByTestId('type-name-confirm-input');

    await typeInto(input, 'general');
    await tick();
    input.focus();
    fireKey(input, 'Enter');
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
});

// ── 4. Click wiring ────────────────────────────────────────────────────

describe('TypeNameConfirmDialog: click wiring', () => {
  it('clicking Cancel calls onCancel', async () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    await fireEvent.click(getByTestId('type-name-confirm-cancel'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('clicking Confirm (when enabled) calls onConfirm', async () => {
    const props = makeProps({ requireTypedName: 'general' });
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    const input = getByTestId('type-name-confirm-input');
    await typeInto(input, 'general');
    await tick();
    await fireEvent.click(getByTestId('type-name-confirm-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('clicking Confirm (when disabled) does NOT call onConfirm', async () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    // No typing — Confirm stays disabled. The `disabled` attribute
    // makes the browser swallow the click for real users, and we
    // also guard programmatic dispatch via canConfirm. Verify the
    // guard fires even if a test bypasses the disabled attribute.
    const confirm = getByTestId('type-name-confirm-confirm');
    expect(confirm.hasAttribute('disabled')).toBe(true);
    // Force-fire the click (testing-library does not block disabled).
    await fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('clicking the overlay calls onCancel', async () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    await fireEvent.click(getByTestId('type-name-confirm-overlay'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog content does NOT bubble to overlay cancel', async () => {
    const props = makeProps();
    const { getByTestId } = render(TypeNameConfirmDialog, { props });
    // Click the body region (not a button) — the content's
    // stopPropagation should prevent the overlay click handler from
    // firing.
    await fireEvent.click(getByTestId('type-name-confirm-body'));
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
