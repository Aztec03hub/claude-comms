// v0.4.3 hotfix regression-pin for [VERIFY-PHASE2C-1]:
// MqttChatStore.#restoreUnreadMarkers USED to be called from connect()
// BEFORE #bootstrapChannels populated channelsById; the rehydration loop
// walked an empty map and the localStorage cursor was effectively dead
// for the cold-load case. v0.4.3 moved the call to the TAIL of
// #bootstrapChannels so unread cursors survive tab close + reopen.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { MqttChatStore } from '../src/lib/mqtt-store.svelte.js';

const localStorageBackend = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _dump: () => Object.fromEntries(store),
  };
})();

vi.stubGlobal('localStorage', localStorageBackend);

describe('Unread marker rehydration — v0.4.3 [VERIFY-PHASE2C-1] bugfix', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('rehydrates unread cursors AFTER #bootstrapChannels populates channelsById', async () => {
    // Seed localStorage with markers for two channels — simulating the
    // "tab closed mid-read; user reopens" cold-load scenario.
    localStorage.setItem(
      'claude-comms-unread-markers',
      JSON.stringify({
        general: { unread: 3, unreadFrom: 'msg-aaa' },
        'dev-chat': { unread: 1, unreadFrom: 'msg-bbb' },
      }),
    );

    const store = new MqttChatStore();
    // Mock apiGet to feed #bootstrapChannels two channels matching the markers.
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/conversations')) {
        return new Response(
          JSON.stringify([
            { id: 'general', name: 'general', topic: 't', members: [], visibility: 'public' },
            { id: 'dev-chat', name: 'dev-chat', topic: 't', members: [], visibility: 'public' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    await store._bootstrapChannelsForTest();

    expect(store.channelsById.general?.unread).toBe(3);
    expect(store.channelsById.general?.unreadFrom).toBe('msg-aaa');
    expect(store.channelsById['dev-chat']?.unread).toBe(1);
    expect(store.channelsById['dev-chat']?.unreadFrom).toBe('msg-bbb');
  });

  it('handles empty localStorage gracefully (cold install)', async () => {
    const store = new MqttChatStore();
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/conversations')) {
        return new Response(
          JSON.stringify([{ id: 'general', name: 'general', topic: '', members: [], visibility: 'public' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    await store._bootstrapChannelsForTest();
    expect(store.channelsById.general?.unread ?? 0).toBe(0);
    expect(store.channelsById.general?.unreadFrom ?? null).toBe(null);
  });

  it('handles corrupt localStorage gracefully (no throw)', async () => {
    localStorage.setItem('claude-comms-unread-markers', '{not valid json');
    const store = new MqttChatStore();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: 'g', name: 'g', topic: '', members: [], visibility: 'public' }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(store._bootstrapChannelsForTest()).resolves.not.toThrow();
  });

  it('source pin: #restoreUnreadMarkers is called from inside #bootstrapChannels (P-1)', () => {
    const src = readFileSync('./src/lib/mqtt-store.svelte.js', 'utf8');
    const lines = src.split('\n');
    // Find the #bootstrapChannels method definition line + the line that
    // ACTUALLY calls #restoreUnreadMarkers. Then assert the call line is
    // between #bootstrapChannels's start and its closing brace.
    // Class-method closing braces in mqtt-store.svelte.js use exactly
    // 2-space indent (`  }`). We use `trimEnd()` to tolerate trailing
    // whitespace differences from formatters while preserving specificity
    // over inner braces (which use deeper indentation).
    const isMethodClose = (l) => l.trimEnd() === '  }';
    const bootstrapLineIdx = lines.findIndex((l) => l.includes('async #bootstrapChannels()'));
    expect(bootstrapLineIdx).toBeGreaterThan(0);
    let bootstrapEndIdx = -1;
    for (let i = bootstrapLineIdx + 1; i < lines.length; i++) {
      if (isMethodClose(lines[i])) {
        bootstrapEndIdx = i;
        break;
      }
    }
    expect(bootstrapEndIdx).toBeGreaterThan(bootstrapLineIdx);
    // The call to #restoreUnreadMarkers MUST appear between bootstrap start + end
    const callLineIdx = lines.findIndex(
      (l, i) => i > bootstrapLineIdx && i < bootstrapEndIdx && /this\.#restoreUnreadMarkers\(\)/.test(l),
    );
    expect(callLineIdx).toBeGreaterThan(bootstrapLineIdx);

    // The connect() method's body must NOT call #restoreUnreadMarkers
    const connectLineIdx = lines.findIndex((l) => l.includes('async connect()'));
    expect(connectLineIdx).toBeGreaterThan(0);
    let connectEndIdx = -1;
    for (let i = connectLineIdx + 1; i < lines.length; i++) {
      if (isMethodClose(lines[i])) {
        connectEndIdx = i;
        break;
      }
    }
    expect(connectEndIdx).toBeGreaterThan(connectLineIdx);
    const deadCallIdx = lines.findIndex(
      (l, i) => i > connectLineIdx && i < connectEndIdx && /this\.#restoreUnreadMarkers\(\)/.test(l),
    );
    expect(deadCallIdx).toBe(-1);
  });
});
