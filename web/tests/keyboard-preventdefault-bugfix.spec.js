// v0.4.4 hotfix - keyboard registry browserIntercept regression coverage.
//
// Phil's Layer B real-browser pass caught Ctrl+N opening Chrome's
// new-window instead of the ChannelModal when typed while focus was in
// the MessageInput. Root cause: the keyboard registry's dispatch path
// suppresses every non-Escape binding when the event target is an
// editable element (INPUT / TEXTAREA / contenteditable) per §III.4 step
// 2.17 focus rule. The suppression returns ``false`` BEFORE calling
// ``event.preventDefault()``. Browser shortcuts that the page wants to
// silence (Ctrl+N = new window, Ctrl+W = close tab, Ctrl+L = focus
// location bar) therefore proceed to the browser default, and the user
// loses their composer state to a new window opening over the chat.
//
// The v0.4.4 fix adds a per-binding ``browserIntercept: true`` option.
// Bindings registered with that flag call ``event.preventDefault()``
// even when the target is editable. The user handler still respects
// the editable-target rule (typing Ctrl+N inside a textarea shouldn't
// pop the channel modal mid-sentence); only the preventDefault is
// unconditional.
//
// This suite pins:
//   1. browserIntercept=true + editable target → preventDefault fires,
//      handler does NOT fire (the focus rule still applies to the
//      handler).
//   2. browserIntercept=true + non-editable target → preventDefault
//      fires AND handler fires (normal binding behaviour).
//   3. Without browserIntercept (default) + editable target →
//      preventDefault does NOT fire, handler does NOT fire (pre-v0.4.4
//      behaviour preserved for non-intercept bindings).
//   4. unregister clears the browserIntercept flag.
//   5. register without browserIntercept after register WITH it clears
//      the flag (re-registration semantics).
//   6. Source-level pin (P-1): App.svelte's Ctrl+N / Ctrl+L / Ctrl+W /
//      Ctrl+Shift+W registrations carry browserIntercept: true.
//   7. Source-level pin (P-1): the dispatch path's editable-target
//      branch contains an event.preventDefault() call gated on the
//      intercept set.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  createKeyboardRegistry,
} from '../src/lib/keyboard.svelte.js';

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

describe('KeyboardRegistry - v0.4.4 hotfix browserIntercept', () => {
  /** @type {ReturnType<typeof createKeyboardRegistry>} */
  let registry;

  beforeEach(() => {
    registry = createKeyboardRegistry();
  });

  it('browserIntercept=true + editable target: preventDefault fires, handler does NOT', () => {
    const handler = vi.fn();
    registry.register('Ctrl+N', handler, { browserIntercept: true });
    const textarea = { tagName: 'TEXTAREA' };
    const event = makeKeyEvent({
      key: 'n',
      ctrlKey: true,
      target: textarea,
    });
    const fired = registry.dispatch(event);

    // Handler suppressed (editable-target rule still applies).
    expect(handler).not.toHaveBeenCalled();
    expect(fired).toBe(false);
    // But preventDefault DID fire - this is the v0.4.4 fix: blocks
    // the browser's Ctrl+N = new window even when focus is in a
    // textarea.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('browserIntercept=true + non-editable target: preventDefault AND handler fire', () => {
    const handler = vi.fn();
    registry.register('Ctrl+N', handler, { browserIntercept: true });
    const div = { tagName: 'DIV' };
    const event = makeKeyEvent({
      key: 'n',
      ctrlKey: true,
      target: div,
    });
    const fired = registry.dispatch(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fired).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('without browserIntercept + editable target: NEITHER preventDefault NOR handler fire', () => {
    // Pre-v0.4.4 baseline behaviour preserved for non-intercept bindings.
    const handler = vi.fn();
    registry.register('Ctrl+S', handler);
    const input = { tagName: 'INPUT' };
    const event = makeKeyEvent({
      key: 's',
      ctrlKey: true,
      target: input,
    });
    const fired = registry.dispatch(event);

    expect(handler).not.toHaveBeenCalled();
    expect(fired).toBe(false);
    // Crucially, preventDefault does NOT fire - the browser's default
    // (Ctrl+S = save page) proceeds unmolested, which is what we want
    // for shortcuts the page doesn't claim.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('unregister clears the browserIntercept flag', () => {
    const handler = vi.fn();
    registry.register('Ctrl+N', handler, { browserIntercept: true });
    registry.unregister('Ctrl+N');
    // Re-register WITHOUT the flag.
    registry.register('Ctrl+N', handler);
    const textarea = { tagName: 'TEXTAREA' };
    const event = makeKeyEvent({
      key: 'n',
      ctrlKey: true,
      target: textarea,
    });
    registry.dispatch(event);
    // No preventDefault - the flag was cleared by unregister.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('re-register without browserIntercept clears the flag (no leftover state)', () => {
    const handler = vi.fn();
    registry.register('Ctrl+N', handler, { browserIntercept: true });
    // Re-register the same combo WITHOUT browserIntercept - the new
    // registration should reset the flag, not inherit the prior value.
    registry.register('Ctrl+N', handler);
    const input = { tagName: 'INPUT' };
    const event = makeKeyEvent({
      key: 'n',
      ctrlKey: true,
      target: input,
    });
    registry.dispatch(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('source-level pin: App.svelte registers Ctrl+N / Ctrl+L / Ctrl+W / Ctrl+Shift+W with browserIntercept: true', () => {
    // P-1 source regex pin (W-9 mitigation per v0.4.4 iteration log).
    // Bites at edit time so a future refactor cannot drop the flag
    // and silently re-introduce the Chrome-new-window regression.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const APP_SRC = resolve(HERE, '..', 'src', 'App.svelte');
    const src = readFileSync(APP_SRC, 'utf8');

    // Each registration block must contain a ``browserIntercept: true``
    // after the combo string. We assert per-combo so a future commit
    // that drops the flag on one specific binding still trips a test
    // (rather than the suite passing because the flag exists somewhere
    // in the file).
    function blockFor(combo) {
      // The block spans from ``keyboard.register('<combo>'`` to the
      // next call's leading ``keyboard.register(`` or to the closing
      // brace of the surrounding $effect.
      const start = src.indexOf(`keyboard.register('${combo}',`);
      expect(start, `expected App.svelte to register ${combo}`).toBeGreaterThan(0);
      // Slice 900 chars forward - large enough for the longest binding
      // body in App.svelte (Ctrl+W's leaveChannel + promise .catch
      // wiring + the trailing options object is ~700 chars).
      return src.slice(start, start + 900);
    }

    expect(blockFor('Ctrl+N')).toMatch(/browserIntercept:\s*true/);
    expect(blockFor('Ctrl+L')).toMatch(/browserIntercept:\s*true/);
    expect(blockFor('Ctrl+W')).toMatch(/browserIntercept:\s*true/);
    expect(blockFor('Ctrl+Shift+W')).toMatch(/browserIntercept:\s*true/);
  });

  it('source-level pin: dispatch path calls preventDefault() on the editable-target branch when the binding opted in', () => {
    // Belt-and-suspenders pin: ensure the dispatch() body contains a
    // preventDefault() call inside the editable-target branch, gated
    // by the intercept set. Without this, the unit tests above would
    // still pass for the test target but a future refactor of
    // dispatch() could silently lose the preventDefault behaviour.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const KB_SRC = resolve(HERE, '..', 'src', 'lib', 'keyboard.svelte.js');
    const src = readFileSync(KB_SRC, 'utf8');
    const dispatchStart = src.indexOf('  dispatch(event) {');
    expect(dispatchStart).toBeGreaterThan(0);
    const dispatchEnd = src.indexOf('\n  }\n', dispatchStart);
    expect(dispatchEnd).toBeGreaterThan(dispatchStart);
    const body = src.slice(dispatchStart, dispatchEnd);
    // Must reference the browserIntercepts map AND call preventDefault.
    expect(body).toMatch(/#browserIntercepts/);
    expect(body).toMatch(/event\.preventDefault\(\)/);
    // The editable-target branch must contain the conditional
    // preventDefault gated by isBrowserIntercept.
    expect(body).toMatch(/isBrowserIntercept[\s\S]*event\.preventDefault\(\)/);
  });
});
