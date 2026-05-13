/**
 * Slash command registry for the claude-comms message input.
 *
 * v0.4.0 Step 2.18 — when a message in MessageInput begins with `/`, we
 * intercept and dispatch through this module instead of sending the input
 * verbatim as a regular chat message.
 *
 * Parse approach (Heritage Survey §III.4):
 *   1. Trim the input.
 *   2. Reject inputs that do not start with `/`.
 *   3. Tokenize on the first whitespace: the first token (minus the leading
 *      slash, lower-cased) is the command name, the remainder is a single
 *      args string. Per-command parsing of args is the command's own
 *      responsibility (e.g. ``/mute`` splits its arg on whitespace).
 *
 * The 12 commands per the Heritage Survey are registered by
 * ``createDefaultRegistry({ store })`` below. Each handler returns a
 * partial result object that ``execute`` merges into a uniform envelope:
 *
 *   { handled: boolean,             // false iff input was not a slash command
 *     error?: string,               // user-facing error copy (no em dashes)
 *     ok?: string,                  // user-facing success copy (no em dashes)
 *     trigger?: string,             // App-level callback name to invoke
 *     value?: unknown,              // optional payload for the trigger
 *     sendAs?: object }             // synthesize a normal message (eg /me)
 *
 * The MessageInput component is the sole caller; it surfaces ``ok`` /
 * ``error`` as toasts and dispatches ``trigger`` strings as CustomEvents
 * on its container element so App.svelte can route them without coupling
 * MessageInput to App's modal state.
 *
 * No em dashes anywhere in user-facing copy (Standing Rule §I.6 #11).
 */

/**
 * Pure parser entry point. Exported so unit tests can exercise tokenisation
 * without touching the registry. Returns ``null`` for non-slash input and
 * ``null`` for the lone ``/`` (which the inline palette intercepts before
 * the registry sees it).
 *
 * @param {string} input
 * @returns {{ name: string, args: string } | null}
 */
export function parseSlashCommand(input) {
  if (typeof input !== 'string') return null;
  if (!input.startsWith('/')) return null;
  const trimmed = input.trim();
  if (trimmed === '/') return null;
  const firstSpace = trimmed.indexOf(' ');
  const name = firstSpace === -1
    ? trimmed.slice(1)
    : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1
    ? ''
    : trimmed.slice(firstSpace + 1);
  return { name: name.toLowerCase(), args };
}

/**
 * Registry of slash commands.
 *
 * Stored as a ``$state`` field so the (future) inline help palette can
 * react to ``register`` calls without an explicit re-render. The class
 * lives in a ``.svelte.js`` module which Svelte's compiler picks up for
 * rune support.
 */
export class SlashCommandRegistry {
  /** @type {Record<string, { handler: Function, usage: string, description: string }>} */
  commands = $state({});

  /**
   * Register a command. The handler receives ``(args, context)`` and
   * returns ``{ ok?, error?, trigger?, value?, sendAs? }`` (or a promise
   * resolving to one). ``usage`` and ``description`` are surfaced by
   * ``/help`` and the inline palette.
   *
   * @param {string} name
   * @param {(args: string, context: object) => (object | Promise<object>)} handler
   * @param {{ usage?: string, description?: string }} [meta]
   */
  register(name, handler, { usage = '', description = '' } = {}) {
    this.commands[name] = { handler, usage, description };
  }

  /**
   * Parse-and-dispatch shorthand for ``parseSlashCommand`` plus a registry
   * lookup. Returns the uniform envelope described at the top of this
   * file.
   *
   * @param {string} input
   * @param {object} [context]
   * @returns {Promise<{ handled: boolean, ok?: string, error?: string, trigger?: string, value?: unknown, sendAs?: object }>}
   */
  async execute(input, context = {}) {
    const parsed = parseSlashCommand(input);
    if (!parsed) return { handled: false };
    const cmd = this.commands[parsed.name];
    if (!cmd) {
      return {
        handled: true,
        error: `Unknown command: /${parsed.name}. Try /help.`,
      };
    }
    const result = await cmd.handler(parsed.args, context);
    return { handled: true, ...(result ?? {}) };
  }

  /**
   * List all registered commands in insertion order. Used by ``/help`` and
   * the (forthcoming) inline help palette.
   *
   * @returns {Array<{ name: string, usage: string, description: string }>}
   */
  list() {
    return Object.entries(this.commands).map(([name, c]) => ({
      name,
      usage: c.usage,
      description: c.description,
    }));
  }

  /**
   * Direct lookup (used by ``/help <command>``). Returns ``null`` if no
   * such command is registered.
   *
   * @param {string} name
   */
  get(name) {
    if (typeof name !== 'string') return null;
    return this.commands[name.toLowerCase()] ?? null;
  }
}

/**
 * Factory: build a registry pre-populated with the 12 v0.4.0 commands.
 *
 * The factory takes a ``store`` (the ChatStore from
 * ``mqtt-store.svelte.js``) and wires each command's handler against the
 * store's existing public API. Side effects like opening the directory
 * modal or invoking the v0.3.3 ``updateName`` REST path are surfaced via
 * the ``trigger`` field on the envelope so MessageInput can dispatch a
 * CustomEvent for App.svelte to handle without this module reaching into
 * App-level state.
 *
 * @param {{ store: object }} deps
 * @returns {SlashCommandRegistry}
 */
export function createDefaultRegistry({ store }) {
  const r = new SlashCommandRegistry();

  // ── /join <channel> ──────────────────────────────────────────────────
  r.register(
    'join',
    async (args) => {
      const channelId = args.trim();
      if (!channelId) return { error: 'Usage: /join <channel>' };
      const result = await store.joinChannel(channelId);
      if (result && result.success === false) {
        return { error: result.error || `Could not join #${channelId}.` };
      }
      return { ok: `Joined #${channelId}` };
    },
    { usage: '/join <channel>', description: 'Join a channel' },
  );

  // ── /leave [channel] ─────────────────────────────────────────────────
  //
  // Per architecture spec §III.4 step 2.18 the slash form is a direct
  // ``leaveChannel`` call. The full Step 2.11 confirm dialog still gates
  // the context menu / button path; we intentionally short-circuit it
  // here so power-users get a one-shot from the composer. The
  // ``leaveChannel`` store method already returns a 15-second-undoable
  // envelope, so the user retains an undo path via the toast.
  r.register(
    'leave',
    async (args, ctx) => {
      const channelId = args.trim() || ctx?.currentChannelId;
      if (!channelId) return { error: 'No channel to leave.' };
      const envelope = store.leaveChannel(channelId);
      // ``leaveChannel`` returns { done, cancel }. We don't await ``done``
      // here because that would block the composer for 15s waiting on the
      // commit window. Surfacing the optimistic "Left" toast immediately
      // matches the Design Spec §10 reactive-transition pattern.
      // (If the call signalled an immediate failure via a synchronous
      // ``Promise.resolve({ success: false })`` shape, we still want to
      // report ok-optimistic — the rollback path will surface its own
      // toast via the existing undo plumbing.)
      void envelope;
      return { ok: `Left #${channelId}` };
    },
    { usage: '/leave [channel]', description: 'Leave the current or named channel' },
  );

  // ── /list ────────────────────────────────────────────────────────────
  r.register(
    'list',
    async (args) => {
      // Trigger App-level open of ChannelDirectoryModal; pass the args as
      // an optional initial filter (forwarded to the Browse-tab search
      // field by the App-level listener).
      return { trigger: 'openDirectory', value: args.trim() || null };
    },
    { usage: '/list [filter]', description: 'Browse channels' },
  );

  // ── /topic <new topic> ───────────────────────────────────────────────
  r.register(
    'topic',
    async (args, ctx) => {
      const channelId = ctx?.currentChannelId;
      if (!channelId) return { error: 'No active channel.' };
      const newTopic = args.trim();
      if (!newTopic) return { error: 'Usage: /topic <new topic>' };
      const result = await store.setTopic(channelId, newTopic);
      if (result && result.success === false) {
        return { error: result.error || 'Could not update topic.' };
      }
      return { ok: 'Topic updated.' };
    },
    { usage: '/topic <new topic>', description: 'Update the current channel topic' },
  );

  // ── /close ───────────────────────────────────────────────────────────
  //
  // Q1 = "Close means archive (and kick)". ``closeChannel`` in the store
  // already delegates to ``archiveChannel`` and returns the same
  // undoable envelope as ``leaveChannel``.
  r.register(
    'close',
    async (args, ctx) => {
      const channelId = ctx?.currentChannelId;
      if (!channelId) return { error: 'No active channel.' };
      const envelope = store.closeChannel(channelId);
      void envelope;
      return { ok: `Closed #${channelId}` };
    },
    {
      usage: '/close',
      description: 'Close (archive) the current channel; creator only',
    },
  );

  // ── /star ────────────────────────────────────────────────────────────
  r.register(
    'star',
    async (args, ctx) => {
      const channelId = ctx?.currentChannelId;
      if (!channelId) return { error: 'No active channel.' };
      const channel = store.channelsById?.[channelId];
      if (!channel) return { error: 'Channel not found.' };
      const wasStarred = !!channel.starred;
      store.setStar(channelId, !wasStarred);
      return { ok: wasStarred ? `Unstarred #${channelId}` : `Starred #${channelId}` };
    },
    { usage: '/star', description: 'Toggle the star on the current channel' },
  );

  // ── /mute [all|mentions|off] ─────────────────────────────────────────
  r.register(
    'mute',
    async (args, ctx) => {
      const channelId = ctx?.currentChannelId;
      if (!channelId) return { error: 'No active channel.' };
      const level = args.trim() || 'all';
      if (!['all', 'mentions', 'off'].includes(level)) {
        return { error: 'Usage: /mute [all|mentions|off]' };
      }
      const result = store.setMute(channelId, level);
      if (result && result.success === false) {
        return { error: result.error || 'Could not set mute level.' };
      }
      return { ok: `Mute level: ${level}` };
    },
    {
      usage: '/mute [all|mentions|off]',
      description: 'Set the notification policy for the current channel',
    },
  );

  // ── /me <action text> ────────────────────────────────────────────────
  //
  // Returns a ``sendAs`` envelope; MessageInput.sendMessage() peels this
  // off and routes the body through the regular send pipeline with an
  // ``action`` marker so MessageBubble can render it in italics with the
  // ember accent (full styling lands in v0.4.x render-side work).
  r.register(
    'me',
    async (args) => {
      const body = args.trim();
      if (!body) return { error: 'Usage: /me <action>' };
      return { sendAs: { type: 'action', body } };
    },
    { usage: '/me <action>', description: 'Action-style message in italics' },
  );

  // ── /clear ───────────────────────────────────────────────────────────
  //
  // Local-only buffer clear, NOT a server-side delete. v0.4.0 ships a
  // confirm-prompted stub; the real ``store.clearLocalBuffer`` lands in
  // v0.4.x.
  r.register(
    'clear',
    async (args, ctx) => {
      const channelId = ctx?.currentChannelId;
      if (!channelId) return { error: 'No active channel.' };
      if (
        typeof globalThis !== 'undefined'
        && globalThis.window
        && typeof globalThis.window.confirm === 'function'
      ) {
        const ok = globalThis.window.confirm(
          'Clear local message buffer for this channel?',
        );
        if (!ok) return { ok: 'Cancelled.' };
      }
      return { ok: 'Local buffer clear deferred to v0.4.x.' };
    },
    {
      usage: '/clear',
      description: 'Clear the local message buffer for the current channel',
    },
  );

  // ── /help [command] ──────────────────────────────────────────────────
  r.register(
    'help',
    async (args) => {
      const target = args.trim().replace(/^\//, '').toLowerCase();
      if (target) {
        const cmd = r.get(target);
        if (!cmd) return { error: `Unknown command: /${target}` };
        return { ok: `${cmd.usage}\n${cmd.description}` };
      }
      const lines = r.list().map((c) => `${c.usage}  ${c.description}`);
      return { ok: ['Available commands:', ...lines].join('\n') };
    },
    {
      usage: '/help [command]',
      description: 'Show available commands or detail on one',
    },
  );

  // ── /who ─────────────────────────────────────────────────────────────
  r.register(
    'who',
    async (args, ctx) => {
      const channelId = ctx?.currentChannelId;
      if (!channelId) return { error: 'No active channel.' };
      const members = (store.activeMembers ?? [])
        .map((m) => (m && m.name) ? m.name : null)
        .filter(Boolean);
      if (members.length === 0) return { ok: 'Active members: (none)' };
      return { ok: `Active members: ${members.join(', ')}` };
    },
    { usage: '/who', description: 'List active members in the current channel' },
  );

  // ── /nick <new name> ─────────────────────────────────────────────────
  //
  // Reuses the v0.3.3 update-name path (api.updateName via SettingsPanel).
  // We surface a ``trigger: 'updateName'`` so App.svelte can plumb the
  // value through the existing rename flow instead of duplicating the
  // REST call here.
  r.register(
    'nick',
    async (args) => {
      const newName = args.trim();
      if (!newName) return { error: 'Usage: /nick <new name>' };
      return { trigger: 'updateName', value: newName };
    },
    { usage: '/nick <new name>', description: 'Change your display name' },
  );

  return r;
}
