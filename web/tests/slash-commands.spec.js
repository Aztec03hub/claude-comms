// Unit tests for src/lib/slashCommands.svelte.js (v0.4.0 Step 2.18).
//
// Two layers of coverage:
//
//   1. parseSlashCommand — pure tokeniser. Tests it in isolation: leading
//      slash detection, case folding, first-whitespace split, empty-args
//      edge cases.
//
//   2. createDefaultRegistry — wires the 12 v0.4.0 commands against a
//      fake store. Each command's handler is exercised via
//      registry.execute(...) with both happy-path and missing-context
//      shapes, asserting the uniform envelope returned to MessageInput.
//
// We deliberately do NOT mount MessageInput.svelte here — the registry +
// parser are exported pure modules, so spec'ing them at the JS level
// gives sharper failure modes when a command's wiring drifts. The
// component-level integration is covered indirectly by the existing
// message-input.spec.js suites; v0.4.x adds an end-to-end suite once the
// inline help palette lands.
//
// No em dashes in any user-facing assertion text (Standing Rule §I.6 #11).

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  parseSlashCommand,
  SlashCommandRegistry,
  createDefaultRegistry,
} from '../src/lib/slashCommands.svelte.js';

// ── Fixtures ───────────────────────────────────────────────────────────

/**
 * Make a fake store with just enough surface for the registry's
 * handlers. Each method is a ``vi.fn()`` so individual tests can pin the
 * call args and / or return value.
 */
function makeStore({
  joinResult = { success: true },
  setTopicResult = { success: true },
  setMuteResult = { success: true },
  channels = { general: { id: 'general', starred: false, member: true } },
  members = [{ key: 'k1', name: 'phil' }, { key: 'k2', name: 'ember' }],
} = {}) {
  return {
    joinChannel: vi.fn().mockResolvedValue(joinResult),
    leaveChannel: vi.fn().mockReturnValue({
      done: Promise.resolve({ success: true }),
      cancel: () => ({ tooLate: true }),
    }),
    closeChannel: vi.fn().mockReturnValue({
      done: Promise.resolve({ success: true }),
      cancel: () => ({ tooLate: true }),
    }),
    setTopic: vi.fn().mockResolvedValue(setTopicResult),
    setStar: vi.fn().mockReturnValue({ success: true }),
    setMute: vi.fn().mockReturnValue(setMuteResult),
    channelsById: channels,
    activeMembers: members,
  };
}

// ── parseSlashCommand ──────────────────────────────────────────────────

describe('parseSlashCommand — pure tokeniser', () => {
  test('returns null for non-string input', () => {
    expect(parseSlashCommand(null)).toBeNull();
    expect(parseSlashCommand(undefined)).toBeNull();
    expect(parseSlashCommand(42)).toBeNull();
  });

  test('returns null for input that does not start with /', () => {
    expect(parseSlashCommand('join general')).toBeNull();
    expect(parseSlashCommand(' /join general')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  test('returns null for a bare slash (palette territory)', () => {
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('  /  ')).toBeNull();
  });

  test('parses a command with no args: /help', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', args: '' });
  });

  test('parses a command with an arg: /join general', () => {
    expect(parseSlashCommand('/join general')).toEqual({
      name: 'join',
      args: 'general',
    });
  });

  test('multi-word args are preserved verbatim after the first space', () => {
    expect(parseSlashCommand('/topic Q2 OKR sync')).toEqual({
      name: 'topic',
      args: 'Q2 OKR sync',
    });
  });

  test('command name is lower-cased; args preserve case', () => {
    expect(parseSlashCommand('/JOIN General')).toEqual({
      name: 'join',
      args: 'General',
    });
  });

  test('trailing whitespace on the input is trimmed; leading whitespace rejects', () => {
    // Trailing whitespace is part of normal /help input from a textarea
    // with the caret at end of line. Leading whitespace is treated as
    // a non-command (the parser is strict on the leading slash so the
    // user isn't surprised when an accidentally-indented chat message
    // gets eaten by the command dispatcher).
    expect(parseSlashCommand('/help  ')).toEqual({ name: 'help', args: '' });
    expect(parseSlashCommand('   /help  ')).toBeNull();
  });
});

// ── SlashCommandRegistry — generic class behaviour ─────────────────────

describe('SlashCommandRegistry — register / execute / list', () => {
  test('execute returns { handled: false } for non-slash input', async () => {
    const r = new SlashCommandRegistry();
    const result = await r.execute('hello world');
    expect(result).toEqual({ handled: false });
  });

  test('execute returns an error envelope for an unknown command', async () => {
    const r = new SlashCommandRegistry();
    const result = await r.execute('/nope arg');
    expect(result.handled).toBe(true);
    expect(result.error).toContain('Unknown command: /nope');
    expect(result.error).toContain('/help');
  });

  test('register stores handler + usage + description metadata', () => {
    const r = new SlashCommandRegistry();
    r.register('foo', () => ({ ok: 'hi' }), {
      usage: '/foo <bar>',
      description: 'Demo command',
    });
    expect(r.commands.foo.usage).toBe('/foo <bar>');
    expect(r.commands.foo.description).toBe('Demo command');
    expect(typeof r.commands.foo.handler).toBe('function');
  });

  test('list returns insertion order with usage + description', () => {
    const r = new SlashCommandRegistry();
    r.register('a', () => ({}), { usage: '/a', description: 'A' });
    r.register('b', () => ({}), { usage: '/b', description: 'B' });
    expect(r.list()).toEqual([
      { name: 'a', usage: '/a', description: 'A' },
      { name: 'b', usage: '/b', description: 'B' },
    ]);
  });

  test('get is case-insensitive and returns null for unknown', () => {
    const r = new SlashCommandRegistry();
    r.register('foo', () => ({}), { usage: '/foo', description: 'D' });
    expect(r.get('FOO')).not.toBeNull();
    expect(r.get('bar')).toBeNull();
    expect(r.get(null)).toBeNull();
  });

  test('execute awaits async handlers and merges the result', async () => {
    const r = new SlashCommandRegistry();
    r.register('slow', async (args) => {
      await Promise.resolve();
      return { ok: `slow ${args}` };
    }, { usage: '/slow', description: 'slow' });
    const result = await r.execute('/slow hi');
    expect(result).toEqual({ handled: true, ok: 'slow hi' });
  });
});

// ── createDefaultRegistry — the 12 v0.4.0 commands ─────────────────────

describe('createDefaultRegistry — /join', () => {
  test('rejects empty arg with usage hint', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/join', { currentChannelId: 'general' });
    expect(result.handled).toBe(true);
    expect(result.error).toBe('Usage: /join <channel>');
    expect(store.joinChannel).not.toHaveBeenCalled();
  });

  test('calls store.joinChannel with the channel id and surfaces ok', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/join general', {});
    expect(store.joinChannel).toHaveBeenCalledWith('general');
    expect(result).toEqual({ handled: true, ok: 'Joined #general' });
  });

  test('surfaces store error envelope as user-facing error', async () => {
    const store = makeStore({ joinResult: { success: false, error: 'Already a member.' } });
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/join general', {});
    expect(result.handled).toBe(true);
    expect(result.error).toBe('Already a member.');
  });
});

describe('createDefaultRegistry — /leave', () => {
  test('uses currentChannelId when no arg supplied', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/leave', { currentChannelId: 'general' });
    expect(store.leaveChannel).toHaveBeenCalledWith('general');
    expect(result.ok).toBe('Left #general');
  });

  test('uses explicit arg when supplied', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    await r.execute('/leave random', { currentChannelId: 'general' });
    expect(store.leaveChannel).toHaveBeenCalledWith('random');
  });

  test('errors when no channel is in context', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/leave', {});
    expect(result.error).toBe('No channel to leave.');
    expect(store.leaveChannel).not.toHaveBeenCalled();
  });
});

describe('createDefaultRegistry — /list', () => {
  test('returns the openDirectory trigger', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/list', {});
    expect(result.handled).toBe(true);
    expect(result.trigger).toBe('openDirectory');
    expect(result.value).toBeNull();
  });

  test('forwards filter text to the trigger value', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/list eng', {});
    expect(result.trigger).toBe('openDirectory');
    expect(result.value).toBe('eng');
  });
});

describe('createDefaultRegistry — /topic', () => {
  test('updates topic on the active channel', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/topic Q2 OKR sync', {
      currentChannelId: 'general',
    });
    expect(store.setTopic).toHaveBeenCalledWith('general', 'Q2 OKR sync');
    expect(result.ok).toBe('Topic updated.');
  });

  test('errors when no active channel', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/topic anything', {});
    expect(result.error).toBe('No active channel.');
    expect(store.setTopic).not.toHaveBeenCalled();
  });

  test('errors when no topic body supplied', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/topic', { currentChannelId: 'general' });
    expect(result.error).toBe('Usage: /topic <new topic>');
    expect(store.setTopic).not.toHaveBeenCalled();
  });
});

describe('createDefaultRegistry — /close', () => {
  test('calls store.closeChannel and surfaces ok', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/close', { currentChannelId: 'general' });
    expect(store.closeChannel).toHaveBeenCalledWith('general');
    expect(result.ok).toBe('Closed #general');
  });

  test('errors when no active channel', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/close', {});
    expect(result.error).toBe('No active channel.');
  });
});

describe('createDefaultRegistry — /star', () => {
  test('toggles starred=true when currently unstarred', async () => {
    const store = makeStore({
      channels: { general: { id: 'general', starred: false, member: true } },
    });
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/star', { currentChannelId: 'general' });
    expect(store.setStar).toHaveBeenCalledWith('general', true);
    expect(result.ok).toBe('Starred #general');
  });

  test('toggles starred=false when currently starred', async () => {
    const store = makeStore({
      channels: { general: { id: 'general', starred: true, member: true } },
    });
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/star', { currentChannelId: 'general' });
    expect(store.setStar).toHaveBeenCalledWith('general', false);
    expect(result.ok).toBe('Unstarred #general');
  });

  test('errors when channel id not in channelsById', async () => {
    const store = makeStore({ channels: {} });
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/star', { currentChannelId: 'ghost' });
    expect(result.error).toBe('Channel not found.');
  });
});

describe('createDefaultRegistry — /mute', () => {
  test('defaults to all when no arg supplied', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/mute', { currentChannelId: 'general' });
    expect(store.setMute).toHaveBeenCalledWith('general', 'all');
    expect(result.ok).toBe('Mute level: all');
  });

  test('accepts mentions and off as explicit levels', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });

    await r.execute('/mute mentions', { currentChannelId: 'general' });
    expect(store.setMute).toHaveBeenLastCalledWith('general', 'mentions');

    await r.execute('/mute off', { currentChannelId: 'general' });
    expect(store.setMute).toHaveBeenLastCalledWith('general', 'off');
  });

  test('rejects unknown level with usage hint', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/mute loud', { currentChannelId: 'general' });
    expect(result.error).toBe('Usage: /mute [all|mentions|off]');
    expect(store.setMute).not.toHaveBeenCalled();
  });
});

describe('createDefaultRegistry — /me', () => {
  test('returns a sendAs envelope with type=action', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/me waves', {});
    expect(result.handled).toBe(true);
    expect(result.sendAs).toEqual({ type: 'action', body: 'waves' });
    expect(store.joinChannel).not.toHaveBeenCalled();
  });

  test('rejects empty action body', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/me', {});
    expect(result.error).toBe('Usage: /me <action>');
  });
});

describe('createDefaultRegistry — /clear', () => {
  let originalWindow;

  beforeEach(() => {
    // ``window.confirm`` returns true so the happy-path lands on the stub
    // response. The cancel branch is exercised in a dedicated test.
    originalWindow = globalThis.window;
    globalThis.window = { confirm: vi.fn().mockReturnValue(true) };
  });

  test('returns the v0.4.0 stub copy on confirm=true', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/clear', { currentChannelId: 'general' });
    expect(result.ok).toContain('Local buffer clear deferred');
  });

  test('returns Cancelled on confirm=false', async () => {
    globalThis.window.confirm = vi.fn().mockReturnValue(false);
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/clear', { currentChannelId: 'general' });
    expect(result.ok).toBe('Cancelled.');
  });

  test('errors when no active channel', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/clear', {});
    expect(result.error).toBe('No active channel.');
    // Restore for downstream describes.
    globalThis.window = originalWindow;
  });
});

describe('createDefaultRegistry — /help', () => {
  test('lists all 12 commands when no arg', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/help', {});
    expect(result.handled).toBe(true);
    expect(result.ok).toContain('Available commands:');
    // The 12 v0.4.0 commands per Heritage Survey.
    for (const cmd of ['/join', '/leave', '/list', '/topic', '/close',
      '/star', '/mute', '/me', '/clear', '/help', '/who', '/nick']) {
      expect(result.ok).toContain(cmd);
    }
  });

  test('shows detail for a known command', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/help join', {});
    expect(result.ok).toContain('/join <channel>');
    expect(result.ok).toContain('Join a channel');
  });

  test('accepts a leading slash on the help target', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/help /mute', {});
    expect(result.ok).toContain('/mute');
  });

  test('errors on unknown help target', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/help nope', {});
    expect(result.error).toBe('Unknown command: /nope');
  });
});

describe('createDefaultRegistry — /who', () => {
  test('lists active member names', async () => {
    const store = makeStore({
      members: [{ key: 'k1', name: 'phil' }, { key: 'k2', name: 'ember' }],
    });
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/who', { currentChannelId: 'general' });
    expect(result.ok).toBe('Active members: phil, ember');
  });

  test('shows none when no members', async () => {
    const store = makeStore({ members: [] });
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/who', { currentChannelId: 'general' });
    expect(result.ok).toBe('Active members: (none)');
  });

  test('errors when no active channel', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/who', {});
    expect(result.error).toBe('No active channel.');
  });
});

describe('createDefaultRegistry — /nick', () => {
  test('returns updateName trigger with the new name', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/nick ember', {});
    expect(result.trigger).toBe('updateName');
    expect(result.value).toBe('ember');
  });

  test('preserves multi-word names verbatim', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/nick Phil LaFayette', {});
    expect(result.value).toBe('Phil LaFayette');
  });

  test('rejects empty arg', async () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const result = await r.execute('/nick', {});
    expect(result.error).toBe('Usage: /nick <new name>');
  });
});

describe('createDefaultRegistry — coverage', () => {
  test('the registry exposes exactly 12 commands', () => {
    const store = makeStore();
    const r = createDefaultRegistry({ store });
    const names = r.list().map((c) => c.name).sort();
    expect(names).toEqual([
      'clear', 'close', 'help', 'join', 'leave', 'list',
      'me', 'mute', 'nick', 'star', 'topic', 'who',
    ]);
  });
});
