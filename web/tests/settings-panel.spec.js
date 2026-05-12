// Tests for SettingsPanel.svelte's display-name wiring (UX G-9
// showstopper). Pre-1.9, `handleNameChange` wrote to `store.userProfile`
// + localStorage only — never invoked `comms_update_name`, so renames
// were silently local. Step 1.9 wires the panel to `api.updateName`,
// adds a 500ms debounce, an offline guard, an inline status indicator
// (Saving / Saved / Error / blocked), and reverts the input on failure.
//
// These tests exercise:
//   1. Disconnected state blocks the backend call + surfaces "Cannot
//      rename while disconnected. Reconnect first."
//   2. Connected state: typing into the input fires updateName exactly
//      once, AFTER the 500ms debounce — not before.
//   3. Successful backend response updates `store.userProfile.name`.
//   4. Failure response reverts the input + surfaces "Error: <reason>".
//   5. `nameUnset` flips false on a successful rename.
//
// Notes:
// - The component imports `updateName` from `../lib/api.js`, so we
//   `vi.mock` that module path BEFORE importing the component. The
//   mock factory exports both `updateName` and the other helpers the
//   real module ships (in case any future re-export ripples in), so we
//   never accidentally pull the real fetch path during tests.
// - `vi.useFakeTimers()` is required to deterministically advance the
//   500ms debounce window without sleeping.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

// SettingsPanel reads `Notification.permission` at component-init time
// to seed the desktop-notifications toggle. JSDOM does not ship the
// Notifications API, so without this stub the component throws
// ReferenceError before render. Stub it before importing the component
// so the module's top-level code can see it.
if (typeof globalThis.Notification === 'undefined') {
  globalThis.Notification = /** @type {any} */ ({
    permission: 'default',
    requestPermission: vi.fn(() => Promise.resolve('default')),
  });
}

// Module mock must be hoisted -- vitest does this automatically when the
// path is a literal string. The factory returns a fresh `updateName` spy
// per test via re-assignment inside beforeEach.
const updateNameMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  updateName: (...args) => updateNameMock(...args),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
}));

import SettingsPanel from '../src/components/SettingsPanel.svelte';

function makeStore(overrides = {}) {
  return {
    connected: true,
    inAppToasts: true,
    brokerUrl: 'ws://localhost:9001',
    userProfile: { key: 'me-key', name: 'Original', type: 'human' },
    nameUnset: false,
    ...overrides,
  };
}

async function typeInto(input, value) {
  input.value = value;
  await fireEvent.input(input, { target: input });
  await tick();
}

afterEach(() => {
  cleanup();
  updateNameMock.mockReset();
});

describe('SettingsPanel — UX G-9 rename wiring', () => {
  describe('offline gate', () => {
    it('blocks the backend call when store.connected is false', async () => {
      const store = makeStore({ connected: false });
      const { getByLabelText, getByTestId } = render(SettingsPanel, {
        props: {
          store,
          theme: 'dark',
          onClose: vi.fn(),
          onToggleTheme: vi.fn(),
        },
      });

      const input = getByLabelText('Display Name');
      await typeInto(input, 'NewName');

      // The disconnected guard surfaces the "Cannot rename..." copy
      // immediately, BEFORE any debounce window — the offline path
      // short-circuits.
      const status = getByTestId('settings-name-status');
      expect(status.getAttribute('data-status-kind')).toBe('blocked');
      expect(status.textContent.trim()).toBe(
        'Cannot rename while disconnected. Reconnect first.'
      );

      // updateName must not have been called at all.
      expect(updateNameMock).not.toHaveBeenCalled();

      // store.userProfile.name remains the original — no localStorage
      // shortcut while offline.
      expect(store.userProfile.name).toBe('Original');
    });
  });

  describe('debounce window', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('only calls updateName after the 500ms debounce expires', async () => {
      updateNameMock.mockResolvedValue({
        success: true,
        name: 'NewName',
        key: 'me-key',
      });

      const store = makeStore();
      const { getByLabelText } = render(SettingsPanel, {
        props: {
          store,
          theme: 'dark',
          onClose: vi.fn(),
          onToggleTheme: vi.fn(),
        },
      });

      const input = getByLabelText('Display Name');
      // Fire the input event — debounce schedules a setTimeout under
      // fake timers.
      input.value = 'NewName';
      await fireEvent.input(input, { target: input });

      // 400ms in — debounce has NOT yet fired.
      await vi.advanceTimersByTimeAsync(400);
      expect(updateNameMock).not.toHaveBeenCalled();

      // Cross the 500ms boundary. setTimeout fires; updateName is
      // invoked with (key, newName).
      await vi.advanceTimersByTimeAsync(150);
      expect(updateNameMock).toHaveBeenCalledTimes(1);
      expect(updateNameMock).toHaveBeenCalledWith('me-key', 'NewName');
    });

    it('coalesces rapid keystrokes into a single backend call', async () => {
      updateNameMock.mockResolvedValue({
        success: true,
        name: 'Phil',
        key: 'me-key',
      });

      const store = makeStore();
      const { getByLabelText } = render(SettingsPanel, {
        props: {
          store,
          theme: 'dark',
          onClose: vi.fn(),
          onToggleTheme: vi.fn(),
        },
      });

      const input = getByLabelText('Display Name');
      // Simulate three rapid keystrokes within the debounce window.
      for (const partial of ['P', 'Ph', 'Phi', 'Phil']) {
        input.value = partial;
        await fireEvent.input(input, { target: input });
        await vi.advanceTimersByTimeAsync(100);
      }

      // Even after 400ms of rapid typing, the timer keeps getting
      // reset — still no call.
      expect(updateNameMock).not.toHaveBeenCalled();

      // Now sit idle past the 500ms boundary from the LAST keystroke.
      await vi.advanceTimersByTimeAsync(600);
      expect(updateNameMock).toHaveBeenCalledTimes(1);
      expect(updateNameMock).toHaveBeenCalledWith('me-key', 'Phil');
    });
  });

  describe('successful rename', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('updates store.userProfile.name and clears nameUnset on success', async () => {
      updateNameMock.mockResolvedValue({
        success: true,
        name: 'Phil',
        key: 'me-key',
      });

      const store = makeStore({
        nameUnset: true,
        userProfile: { key: 'me-key', name: '(unset)', type: 'human' },
      });
      const { getByLabelText, getByTestId } = render(SettingsPanel, {
        props: {
          store,
          theme: 'dark',
          onClose: vi.fn(),
          onToggleTheme: vi.fn(),
        },
      });

      const input = getByLabelText('Display Name');
      input.value = 'Phil';
      await fireEvent.input(input, { target: input });

      // Cross the debounce window so updateName fires. Then await the
      // mock promise resolution + Svelte's microtask flush. We do NOT
      // call `runAllTimersAsync` because the SAVED_FADE_MS (1500ms)
      // timer would expire and flip the status back to "idle" before
      // the assertion -- we want to observe the post-success state
      // BEFORE the fade.
      await vi.advanceTimersByTimeAsync(500);
      // Yield to the resolved updateName promise.
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      // Store reflects the server-confirmed name and the nameUnset
      // gate has lifted.
      expect(store.userProfile.name).toBe('Phil');
      expect(store.nameUnset).toBe(false);

      // Inline status shows "Saved" while the fade timer is pending.
      const status = getByTestId('settings-name-status');
      expect(status.getAttribute('data-status-kind')).toBe('saved');
      expect(status.textContent.trim()).toBe('Saved');
    });
  });

  describe('failed rename', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reverts the input and surfaces the error message on failure', async () => {
      updateNameMock.mockResolvedValue({
        success: false,
        error: 'Invalid name "bad/name".',
      });

      const store = makeStore();
      const { getByLabelText, getByTestId } = render(SettingsPanel, {
        props: {
          store,
          theme: 'dark',
          onClose: vi.fn(),
          onToggleTheme: vi.fn(),
        },
      });

      const input = getByLabelText('Display Name');
      input.value = 'bad/name';
      await fireEvent.input(input, { target: input });

      // Cross the debounce window; await the rejected updateName
      // promise. Do NOT flush all timers -- ERROR_FADE_MS (3000ms)
      // would clear the status back to idle before assertion.
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
      await tick();

      // Backend was called.
      expect(updateNameMock).toHaveBeenCalledTimes(1);
      expect(updateNameMock).toHaveBeenCalledWith('me-key', 'bad/name');

      // Store unchanged — the rename never landed.
      expect(store.userProfile.name).toBe('Original');

      // The visible input reverts to the last-saved name. Svelte 5 re-
      // renders the `value={displayName}` binding after we reset
      // displayName in the failure branch, so the DOM property syncs.
      expect(input.value).toBe('Original');

      // Inline status shows the error.
      const status = getByTestId('settings-name-status');
      expect(status.getAttribute('data-status-kind')).toBe('error');
      expect(status.textContent.trim()).toBe(
        'Error: Invalid name "bad/name".'
      );
    });

    it('does not flip nameUnset when the server rejects the rename', async () => {
      updateNameMock.mockResolvedValue({
        success: false,
        error: 'Server overloaded.',
      });

      const store = makeStore({
        nameUnset: true,
        userProfile: { key: 'me-key', name: '(unset)', type: 'human' },
      });
      const { getByLabelText } = render(SettingsPanel, {
        props: {
          store,
          theme: 'dark',
          onClose: vi.fn(),
          onToggleTheme: vi.fn(),
        },
      });

      const input = getByLabelText('Display Name');
      input.value = 'Phil';
      await fireEvent.input(input, { target: input });

      await vi.advanceTimersByTimeAsync(600);
      await vi.runAllTimersAsync();
      await tick();

      expect(store.nameUnset).toBe(true);
      expect(store.userProfile.name).toBe('(unset)');
    });
  });
});
