// v0.4.4 hotfix - ThreadPanel first-mount race regression coverage.
//
// Phil's Layer B real-browser pass against v0.4.3 caught that the FIRST
// open of ThreadPanel for a given message blanked the chat history AND
// failed to show the thread's replies; closing and reopening worked
// correctly. Root cause: ``handleOpenThread`` synchronously mutated
// THREE pieces of state in the same batch:
//
//   threadParent = message;       // (a)
//   showThreadPanel = true;       // (b)
//   store?.markThreadSeen?.(...); // (c) - mutates threadSeenCursors,
//                                 //       a tracked dep of activeMessages
//
// Svelte 5 batches synchronous writes within a single tick. Mid-batch,
// the template re-renders to mount ThreadPanel (the {#if guard flips
// from false to true), and the parent's already-evaluated message-prop
// expression captures whatever activeChannelReplies + activeMessages
// looked like at the moment of evaluation. Concurrent mutation (c)
// causes the activeMessages $derived to invalidate mid-mount, leaving
// ChatView's groupedMessages re-derivation racing against ThreadPanel's
// own first-render reactive subscriptions. On the FIRST mount, the
// derivation graph hasn't yet stabilised; subsequent opens find the
// cursor already populated so (c) is a no-op ref-swap.
//
// Why automated Playwright E2E missed this (W-14 anti-pattern per the
// v0.4.4 iteration log): "Open X" interaction tests don't assert what
// was visible BEFORE the open is STILL visible AFTER. ThreadPanel
// first-open clobbered the chat view; tests passed because they only
// checked thread panel visibility.
//
// The v0.4.4 fix defers ``markThreadSeen`` via ``tick().then(...)`` so
// the cursor advance applies AFTER the DOM has flushed for the mount.
// On stable derivations, the cursor mutation re-derives activeMessages
// to the same effective values (or only the chip's unread count drops
// to 0), which doesn't re-mount anything.
//
// This suite pins:
//   1. handleOpenThread does NOT call markThreadSeen synchronously -
//      the call is deferred to a microtask/tick.
//   2. After tick resolves, markThreadSeen has been called with the
//      expected message id (so the deferral doesn't drop the call
//      entirely).
//   3. Source-level pin: App.svelte's handleOpenThread body contains
//      ``tick().then`` wrapping the markThreadSeen call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

describe('handleOpenThread - v0.4.4 hotfix Bug 7 deferred markThreadSeen', () => {
  it('source-level pin: App.svelte handleOpenThread wraps markThreadSeen in tick().then(...)', () => {
    // P-1 source regex pin (W-14 mitigation per v0.4.4 iteration log).
    // Bites at edit time so a future refactor cannot drop the tick()
    // deferral and silently re-introduce the first-mount race.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const APP_SRC = resolve(HERE, '..', 'src', 'App.svelte');
    const src = readFileSync(APP_SRC, 'utf8');

    const start = src.indexOf('function handleOpenThread(message) {');
    expect(start).toBeGreaterThan(0);
    // Find the function's closing brace by scanning for the next
    // top-level `}` that closes the function. We look for a `\n}`
    // pattern after the opening brace to locate the end robustly,
    // rather than using a fixed-length slice that could silently
    // truncate if the function grows.
    const afterStart = src.indexOf('\n}', start);
    const bodyEnd = afterStart > start ? afterStart + 2 : start + 1500;
    const body = src.slice(start, bodyEnd);
    // The body must contain a tick().then( call.
    expect(body).toMatch(/tick\(\)\.then\(/);
    // And the markThreadSeen CALL (not a comment reference) must be
    // INSIDE the tick().then. Use the call-site regex
    // ``markThreadSeen?.(`` so doc-comments referencing the symbol by
    // name don't match. The tick().then must appear BEFORE the call.
    const tickIdx = body.indexOf('tick().then(');
    const callMatch = body.match(/markThreadSeen\??\.?\(/);
    expect(tickIdx).toBeGreaterThan(0);
    expect(callMatch).not.toBeNull();
    const markCallIdx = callMatch.index;
    expect(markCallIdx).toBeGreaterThan(tickIdx);
    // And the markThreadSeen call argument is the deferred message id,
    // not a hardcoded literal.
    expect(body).toMatch(
      /markThreadSeen\?\.\(message\.id\)|markThreadSeen\(message\.id\)/,
    );
  });

  it('source-level pin: App.svelte imports tick from svelte', () => {
    // Required for the deferral to actually work. Without the import,
    // the regex pin above could match a future refactor that uses a
    // shadowed local variable.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const APP_SRC = resolve(HERE, '..', 'src', 'App.svelte');
    const src = readFileSync(APP_SRC, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\btick\b[^}]*\}\s*from\s*['"]svelte['"]/);
  });

  it('functional: simulating handleOpenThread defers the markThreadSeen call to a microtask', async () => {
    // We can't render App.svelte in isolation easily; instead replicate
    // the function shape and assert the deferral semantics on the
    // exact same pattern (tick().then(() => store.markThreadSeen(id))).
    // This is the runtime invariant the source-pin above protects.
    const { tick } = await import('svelte');
    const store = { markThreadSeen: vi.fn() };
    const message = { id: 'msg-abc' };

    function handleOpenThreadLike(msg) {
      // Mirror the post-fix App.svelte handleOpenThread body -
      // synchronous writes are inert in this isolated test; only the
      // deferred call matters here.
      tick().then(() => {
        store?.markThreadSeen?.(msg.id);
      });
    }

    handleOpenThreadLike(message);
    // Synchronously after the call: markThreadSeen has NOT yet been
    // invoked. This is the property that defends against the first-
    // mount race - the parent's prop-expression evaluation sees the
    // pre-mutation state of threadSeenCursors.
    expect(store.markThreadSeen).not.toHaveBeenCalled();

    // After awaiting tick(), markThreadSeen is invoked.
    await tick();
    // Allow the microtask queue to flush.
    await Promise.resolve();
    expect(store.markThreadSeen).toHaveBeenCalledTimes(1);
    expect(store.markThreadSeen).toHaveBeenCalledWith('msg-abc');
  });

  it('functional: handleOpenThread-like is safe when store.markThreadSeen is missing', async () => {
    // Phil's pre-fix code used ``store?.markThreadSeen?.(message.id)``
    // for defensive null-safety. The deferral must preserve that
    // safety - no throw when the optional chain short-circuits.
    const { tick } = await import('svelte');
    const message = { id: 'msg-xyz' };
    const store = {}; // markThreadSeen missing.

    function handleOpenThreadLike(msg) {
      tick().then(() => {
        store?.markThreadSeen?.(msg.id);
      });
    }

    expect(() => handleOpenThreadLike(message)).not.toThrow();
    await tick();
    await Promise.resolve();
    // No throw; nothing to assert beyond that.
  });
});
