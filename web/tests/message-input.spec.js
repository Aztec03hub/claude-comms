// Component tests for MessageInput.svelte focused on the G-28 over-limit
// handling shipped in v0.3.3 Step 1.7.
//
// Before this step, an over-limit message (inputValue.length >
// MAX_MESSAGE_LENGTH = 10000) caused the send button to silently no-op:
// `sendMessage()` early-returned at the length check, but the button itself
// stayed enabled with no error surfaced and no diagnostic for the user.
//
// Coverage here pins:
//   1. Over-limit state surfaces the inline error banner above the composer
//      AND disables the send button (no silent no-op).
//   2. Under-limit state hides the banner, leaves the send button enabled
//      (provided non-empty content).
//   3. The "Convert to artifact" CTA copies the composer contents to
//      clipboard and surfaces the v0.3.3 toast text — textarea is NOT
//      cleared (the user might still want to edit in place).
//   4. The CTA emits a `requestToast` CustomEvent on the composer root so
//      App-level listeners can pick it up without coupling shape.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import MessageInput from '../src/components/MessageInput.svelte';

const MAX = 10000;

function makeStore() {
  return {
    participants: {
      'phil-key': {
        key: 'phil-key',
        name: 'phil',
        type: 'human',
        connections: { 'web-1': {} },
      },
    },
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    composerPrefill: null,
    sendMessage: vi.fn(),
    notifyTyping: vi.fn(),
  };
}

/**
 * Wholesale-set the textarea value (bypass per-char input events). We don't
 * care about per-keystroke autocomplete state here — only over-limit
 * surface behavior.
 */
async function setText(ta, text) {
  ta.value = text;
  ta.setSelectionRange(text.length, text.length);
  await fireEvent.input(ta, { target: ta });
  await tick();
}

afterEach(() => {
  cleanup();
  // Reset clipboard mock between tests
  if (globalThis.navigator && 'clipboard' in globalThis.navigator) {
    try {
      delete globalThis.navigator.clipboard;
    } catch {
      /* some envs make navigator.clipboard non-configurable; ignore */
    }
  }
});

describe('MessageInput — G-28 over-limit handling (Step 1.7)', () => {
  test('over-limit surfaces inline banner and disables send button', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Under-limit baseline: send is enabled (with content), banner absent.
    await setText(ta, 'hello');
    const sendBtnBefore = getByTestId('send-button');
    expect(sendBtnBefore.disabled).toBe(false);
    expect(queryByTestId('over-limit-banner')).toBeNull();

    // Push past MAX_MESSAGE_LENGTH (10001 chars).
    const over = 'x'.repeat(MAX + 1);
    await setText(ta, over);

    // Banner is now visible with the over-limit diagnostic.
    const banner = getByTestId('over-limit-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Message too long');
    expect(banner.textContent).toContain('1 over limit');
    expect(banner.textContent).toContain('split or convert to artifact');

    // The "Convert to artifact" CTA is rendered alongside the error text.
    expect(getByTestId('convert-to-artifact')).toBeTruthy();

    // Send button is disabled — clicking it does NOT call store.sendMessage.
    const sendBtn = getByTestId('send-button');
    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.getAttribute('aria-disabled')).toBe('true');

    await fireEvent.click(sendBtn);
    await tick();
    expect(store.sendMessage).not.toHaveBeenCalled();

    // Dropping back under the limit restores the un-banner state and re-
    // enables send.
    await setText(ta, 'hello');
    expect(queryByTestId('over-limit-banner')).toBeNull();
    expect(getByTestId('send-button').disabled).toBe(false);
  });

  test('Convert to artifact CTA copies textarea contents to clipboard + emits requestToast', async () => {
    const store = makeStore();

    // Mock navigator.clipboard.writeText — jsdom doesn't ship a clipboard
    // implementation by default. We assert the CTA writes the textarea
    // value verbatim and surfaces the v0.3.3 stub toast text.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Listen for the requestToast CustomEvent on document — the banner emits
    // it as bubbling+composed so a future App.svelte listener can intercept.
    const toastEvents = [];
    const onToast = (e) => toastEvents.push(e);
    document.addEventListener('requestToast', onToast);

    try {
      // Push past the limit to surface the CTA.
      const over = 'a'.repeat(MAX + 50);
      await setText(ta, over);

      const cta = getByTestId('convert-to-artifact');
      expect(cta).toBeTruthy();

      await fireEvent.click(cta);
      // The CTA awaits clipboard.writeText then sets state — flush async.
      await tick();
      await Promise.resolve();
      await tick();

      // Clipboard was written with the FULL textarea contents.
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(over);

      // In-composer notice surfaces the v0.3.3 stub toast text.
      const notice = getByTestId('convert-notice');
      expect(notice.textContent).toContain('Copied');
      expect(notice.textContent).toContain('artifact');
      expect(notice.textContent).toContain('v0.4.x');

      // requestToast CustomEvent fired with the same toast text + copied flag.
      expect(toastEvents.length).toBe(1);
      const ev = toastEvents[0];
      expect(ev.detail.text).toBe('Copied — paste into a new artifact (coming v0.4.x)');
      expect(ev.detail.copied).toBe(true);
      expect(ev.detail.kind).toBe('info');

      // Textarea contents are preserved — the user may still want to split
      // the message in place rather than convert it whole.
      expect(ta.value).toBe(over);
      // Send button is STILL disabled (we didn't drop under the limit).
      expect(getByTestId('send-button').disabled).toBe(true);
    } finally {
      document.removeEventListener('requestToast', onToast);
    }
  });

  test('exactly-at-limit (length === MAX) is allowed: no banner, send enabled', async () => {
    // Boundary check: the over-limit derivation uses STRICT `>`, so a
    // message of exactly MAX_MESSAGE_LENGTH chars is allowed through.
    const store = makeStore();
    const { getByTestId, queryByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await setText(ta, 'x'.repeat(MAX));
    expect(queryByTestId('over-limit-banner')).toBeNull();
    const sendBtn = getByTestId('send-button');
    expect(sendBtn.disabled).toBe(false);

    await fireEvent.click(sendBtn);
    await tick();
    expect(store.sendMessage).toHaveBeenCalledTimes(1);
  });
});
