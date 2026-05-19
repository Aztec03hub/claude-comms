// v0.4.2 Step 3.13 — Status set / clear UI (UX G-24).
//
// Two coverage clusters in one spec file:
//
//   1. Store accessors (6 tests) — exercise the new
//      ``setProfileStatus`` / ``clearProfileStatus`` methods on
//      MqttChatStore. Mock ``mcpCall`` so the spec runs without a
//      daemon. Verify the snake_case MCP arg names (``emoji``,
//      ``text``, ``expires_at``) are forwarded VERBATIM to the
//      Wave A2 tools.
//
//   2. StatusEditor.svelte UI (7 tests) — render with the testing-
//      library-svelte harness; verify the popover surface
//      (emoji picker, text input + char counter, expiry preset
//      options, save / clear / cancel buttons).
//
// Total: 13 tests, satisfying the ≥13 floor from the dispatch brief.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

// ── Hoisted api.js mock (same pattern as mqtt-store-channels.spec.js) ──

const mcpCallMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
  mcpCall: (...args) => mcpCallMock(...args),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');
const { default: StatusEditor } = await import('../src/components/StatusEditor.svelte');

beforeEach(() => {
  mcpCallMock.mockReset();
  try { if (typeof localStorage !== 'undefined') localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════════
// 1. Store accessors — setProfileStatus / clearProfileStatus
// ═══════════════════════════════════════════════════════════════════════

describe('MqttChatStore — setProfileStatus (UX G-24, v0.4.2 Step 3.13)', () => {
  it('forwards snake_case args (emoji, text, expires_at) to the MCP tool verbatim', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = 'phil-key';
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: { status: 'ok' } });

    const res = await store.setProfileStatus('🍵', 'tea break', '2026-05-19T18:00:00Z');

    expect(res.success).toBe(true);
    expect(mcpCallMock).toHaveBeenCalledTimes(1);
    expect(mcpCallMock).toHaveBeenCalledWith('comms_profile_status_set', {
      key: 'phil-key',
      emoji: '🍵',
      text: 'tea break',
      expires_at: '2026-05-19T18:00:00Z',
    });
  });

  it('optimistic update: writes userProfile.profileStatus BEFORE the MCP call lands', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = 'phil-key';
    // Resolve manually so we can inspect mid-flight.
    let resolveCall;
    const pending = new Promise((r) => { resolveCall = r; });
    mcpCallMock.mockReturnValueOnce(pending);

    const flight = store.setProfileStatus('🎧', 'focused', null);
    // Local state should already reflect the new status.
    expect(store.userProfile.profileStatus).toEqual({
      emoji: '🎧',
      text: 'focused',
      expires_at: null,
    });

    resolveCall({ success: true, payload: {} });
    await flight;
    // Final state: same value, success.
    expect(store.userProfile.profileStatus).toEqual({
      emoji: '🎧',
      text: 'focused',
      expires_at: null,
    });
  });

  it('error path: rolls back to prior profileStatus on MCP failure', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = 'phil-key';
    store.userProfile.profileStatus = { emoji: '💬', text: 'old', expires_at: null };
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'broker offline' });

    const res = await store.setProfileStatus('🍵', 'new', null);

    expect(res.success).toBe(false);
    expect(res.error).toBe('broker offline');
    expect(store.userProfile.profileStatus).toEqual({
      emoji: '💬',
      text: 'old',
      expires_at: null,
    });
  });

  it('expiresAt defaults to null when omitted', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = 'phil-key';
    mcpCallMock.mockResolvedValueOnce({ success: true });

    await store.setProfileStatus('🌴', 'vacation');

    expect(mcpCallMock).toHaveBeenCalledWith('comms_profile_status_set', expect.objectContaining({
      emoji: '🌴',
      text: 'vacation',
      expires_at: null,
    }));
  });
});

describe('MqttChatStore — clearProfileStatus (UX G-24, v0.4.2 Step 3.13)', () => {
  it('calls comms_profile_status_clear with only the key, no other args', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = 'phil-key';
    store.userProfile.profileStatus = { emoji: '🍵', text: 'tea', expires_at: null };
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: {} });

    const res = await store.clearProfileStatus();

    expect(res.success).toBe(true);
    expect(mcpCallMock).toHaveBeenCalledWith('comms_profile_status_clear', {
      key: 'phil-key',
    });
    expect(store.userProfile.profileStatus).toBeNull();
  });

  it('error path: rolls back to prior status on failure', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = 'phil-key';
    const before = { emoji: '🎧', text: 'focused', expires_at: null };
    store.userProfile.profileStatus = before;
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'rate-limited' });

    const res = await store.clearProfileStatus();

    expect(res.success).toBe(false);
    expect(res.error).toBe('rate-limited');
    // Restored to a structurally-equal snapshot.
    expect(store.userProfile.profileStatus).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. StatusEditor.svelte UI surface
// ═══════════════════════════════════════════════════════════════════════

function mountEditor(overrides = {}) {
  const handlers = {
    onSave: vi.fn(),
    onClear: vi.fn(),
    onCancel: vi.fn(),
  };
  const utils = render(StatusEditor, {
    props: {
      currentStatus: null,
      ...handlers,
      ...overrides,
    },
  });
  return { ...utils, handlers };
}

describe('StatusEditor.svelte — surface', () => {
  it('renders the editor dialog with title + emoji strip + text input + expiry presets + actions', () => {
    const { getByTestId } = mountEditor();
    expect(getByTestId('status-editor')).toBeTruthy();
    expect(getByTestId('status-editor-emoji-strip')).toBeTruthy();
    expect(getByTestId('status-editor-text-input')).toBeTruthy();
    expect(getByTestId('status-editor-expiry-never')).toBeTruthy();
    expect(getByTestId('status-editor-expiry-1h')).toBeTruthy();
    expect(getByTestId('status-editor-expiry-4h')).toBeTruthy();
    expect(getByTestId('status-editor-expiry-tomorrow')).toBeTruthy();
    expect(getByTestId('status-editor-save')).toBeTruthy();
    expect(getByTestId('status-editor-clear')).toBeTruthy();
    expect(getByTestId('status-editor-cancel')).toBeTruthy();
  });

  it('clicking an emoji glyph fills the emoji input and marks the chip active', async () => {
    const { getByTestId } = mountEditor();
    await fireEvent.click(getByTestId('status-editor-emoji-🍵'));
    await tick();
    const customInput = getByTestId('status-editor-emoji-input');
    expect(customInput.value).toBe('🍵');
    expect(getByTestId('status-editor-emoji-🍵').classList.contains('active')).toBe(true);
  });

  it('typing in the text input updates the live char counter', async () => {
    const { getByTestId } = mountEditor();
    const input = getByTestId('status-editor-text-input');
    await fireEvent.input(input, { target: { value: 'in a meeting' } });
    await tick();
    expect(getByTestId('status-editor-char-count').textContent).toBe('12/60');
  });

  it('selecting an expiry preset marks that chip active and the others inactive', async () => {
    const { getByTestId } = mountEditor();
    // Default: "never" is active.
    expect(getByTestId('status-editor-expiry-never').classList.contains('active')).toBe(true);
    await fireEvent.click(getByTestId('status-editor-expiry-4h'));
    await tick();
    expect(getByTestId('status-editor-expiry-4h').classList.contains('active')).toBe(true);
    expect(getByTestId('status-editor-expiry-never').classList.contains('active')).toBe(false);
  });

  it('Save fires onSave with (emoji, text, expiresAt) — expiry "1h" yields an ISO timestamp 1h in the future', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T12:00:00.000Z'));
    try {
      const { getByTestId, handlers } = mountEditor();
      await fireEvent.click(getByTestId('status-editor-emoji-🍵'));
      await fireEvent.input(getByTestId('status-editor-text-input'), { target: { value: 'tea break' } });
      await fireEvent.click(getByTestId('status-editor-expiry-1h'));
      await tick();
      await fireEvent.click(getByTestId('status-editor-save'));
      expect(handlers.onSave).toHaveBeenCalledTimes(1);
      const [emojiArg, textArg, expiresAtArg] = handlers.onSave.mock.calls[0];
      expect(emojiArg).toBe('🍵');
      expect(textArg).toBe('tea break');
      expect(expiresAtArg).toBe('2026-05-19T13:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Save with expiry "never" passes expiresAt=null', async () => {
    const { getByTestId, handlers } = mountEditor();
    await fireEvent.input(getByTestId('status-editor-text-input'), { target: { value: 'in a meeting' } });
    await tick();
    await fireEvent.click(getByTestId('status-editor-save'));
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
    const [, , expiresAtArg] = handlers.onSave.mock.calls[0];
    expect(expiresAtArg).toBeNull();
  });

  it('Clear fires onClear (no args); Cancel fires onCancel and neither triggers onSave', async () => {
    const { getByTestId, handlers } = mountEditor({
      currentStatus: { emoji: '🍵', text: 'tea', expires_at: null },
    });
    await fireEvent.click(getByTestId('status-editor-clear'));
    expect(handlers.onClear).toHaveBeenCalledTimes(1);
    expect(handlers.onClear).toHaveBeenCalledWith();
    expect(handlers.onSave).not.toHaveBeenCalled();

    // Mount a fresh instance for cancel coverage so the click-on-Clear
    // call above doesn't pollute the new instance's handlers.
    cleanup();
    const second = mountEditor();
    await fireEvent.click(second.getByTestId('status-editor-cancel'));
    expect(second.handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(second.handlers.onSave).not.toHaveBeenCalled();
  });
});
