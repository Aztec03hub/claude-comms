// Component tests for ThreadPanel.svelte — UX G-36 / v0.4.2 Step 3.12.
//
// Step 3.12 swaps the pre-3.12 inline `<input type="text">` thread
// composer for a `MessageInput` mount routed through a thread-scoped
// store proxy that stamps `parentMessage.id` as `replyTo` on every send.
// These tests pin:
//
//   1. Legacy-path back-compat: when the panel is mounted without a
//      `store` prop (App.svelte's current call site at the time of this
//      change), the inline composer is used and `onSendReply` fires.
//   2. New-path mount: with a live `store`, the inline composer is
//      replaced by `<MessageInput>` (visible via the
//      `data-testid="message-input"` textarea and the `thread-composer`
//      wrapper).
//   3. Default-path send routes through the thread proxy and ends up
//      calling `store.sendMessage(body, parentMessage.id, opts)` —
//      proving the `replyTo` is rewritten from null to the parent id.
//   4. Slash command `/me` typed in the thread composer routes through
//      the thread proxy too — the synthesized action body lands on
//      `store.sendMessage` with the thread parent stamped.
//   5. Slash command `/help` typed in the thread composer is consumed
//      by the registry without firing a regular send (asserts the
//      slash interception still runs inside threads).
//   6. Explicit `replyTo` (e.g. `/reply <other-uuid>`) is forwarded
//      verbatim — the thread proxy does NOT clobber a non-null
//      `replyTo`. This is the safety case for cross-thread replies
//      typed from inside a thread.
//   7. The legacy panel header (title, reply count, close button) is
//      rendered identically in both composer modes, so the thread
//      UI shell is unchanged.
//
// No em dashes in user-facing assertion text (Standing Rule §I.6 #11).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import ThreadPanel from '../src/components/ThreadPanel.svelte';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SVELTE_PATH = resolve(__dirname, '../src/App.svelte');
const THREAD_PANEL_PATH = resolve(__dirname, '../src/components/ThreadPanel.svelte');

// ── Fixtures ─────────────────────────────────────────────────────────────

const PARENT_ID = '00000000-0000-4000-8000-00000000aaaa';

function makeParent(overrides = {}) {
  return {
    id: PARENT_ID,
    ts: '2026-05-19T01:00:00Z',
    sender: { key: 'phil-key', name: 'phil', type: 'human' },
    body: 'kicking off a thread',
    ...overrides,
  };
}

function makeReplies() {
  return [
    {
      id: '00000000-0000-4000-8000-00000000bbb1',
      ts: '2026-05-19T01:01:00Z',
      sender: { key: 'ember-key', name: 'ember', type: 'agent' },
      body: 'first reply',
      reply_to: PARENT_ID,
    },
  ];
}

/**
 * Build a fake ChatStore with just the surface MessageInput touches
 * (participants, userProfile, composerPrefill, notifyTyping, activeChannel,
 * activeMembers, channelsById, sendMessage) plus the slash-command
 * registry's store callbacks (joinChannel/leaveChannel/...). Each method
 * is a `vi.fn` so individual tests can assert call args.
 */
function makeStore() {
  return {
    participants: {
      'phil-key': {
        key: 'phil-key',
        name: 'phil',
        type: 'human',
        connections: { 'web-1': {} },
      },
      'ember-key': {
        key: 'ember-key',
        name: 'ember',
        type: 'agent',
        connections: { 'agent-1': {} },
      },
    },
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    composerPrefill: null,
    activeChannel: 'general',
    activeMembers: [
      { key: 'phil-key', name: 'phil' },
      { key: 'ember-key', name: 'ember' },
    ],
    channelsById: { general: { id: 'general', starred: false, member: true } },
    sendMessage: vi.fn(),
    notifyTyping: vi.fn(),
    joinChannel: vi.fn().mockResolvedValue({ success: true }),
    leaveChannel: vi.fn().mockReturnValue({
      done: Promise.resolve({ success: true }),
      cancel: () => ({ tooLate: true }),
    }),
    closeChannel: vi.fn().mockReturnValue({
      done: Promise.resolve({ success: true }),
      cancel: () => ({ tooLate: true }),
    }),
    setTopic: vi.fn().mockResolvedValue({ success: true }),
    setStar: vi.fn().mockReturnValue({ success: true }),
    setMute: vi.fn().mockReturnValue({ success: true }),
  };
}

/**
 * Wholesale-set the textarea value (bypass per-char input events). The
 * default-path send + slash-command tests don't need per-keystroke
 * autocomplete state.
 */
async function setText(ta, text) {
  ta.value = text;
  ta.setSelectionRange(text.length, text.length);
  await fireEvent.input(ta, { target: ta });
  await tick();
}

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Legacy-path back-compat
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — legacy onSendReply path (back-compat)', () => {
  test('mount without store renders the inline thread input and fires onSendReply', async () => {
    const onSendReply = vi.fn();
    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: makeReplies(),
        participants: { 'phil-key': {} },
        currentUser: { key: 'phil-key', name: 'phil' },
        onClose,
        onSendReply,
      },
    });

    // Legacy inline composer is mounted; the new MessageInput textarea is NOT.
    const legacyInput = getByTestId('thread-reply-input');
    expect(legacyInput).toBeTruthy();
    expect(queryByTestId('thread-composer')).toBeNull();
    expect(queryByTestId('message-input')).toBeNull();
    expect(getByTestId('thread-input-legacy')).toBeTruthy();

    // Typing + Enter routes through onSendReply (no MessageInput involved).
    legacyInput.value = 'hello from legacy';
    await fireEvent.input(legacyInput, { target: legacyInput });
    await fireEvent.keyDown(legacyInput, { key: 'Enter' });
    await tick();

    expect(onSendReply).toHaveBeenCalledTimes(1);
    expect(onSendReply).toHaveBeenCalledWith('hello from legacy');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. New-path mount — MessageInput is the composer
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — MessageInput composer (3.12)', () => {
  test('mount with store renders MessageInput and hides the legacy input', async () => {
    const store = makeStore();
    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        participants: store.participants,
        currentUser: store.userProfile,
        onClose,
        store,
        channelName: 'general',
        typingUsers: [],
        onOpenEmoji: () => {},
      },
    });

    expect(getByTestId('thread-composer')).toBeTruthy();
    expect(getByTestId('message-input')).toBeTruthy();
    // Legacy inline composer is NOT rendered.
    expect(queryByTestId('thread-input-legacy')).toBeNull();
    expect(queryByTestId('thread-reply-input')).toBeNull();
  });

  test('default-path send rewrites replyTo to the thread parent id', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const ta = getByTestId('message-input');
    await setText(ta, 'reply via shared composer');
    const sendBtn = getByTestId('send-button');
    await fireEvent.click(sendBtn);
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    const [body, replyTo, opts] = store.sendMessage.mock.calls[0];
    expect(body).toBe('reply via shared composer');
    // The thread proxy stamped the parent id even though MessageInput
    // passed null.
    expect(replyTo).toBe(PARENT_ID);
    // The autocomplete-path options envelope was preserved.
    expect(opts).toBeDefined();
    expect(opts.recipients).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Slash commands inside a thread composer
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — slash commands in the thread composer', () => {
  test('/me action body is sent with replyTo rewritten to thread parent', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const ta = getByTestId('message-input');
    await setText(ta, '/me waves at the thread');
    const sendBtn = getByTestId('send-button');
    await fireEvent.click(sendBtn);
    // The slash registry handler is async; flush.
    await tick();
    await Promise.resolve();
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    const [body, replyTo, opts] = store.sendMessage.mock.calls[0];
    // Registry strips the leading "/me " and emits a sendAs envelope
    // with `type: 'action'` and `body: 'waves at the thread'`.
    expect(body).toBe('waves at the thread');
    expect(replyTo).toBe(PARENT_ID);
    expect(opts).toBeDefined();
    expect(opts.kind).toBe('action');
  });

  test('/help is consumed by the registry and does NOT call store.sendMessage', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    // Listen for the requestToast CustomEvent — /help surfaces its
    // command list via the registry's `ok` envelope, which MessageInput
    // routes to a requestToast.
    const toastEvents = [];
    const onToast = (e) => toastEvents.push(e);
    document.addEventListener('requestToast', onToast);

    try {
      const ta = getByTestId('message-input');
      await setText(ta, '/help');
      const sendBtn = getByTestId('send-button');
      await fireEvent.click(sendBtn);
      // /help runs through the async registry handler.
      await tick();
      await Promise.resolve();
      await tick();

      // No regular outbound send fired — /help is a side-effect only.
      expect(store.sendMessage).not.toHaveBeenCalled();
      // The toast event carried the registry's `ok` payload (an
      // "Available commands:" string).
      expect(toastEvents.length).toBeGreaterThanOrEqual(1);
      const detail = toastEvents[0].detail;
      expect(detail.kind).toBe('info');
      expect(typeof detail.text).toBe('string');
      expect(detail.text).toContain('Available commands');
    } finally {
      document.removeEventListener('requestToast', onToast);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Explicit replyTo is forwarded verbatim (safety case)
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — explicit replyTo is forwarded verbatim', () => {
  test('thread proxy does not clobber a non-null replyTo passed by MessageInput', async () => {
    const store = makeStore();
    const otherId = '00000000-0000-4000-8000-00000000cccc';
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    // Drive the proxy directly via the threadStore exposed through
    // MessageInput's store prop. We assert proxy semantics by invoking
    // `sendMessage` via a side door — call `store.sendMessage` through
    // the rendered MessageInput's `/reply <uuid>` parser path.
    const ta = getByTestId('message-input');
    await setText(ta, `/reply ${otherId} cross-thread ping`);
    const sendBtn = getByTestId('send-button');
    await fireEvent.click(sendBtn);
    await tick();
    await Promise.resolve();
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    const [body, replyTo] = store.sendMessage.mock.calls[0];
    expect(body).toBe('cross-thread ping');
    // Explicit /reply id wins; the proxy did NOT rewrite it to PARENT_ID.
    expect(replyTo).toBe(otherId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Shell preservation — header / replies render identically in both modes
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — shell unchanged across composer modes', () => {
  test('header, reply count, close button render in MessageInput mode', async () => {
    const store = makeStore();
    const onClose = vi.fn();
    const { getByTestId, getByText } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: makeReplies(),
        onClose,
        store,
        channelName: 'general',
      },
    });

    // The panel + close button + reply-count chip are all present.
    expect(getByTestId('thread-panel')).toBeTruthy();
    expect(getByText('1 replies')).toBeTruthy();
    const closeBtn = getByTestId('thread-panel-close');
    expect(closeBtn).toBeTruthy();

    await fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. v0.4.2 follow-up: scrollbar overflow on the replies list
// ─────────────────────────────────────────────────────────────────────────
//
// Issue 2 of the follow-up: the thread replies container previously
// didn't scroll when reply content overflowed the visible area. The fix
// adds `min-height: 0` alongside `flex: 1 1 0; overflow-y: auto` on
// `.thread-replies` (the classic flex-child scrollbar fix), and anchors
// the header/parent/composer with `flex-shrink: 0` so the replies
// container is the only flex item that absorbs free space.
//
// These tests pin both the structural marker (the class with
// overflow-y: auto is mounted) and the computed style after layout, so
// a future refactor that drops the overflow rule fails loudly.

describe('ThreadPanel — replies list scrolls on overflow (v0.4.2 follow-up)', () => {
  test('.thread-replies mounts when overflowing AND its CSS rule declares overflow-y: auto + min-height: 0', async () => {
    const store = makeStore();
    const manyReplies = Array.from({ length: 25 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000reply${i.toString().padStart(2, '0')}`,
      ts: '2026-05-19T01:01:00Z',
      sender: { key: 'ember-key', name: 'ember', type: 'agent' },
      body: `overflow reply number ${i} — long enough to need a scrollbar when 25 of them stack`,
      reply_to: PARENT_ID,
    }));

    const { container } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: manyReplies,
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    // Structural marker: the scrollable container is in the DOM and
    // actually contains the 25 reply nodes.
    const repliesEl = container.querySelector('.thread-replies');
    expect(repliesEl).toBeTruthy();
    const renderedReplies = repliesEl.querySelectorAll('.thread-reply');
    expect(renderedReplies.length).toBe(25);

    // CSS contract: jsdom doesn't apply Svelte's scoped <style> via
    // getComputedStyle reliably, so we assert the contract from the
    // component source. A regression that drops either declaration
    // (`overflow-y: auto` or the load-bearing `min-height: 0`) fails
    // this test immediately, before the build can ship a non-scrolling
    // panel to users.
    const src = readFileSync(THREAD_PANEL_PATH, 'utf-8');
    const styleStart = src.lastIndexOf('<style>');
    const styleEnd = src.lastIndexOf('</style>');
    expect(styleStart).toBeGreaterThan(-1);
    expect(styleEnd).toBeGreaterThan(styleStart);
    const styleBlock = src.slice(styleStart, styleEnd);

    // Slice the .thread-replies rule (from selector to closing brace).
    const rulePattern = /\.thread-replies\s*\{[^}]*\}/;
    const ruleMatch = styleBlock.match(rulePattern);
    expect(ruleMatch).not.toBeNull();
    const ruleBody = ruleMatch[0];

    expect(ruleBody).toMatch(/overflow-y:\s*auto/);
    // `min-height: 0` is the load-bearing flex fix; without it the
    // flex child can't shrink below its content height and the
    // scrollbar never engages even with overflow-y: auto set.
    expect(ruleBody).toMatch(/min-height:\s*0/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. v0.4.2 follow-up: visible close button affordance
// ─────────────────────────────────────────────────────────────────────────
//
// Issue 3 of the follow-up: users reported no visible close affordance
// on the panel. The button exists at thread-panel-close (Step 3.12
// already shipped it) and is unaffected by composer mode. These tests
// pin two aspects that make the affordance discoverable:
//
//   - It is actually mounted in the legacy path too (regression guard
//     so a future cleanup doesn't accidentally bury it behind the
//     useSharedComposer gate).
//   - Click fires the onClose callback in BOTH composer modes.

describe('ThreadPanel — visible close button (v0.4.2 follow-up)', () => {
  test('close button is present and click fires onClose in the legacy path', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: makeReplies(),
        onClose,
        onSendReply: () => {},
      },
    });

    const closeBtn = getByTestId('thread-panel-close');
    expect(closeBtn).toBeTruthy();
    // The button MUST carry an accessible name so keyboard / screen-reader
    // users can discover it.
    expect(closeBtn.getAttribute('aria-label')).toBe('Close thread panel');

    await fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('close button is present and click fires onClose in the MessageInput path', async () => {
    const store = makeStore();
    const onClose = vi.fn();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: makeReplies(),
        onClose,
        store,
        channelName: 'general',
      },
    });

    const closeBtn = getByTestId('thread-panel-close');
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.getAttribute('aria-label')).toBe('Close thread panel');

    await fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. v0.4.2 follow-up: App.svelte mount uses the shared composer path
// ─────────────────────────────────────────────────────────────────────────
//
// Issue 1 of the follow-up: App.svelte previously mounted ThreadPanel
// with the legacy `onSendReply={...}` callback (Step 3.12 left this
// for a follow-up). This static smoke test parses App.svelte's source
// and asserts the ThreadPanel mount carries `{store}` and the
// MessageInput-compatible props (channelName, typingUsers, onOpenEmoji)
// and NO longer carries `onSendReply`. Regression guard: if a future
// refactor reverts to the legacy callback the suite fails immediately.

describe('App.svelte — ThreadPanel mount uses the shared composer (v0.4.2 follow-up)', () => {
  test('App.svelte passes store + channelName + typingUsers + onOpenEmoji to ThreadPanel and not onSendReply', () => {
    const src = readFileSync(APP_SVELTE_PATH, 'utf-8');

    // Slice the ThreadPanel mount block from `<ThreadPanel` to the
    // first `/>` after it so the assertions only look at the relevant
    // call site (avoids false positives from `onSendReply` appearing
    // anywhere else in the file).
    const openIdx = src.indexOf('<ThreadPanel');
    expect(openIdx).toBeGreaterThan(-1);
    const closeIdx = src.indexOf('/>', openIdx);
    expect(closeIdx).toBeGreaterThan(openIdx);
    const mountBlock = src.slice(openIdx, closeIdx + 2);

    // The shared-composer wire is present.
    expect(mountBlock).toMatch(/\{store\}/);
    expect(mountBlock).toMatch(/channelName=\{store\.activeChannel\}/);
    expect(mountBlock).toMatch(/typingUsers=\{store\.activeTypingUsers\}/);
    expect(mountBlock).toMatch(/onOpenEmoji=/);

    // The legacy callback is gone from this mount.
    expect(mountBlock).not.toMatch(/onSendReply/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. v0.4.3 new feature: drag-resize handle on the left edge
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors ArtifactPanel's drag-resize pattern. Width is persisted to
// localStorage under `claude-comms:thread-panel-width`, clamped to
// [MIN_PANEL_WIDTH=280, MAX_PANEL_WIDTH=720] with a viewport-aware upper
// bound that reserves 200px for the chat area. The handle is exposed as
// an ARIA window-splitter with keyboard nudge support.
//
// Test-writing patterns (per .worklogs/v043-iteration-log.md §I.19):
//   - Mutation-testable: each test fails if its protected line is deleted.
//   - Source-level regex pins for "this shape MUST exist" invariants
//     (storage key, constants) — robust against future regressions.
//   - DOM-presence + attribute assertions (not just `toBeDefined()`).
//   - PointerEvent-based interactions match the production code path.

const THREAD_RESIZE_STORAGE_KEY = 'claude-comms:thread-panel-width';

/**
 * Fire a PointerEvent on a node with a sensible default `clientX`. jsdom
 * doesn't ship a full PointerEvent constructor in every version, so we
 * fall back to constructing a MouseEvent with the same shape and stamping
 * `pointerId` + `pointerType` on it (the handlers only read these fields).
 */
function firePointer(node, type, { clientX = 0, button = 0, pointerType = 'mouse', pointerId = 1 } = {}) {
  let event;
  try {
    event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      button,
      pointerType,
      pointerId,
    });
  } catch {
    event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
  }
  node.dispatchEvent(event);
  return event;
}

describe('ThreadPanel — drag-resize handle (v0.4.3 new feature)', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem(THREAD_RESIZE_STORAGE_KEY);
    } catch {
      // localStorage may not be available; tests that need it set it directly.
    }
    // Force a known viewport so clampWidth's upper bound is predictable.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600, writable: true });
  });

  test('drag-handle is rendered with separator role and ew-resize cursor (source-level pin)', () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const handle = getByTestId('thread-panel-resize-handle');
    expect(handle).toBeTruthy();
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-label')).toBe('Resize thread panel');

    // Source-level pin: the .resize-handle CSS rule MUST declare `cursor: ew-resize`.
    // jsdom doesn't apply Svelte's scoped styles via getComputedStyle, so we
    // assert the contract from the component source. A regression that drops
    // the cursor (or the rule entirely) fails this test immediately.
    const src = readFileSync(THREAD_PANEL_PATH, 'utf-8');
    const ruleMatch = src.match(/\.resize-handle\s*\{[^}]*\}/);
    expect(ruleMatch).not.toBeNull();
    expect(ruleMatch[0]).toMatch(/cursor:\s*ew-resize/);
    // touch-action: none is load-bearing for touch + pen drags.
    expect(ruleMatch[0]).toMatch(/touch-action:\s*none/);
  });

  test('pointerdown + pointermove resizes ThreadPanel (panel width tracks cursor)', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const panel = getByTestId('thread-panel');
    const handle = getByTestId('thread-panel-resize-handle');

    // Default width is 360 — viewport is 1600 so left edge is at x=1240.
    // Start the drag at x=1240 (offset 0) then move the cursor leftward to
    // x=1000 — the panel should widen to (1600 - 1000) = 600px.
    firePointer(handle, 'pointerdown', { clientX: 1240, button: 0 });
    await tick();
    firePointer(handle, 'pointermove', { clientX: 1000 });
    await tick();

    expect(panel.getAttribute('style')).toMatch(/width:\s*600px/);
    // is-resizing class is applied during the active drag so transitions
    // are suppressed and the handle stays highlighted.
    expect(panel.className).toMatch(/is-resizing/);
  });

  test('pointerup ends the drag (is-resizing class drops)', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const panel = getByTestId('thread-panel');
    const handle = getByTestId('thread-panel-resize-handle');

    firePointer(handle, 'pointerdown', { clientX: 1240 });
    await tick();
    firePointer(handle, 'pointermove', { clientX: 1100 });
    await tick();
    expect(panel.className).toMatch(/is-resizing/);

    firePointer(handle, 'pointerup', { clientX: 1100 });
    await tick();
    expect(panel.className).not.toMatch(/is-resizing/);
  });

  test('size persists to localStorage on pointerup (committed width survives unmount)', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const handle = getByTestId('thread-panel-resize-handle');

    // Drag from 360 → 500 (start at left edge 1240, move to 1100).
    firePointer(handle, 'pointerdown', { clientX: 1240 });
    await tick();
    firePointer(handle, 'pointermove', { clientX: 1100 });
    await tick();
    firePointer(handle, 'pointerup', { clientX: 1100 });
    await tick();

    const stored = localStorage.getItem(THREAD_RESIZE_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(Number.parseInt(stored, 10)).toBe(500);
  });

  test('localStorage value is restored on mount (initialPanelWidth reads STORAGE_KEY)', () => {
    // Seed a stored width BEFORE mount.
    localStorage.setItem(THREAD_RESIZE_STORAGE_KEY, '480');

    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const panel = getByTestId('thread-panel');
    expect(panel.getAttribute('style')).toMatch(/width:\s*480px/);

    // aria-valuenow on the handle is bound to panelWidth too — covers the
    // "screen-reader sees the restored width" path.
    const handle = getByTestId('thread-panel-resize-handle');
    expect(handle.getAttribute('aria-valuenow')).toBe('480');
  });

  test('min size is enforced (drag below clamps to MIN_PANEL_WIDTH=280)', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const panel = getByTestId('thread-panel');
    const handle = getByTestId('thread-panel-resize-handle');

    // Drag the left edge rightward to x=1500 — would compute width=100 (below MIN).
    firePointer(handle, 'pointerdown', { clientX: 1240 });
    await tick();
    firePointer(handle, 'pointermove', { clientX: 1500 });
    await tick();

    // Clamped to 280, not 100.
    expect(panel.getAttribute('style')).toMatch(/width:\s*280px/);

    // Source-level pin: the constant MUST be 280. A future refactor that
    // changes the floor without updating this test fails loudly.
    const src = readFileSync(THREAD_PANEL_PATH, 'utf-8');
    expect(src).toMatch(/const\s+MIN_PANEL_WIDTH\s*=\s*280\b/);
  });

  test('max size is enforced (drag above clamps to MAX_PANEL_WIDTH=720)', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const panel = getByTestId('thread-panel');
    const handle = getByTestId('thread-panel-resize-handle');

    // Drag the left edge leftward to x=400 — would compute width=1200 (above MAX).
    firePointer(handle, 'pointerdown', { clientX: 1240 });
    await tick();
    firePointer(handle, 'pointermove', { clientX: 400 });
    await tick();

    // Clamped to 720, not 1200.
    expect(panel.getAttribute('style')).toMatch(/width:\s*720px/);

    // Source-level pin: the constant MUST be 720.
    const src = readFileSync(THREAD_PANEL_PATH, 'utf-8');
    expect(src).toMatch(/const\s+MAX_PANEL_WIDTH\s*=\s*720\b/);
  });

  test('keyboard ArrowLeft grows the panel (16px nudge) and persists', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const panel = getByTestId('thread-panel');
    const handle = getByTestId('thread-panel-resize-handle');

    // Default 360 → ArrowLeft grows by 16 → 376.
    await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await tick();
    expect(panel.getAttribute('style')).toMatch(/width:\s*376px/);

    // ArrowRight shrinks by 16 → 360.
    await fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await tick();
    expect(panel.getAttribute('style')).toMatch(/width:\s*360px/);

    // Each keyboard commit persists immediately (no pointerup required).
    expect(localStorage.getItem(THREAD_RESIZE_STORAGE_KEY)).toBe('360');
  });

  test('storage key is "claude-comms:thread-panel-width" (source-level pin guards localStorage namespace)', () => {
    // This is the user-facing persistence contract: if the key name drifts,
    // existing users' panel widths silently reset. Pin it at source level.
    const src = readFileSync(THREAD_PANEL_PATH, 'utf-8');
    expect(src).toMatch(/const\s+STORAGE_KEY\s*=\s*['"]claude-comms:thread-panel-width['"]/);

    // Mirror invariant: ArtifactPanel uses the same `claude-comms:` namespace
    // for its width key. This ensures the pattern is consistent across panels.
    const artifactSrc = readFileSync(
      resolve(__dirname, '../src/components/ArtifactPanel.svelte'),
      'utf-8',
    );
    expect(artifactSrc).toMatch(/claude-comms:artifact-panel-width/);
  });

  test('Home key jumps to MAX, End key jumps to MIN (keyboard accessibility extremes)', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const panel = getByTestId('thread-panel');
    const handle = getByTestId('thread-panel-resize-handle');

    // Home → MAX_PANEL_WIDTH (720, clamped by viewport).
    await fireEvent.keyDown(handle, { key: 'Home' });
    await tick();
    expect(panel.getAttribute('style')).toMatch(/width:\s*720px/);

    // End → MIN_PANEL_WIDTH (280).
    await fireEvent.keyDown(handle, { key: 'End' });
    await tick();
    expect(panel.getAttribute('style')).toMatch(/width:\s*280px/);
  });
});
