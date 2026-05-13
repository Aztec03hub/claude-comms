// keyboard.spec.js — v0.4.0 Step 2.17.
//
// Covers the central KeyboardRegistry module:
//   - Combo serialization (Ctrl/Alt/Shift order, lower-case key, lone
//     modifier suppression, multi-char keys like Escape stay canonical).
//   - normalizeCombo accepts a variety of human inputs and round-trips
//     to the canonical form.
//   - Bindings fire when matching combos are dispatched; preventDefault
//     fires; non-matching combos pass through silently.
//   - Focus-context rule: non-Escape bindings are SUPPRESSED when the
//     event target is an INPUT / TEXTAREA / contenteditable element;
//     Escape always fires (universal close).
//   - register / unregister / setDescription / destroy semantics.
//   - End-to-end window keydown integration (the registry installs its
//     own window listener; dispatching a real KeyboardEvent from the
//     window should hit the registered handler).
//
// Plan refs: Step 2.17 of v0.4.0 — see
// .worklogs/architecture-and-orchestration-plan.md Part II §III.4
// around line 1901.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  KeyboardRegistry,
  createKeyboardRegistry,
  resetKeyboardRegistry,
  serializeCombo,
  normalizeCombo,
  isEditableTarget,
} from '../src/lib/keyboard.svelte.js';

/**
 * Build a minimal KeyboardEvent stand-in that satisfies the registry's
 * dispatch path. Using a plain object (rather than `new KeyboardEvent`)
 * keeps the suite framework-agnostic and lets us assert against the
 * `preventDefault` mock without jsdom plumbing.
 */
function makeKeyEvent({
  key,
  ctrlKey = false,
  altKey = false,
  shiftKey = false,
  metaKey = false,
  target = null,
} = {}) {
  return {
    key,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey,
    target,
    preventDefault: vi.fn(),
  };
}

// ── serializeCombo ────────────────────────────────────────────────────

describe('serializeCombo', () => {
  it('returns Ctrl+<key> for plain ctrlKey + printable key', () => {
    expect(serializeCombo(makeKeyEvent({ key: 'l', ctrlKey: true }))).toBe('Ctrl+l');
  });

  it('lower-cases single printable keys so Shift-cased aliases collide', () => {
    // Browser fires { key: 'L', ctrlKey: true, shiftKey: true } for
    // Ctrl+Shift+L. We canonicalize the key portion to 'l' but keep the
    // Shift modifier in the prefix.
    expect(
      serializeCombo(makeKeyEvent({ key: 'L', ctrlKey: true, shiftKey: true })),
    ).toBe('Ctrl+Shift+l');
  });

  it('preserves canonical casing for multi-char keys (Escape, ArrowUp)', () => {
    expect(serializeCombo(makeKeyEvent({ key: 'Escape' }))).toBe('Escape');
    expect(serializeCombo(makeKeyEvent({ key: 'ArrowUp' }))).toBe('ArrowUp');
  });

  it('emits modifiers in Ctrl+Alt+Shift+<key> order regardless of input', () => {
    expect(
      serializeCombo(
        makeKeyEvent({
          key: 'k',
          shiftKey: true,
          altKey: true,
          ctrlKey: true,
        }),
      ),
    ).toBe('Ctrl+Alt+Shift+k');
  });

  it('treats metaKey (macOS Cmd) as Ctrl so Cmd+L matches Ctrl+L', () => {
    expect(serializeCombo(makeKeyEvent({ key: 'l', metaKey: true }))).toBe('Ctrl+l');
  });

  it('returns empty string for lone modifier keypresses', () => {
    expect(serializeCombo(makeKeyEvent({ key: 'Control', ctrlKey: true }))).toBe('');
    expect(serializeCombo(makeKeyEvent({ key: 'Shift', shiftKey: true }))).toBe('');
    expect(serializeCombo(makeKeyEvent({ key: 'Alt', altKey: true }))).toBe('');
    expect(serializeCombo(makeKeyEvent({ key: 'Meta', metaKey: true }))).toBe('');
  });

  it('returns empty string when the event has no key', () => {
    expect(serializeCombo(makeKeyEvent({ key: '' }))).toBe('');
    expect(serializeCombo(null)).toBe('');
  });
});

// ── normalizeCombo ────────────────────────────────────────────────────

describe('normalizeCombo', () => {
  it('canonicalizes Ctrl+L, ctrl+L, and ctrl+l to the same key', () => {
    expect(normalizeCombo('Ctrl+L')).toBe('Ctrl+l');
    expect(normalizeCombo('ctrl+L')).toBe('Ctrl+l');
    expect(normalizeCombo('ctrl+l')).toBe('Ctrl+l');
  });

  it('accepts Cmd / Meta as aliases for Ctrl', () => {
    expect(normalizeCombo('Cmd+L')).toBe('Ctrl+l');
    expect(normalizeCombo('Meta+L')).toBe('Ctrl+l');
  });

  it('accepts Option as alias for Alt', () => {
    expect(normalizeCombo('Option+1')).toBe('Alt+1');
  });

  it('preserves multi-char keys (Escape)', () => {
    expect(normalizeCombo('Escape')).toBe('Escape');
  });

  it('reorders modifiers to canonical Ctrl+Alt+Shift order', () => {
    expect(normalizeCombo('Shift+Alt+Ctrl+k')).toBe('Ctrl+Alt+Shift+k');
  });

  it('returns empty string for invalid / empty inputs', () => {
    expect(normalizeCombo('')).toBe('');
    expect(normalizeCombo(null)).toBe('');
    expect(normalizeCombo('Ctrl+')).toBe(''); // no key portion
  });
});

// ── isEditableTarget ─────────────────────────────────────────────────

describe('isEditableTarget', () => {
  it('returns true for INPUT, TEXTAREA, SELECT, and contenteditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT', isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT', isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('returns false for non-editable elements and nullish targets', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

// ── KeyboardRegistry behaviour ──────────────────────────────────────

describe('KeyboardRegistry: register + dispatch', () => {
  /** @type {KeyboardRegistry} */
  let registry;

  beforeEach(() => {
    registry = createKeyboardRegistry();
  });

  afterEach(() => {
    registry.destroy();
  });

  it('fires the registered handler for an exact-match combo', () => {
    const handler = vi.fn();
    registry.register('Ctrl+L', handler);
    const fired = registry.dispatch(makeKeyEvent({ key: 'l', ctrlKey: true }));
    expect(fired).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('calls preventDefault on the event when a binding fires', () => {
    const handler = vi.fn();
    registry.register('Ctrl+L', handler);
    const event = makeKeyEvent({ key: 'l', ctrlKey: true });
    registry.dispatch(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('returns false and does NOT preventDefault when no binding matches', () => {
    const event = makeKeyEvent({ key: 'q', ctrlKey: true });
    const fired = registry.dispatch(event);
    expect(fired).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('treats Ctrl+L and Ctrl+Shift+L as DIFFERENT bindings', () => {
    const plain = vi.fn();
    const shifted = vi.fn();
    registry.register('Ctrl+L', plain);
    registry.register('Ctrl+Shift+L', shifted);

    registry.dispatch(makeKeyEvent({ key: 'l', ctrlKey: true }));
    expect(plain).toHaveBeenCalledTimes(1);
    expect(shifted).not.toHaveBeenCalled();

    registry.dispatch(makeKeyEvent({ key: 'L', ctrlKey: true, shiftKey: true }));
    expect(plain).toHaveBeenCalledTimes(1);
    expect(shifted).toHaveBeenCalledTimes(1);
  });

  it('re-registering the same combo replaces the previous handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    registry.register('Ctrl+L', first);
    registry.register('Ctrl+L', second);
    registry.dispatch(makeKeyEvent({ key: 'l', ctrlKey: true }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unregister removes the binding (subsequent dispatches no-op)', () => {
    const handler = vi.fn();
    registry.register('Ctrl+L', handler);
    registry.unregister('Ctrl+L');
    const fired = registry.dispatch(makeKeyEvent({ key: 'l', ctrlKey: true }));
    expect(fired).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects malformed register() args silently', () => {
    expect(() => registry.register('', () => {})).not.toThrow();
    expect(() => registry.register('Ctrl+L', null)).not.toThrow();
    // No binding stored — dispatch should still no-op.
    const fired = registry.dispatch(makeKeyEvent({ key: 'l', ctrlKey: true }));
    expect(fired).toBe(false);
  });

  it('setDescription stores the label without altering the handler', () => {
    const handler = vi.fn();
    registry.register('Ctrl+L', handler);
    registry.setDescription('Ctrl+L', 'Open channel directory');
    expect(registry.descriptions['Ctrl+l']).toBe('Open channel directory');
    registry.dispatch(makeKeyEvent({ key: 'l', ctrlKey: true }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('register() with opts.description records the label', () => {
    registry.register('Ctrl+N', () => {}, { description: 'Create channel' });
    expect(registry.descriptions['Ctrl+n']).toBe('Create channel');
  });
});

// ── Focus-context rule ───────────────────────────────────────────────

describe('KeyboardRegistry: focus-context rule', () => {
  /** @type {KeyboardRegistry} */
  let registry;

  beforeEach(() => {
    registry = createKeyboardRegistry();
  });

  afterEach(() => {
    registry.destroy();
  });

  it('suppresses non-Escape bindings when target is an INPUT', () => {
    const handler = vi.fn();
    registry.register('Ctrl+L', handler);
    const event = makeKeyEvent({
      key: 'l',
      ctrlKey: true,
      target: { tagName: 'INPUT', isContentEditable: false },
    });
    const fired = registry.dispatch(event);
    expect(fired).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // Crucially: we DON'T preventDefault, so the user's typing isn't lost.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('suppresses non-Escape bindings when target is a TEXTAREA', () => {
    const handler = vi.fn();
    registry.register('?', handler);
    const event = makeKeyEvent({
      key: '?',
      shiftKey: true,
      target: { tagName: 'TEXTAREA', isContentEditable: false },
    });
    const fired = registry.dispatch(event);
    expect(fired).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('suppresses non-Escape bindings when target is contenteditable', () => {
    const handler = vi.fn();
    registry.register('Alt+1', handler);
    const event = makeKeyEvent({
      key: '1',
      altKey: true,
      target: { tagName: 'DIV', isContentEditable: true },
    });
    expect(registry.dispatch(event)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('Escape ALWAYS fires regardless of focus context', () => {
    const handler = vi.fn();
    registry.register('Escape', handler);
    const event = makeKeyEvent({
      key: 'Escape',
      target: { tagName: 'TEXTAREA', isContentEditable: false },
    });
    expect(registry.dispatch(event)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('fires bindings when target is a non-editable element', () => {
    const handler = vi.fn();
    registry.register('?', handler);
    const event = makeKeyEvent({
      key: '?',
      shiftKey: true,
      target: { tagName: 'BODY', isContentEditable: false },
    });
    expect(registry.dispatch(event)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ── Alt+1..9 simulation (jump-to-Nth-channel) ────────────────────────

describe('Alt+1..9 channel-jump pattern', () => {
  /** @type {KeyboardRegistry} */
  let registry;

  beforeEach(() => {
    registry = createKeyboardRegistry();
  });

  afterEach(() => {
    registry.destroy();
  });

  it('registers nine independent Alt+N handlers that select index N-1', () => {
    const channels = [
      { id: 'alpha' },
      { id: 'bravo' },
      { id: 'charlie' },
      { id: 'delta' },
      { id: 'echo' },
      { id: 'foxtrot' },
      { id: 'golf' },
      { id: 'hotel' },
      { id: 'india' },
    ];
    const switched = vi.fn();

    for (let i = 1; i <= 9; i++) {
      const idx = i - 1;
      registry.register(`Alt+${i}`, () => {
        const target = channels[idx];
        if (target) switched(target.id);
      });
    }

    // Hit each binding in sequence; each should switch to the Nth channel.
    for (let i = 1; i <= 9; i++) {
      registry.dispatch(makeKeyEvent({ key: String(i), altKey: true }));
    }

    expect(switched).toHaveBeenCalledTimes(9);
    expect(switched).toHaveBeenNthCalledWith(1, 'alpha');
    expect(switched).toHaveBeenNthCalledWith(5, 'echo');
    expect(switched).toHaveBeenNthCalledWith(9, 'india');
  });

  it('Alt+5 no-ops gracefully when fewer than 5 channels exist', () => {
    const channels = [{ id: 'alpha' }];
    const switched = vi.fn();
    registry.register('Alt+5', () => {
      const target = channels[4];
      if (target) switched(target.id);
    });
    registry.dispatch(makeKeyEvent({ key: '5', altKey: true }));
    expect(switched).not.toHaveBeenCalled();
  });
});

// ── End-to-end window-listener integration ───────────────────────────

describe('KeyboardRegistry: window listener integration', () => {
  beforeEach(() => {
    // Reset the module-level singleton between tests so each spec gets a
    // clean window listener registration.
    resetKeyboardRegistry();
  });

  afterEach(() => {
    resetKeyboardRegistry();
  });

  it('installs a window keydown listener on construction', () => {
    const registry = new KeyboardRegistry();
    const handler = vi.fn();
    registry.register('Ctrl+L', handler);
    // Dispatch a real KeyboardEvent from the window — registry must
    // route it through its dispatch() path.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    registry.destroy();
  });

  it('destroy() removes the window listener (subsequent events no-op)', () => {
    const registry = new KeyboardRegistry();
    const handler = vi.fn();
    registry.register('Ctrl+L', handler);
    registry.destroy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('destroy() is idempotent — calling twice does not throw', () => {
    const registry = new KeyboardRegistry();
    expect(() => {
      registry.destroy();
      registry.destroy();
    }).not.toThrow();
  });
});
