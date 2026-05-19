<!--
  @component ThreadPanel
  @description Slide-in panel for viewing and replying to a message thread.
    Shows the parent message, a scrollable list of threaded replies with
    avatars and timestamps, and a reply composer that delegates to the
    shared `MessageInput` component when a `store` is provided (UX G-36,
    v0.4.2 Step 3.12), with a backward-compatible inline `<input>`
    fallback when only the legacy `onSendReply` callback is supplied.

    Composer parity: the thread reply box reuses `MessageInput.svelte` so
    threads inherit @mentions, the slash-command registry (/me, /help,
    /who, /clear, etc.), over-limit handling (G-28), the format toolbar,
    the snippet inserter, and the emoji-picker trigger. Before Step 3.12
    threads had their own inline `<input>` with none of that polish.

    Thread routing strategy: MessageInput is consumed as-is — it knows
    nothing about threads. ThreadPanel constructs a `threadStore` proxy
    over the real store whose `sendMessage(body, replyTo, opts)`
    intercept stamps `replyTo = parentMessage.id` whenever the caller
    passed `null` (i.e. the default autocomplete path, the `/me` action
    path, and the `/dm` path). Sends that already carry an explicit
    `replyTo` (e.g. `/reply <uuid>`) are forwarded verbatim so users
    can't accidentally re-thread a reply. All other store reads (
    `participants`, `userProfile`, `composerPrefill`, `activeChannel`,
    `notifyTyping`) pass through unchanged via Object property getters,
    preserving reactivity (the underlying $state proxies are still the
    ones MessageInput's $derived chains observe).

    Backward-compat: callers that mount ThreadPanel with the legacy
    `onSendReply` callback but no `store` keep working — the panel falls
    back to its previous inline input. This lets us land Step 3.12
    without simultaneously touching App.svelte's mount call site
    (read-only per the wave scope); App.svelte can adopt the new
    `store=...` prop in a follow-up. A `[VERIFY]` line in the worklog
    flags this for the orchestrator.

  @prop {object} parentMessage - The root message that started the thread.
  @prop {Array} messages - Array of reply message objects in the thread.
  @prop {object} [participants] - Map of participant keys to participant objects (legacy display path; kept for avatar / member counts).
  @prop {object} [currentUser] - The current user's profile (legacy display path).
  @prop {Function} onClose - Callback invoked to close the thread panel.
  @prop {object} [store] - The ChatStore instance. When supplied, the composer is the shared MessageInput; the proxy below stamps `parentMessage.id` as `replyTo` on every send.
  @prop {string} [channelName] - The active channel name; forwarded to MessageInput so the slash-command registry sees the right currentChannelId context.
  @prop {Array} [typingUsers] - Forwarded to MessageInput so typing-indicator rendering works inside the thread composer too.
  @prop {Function} [onOpenEmoji] - Forwarded to MessageInput so the thread composer's emoji button opens the shared picker.
  @prop {Function} [onSendReply] - Legacy callback `(body: string) => void`. Used only when `store` is NOT supplied; preserves pre-3.12 callers (App.svelte's current mount) until they migrate.
-->
<script>
  import Avatar from './Avatar.svelte';
  import MessageInput from './MessageInput.svelte';
  import { MessageSquare, Send, X } from 'lucide-svelte';
  import { formatTime, getParticipantColor } from '../lib/utils.js';

  let {
    parentMessage,
    messages = [],
    participants,
    currentUser,
    onClose,
    store = null,
    channelName,
    typingUsers = [],
    onOpenEmoji,
    onSendReply,
  } = $props();

  let parentColor = $derived(getParticipantColor(parentMessage.sender.key));

  // Whether to render the shared MessageInput composer (3.12) or the
  // pre-3.12 inline `<input>` fallback. The new path is preferred when a
  // live store is supplied — App.svelte still passes `onSendReply` and
  // no store, so it keeps the legacy path until its mount is updated in
  // a follow-up.
  let useSharedComposer = $derived(store !== null && store !== undefined);

  // ── Legacy inline-input state ────────────────────────────────────────
  let replyText = $state('');

  function handleLegacySend() {
    if (!replyText.trim()) return;
    onSendReply?.(replyText);
    replyText = '';
  }

  function handleLegacyKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleLegacySend();
    }
  }

  // ── Thread-scoped store proxy (3.12 path) ────────────────────────────
  //
  // We expose the real store to MessageInput but rewrite `sendMessage`
  // to stamp the thread parent id as `replyTo`. Property getters delegate
  // each read to the underlying store so MessageInput's $derived /
  // $effect chains keep observing the same reactive $state proxies — no
  // reactivity is lost by the indirection. `composerPrefill` needs a
  // setter too because MessageInput writes back to clear it after the
  // prefill effect fires.
  //
  // Sends that already carry an explicit `replyTo` (the `/reply <uuid>`
  // path inside MessageInput.sendMessage) are forwarded verbatim. This
  // preserves the user's intent if they type `/reply <other-id> hi` from
  // inside a thread — the explicit id wins. The default autocomplete
  // path, the `/me` action path, and the `/dm` path all pass `null` for
  // `replyTo`, so they get rewritten to the thread's parent id.
  let threadStore = $derived(
    useSharedComposer
      ? {
          get participants() { return store.participants; },
          get userProfile() { return store.userProfile; },
          get activeChannel() { return store.activeChannel; },
          get activeMembers() { return store.activeMembers; },
          get channelsById() { return store.channelsById; },
          get composerPrefill() { return store.composerPrefill; },
          set composerPrefill(v) { store.composerPrefill = v; },
          notifyTyping: (...args) => store.notifyTyping?.(...args),
          sendMessage: (body, replyTo = null, opts = {}) => {
            const effectiveReplyTo = replyTo ?? parentMessage.id;
            return store.sendMessage(body, effectiveReplyTo, opts);
          },
          // Slash-command registry handlers reach for these — forward
          // them verbatim so /join, /leave, /topic etc. fired from
          // inside a thread act on the underlying channel rather than
          // no-op.
          joinChannel: (...args) => store.joinChannel?.(...args),
          leaveChannel: (...args) => store.leaveChannel?.(...args),
          closeChannel: (...args) => store.closeChannel?.(...args),
          setTopic: (...args) => store.setTopic?.(...args),
          setStar: (...args) => store.setStar?.(...args),
          setMute: (...args) => store.setMute?.(...args),
        }
      : null,
  );
</script>

<div class="thread-panel" data-testid="thread-panel" role="complementary" aria-label="Thread replies">
  <div class="thread-header">
    <div class="thread-title">
      <MessageSquare size={16} strokeWidth={2} />
      Thread
    </div>
    <span class="thread-reply-count">{messages.length} replies</span>
    <button class="thread-close" onclick={onClose} data-testid="thread-panel-close" aria-label="Close thread panel"><X size={16} strokeWidth={2} /></button>
  </div>

  <div class="thread-parent">
    <div class="thread-parent-header">
      <div class="thread-parent-avatar" style="background: {parentColor.gradient}">
        {parentMessage.sender.name.slice(0, 2).toUpperCase()}
      </div>
      <span class="thread-parent-name" style="color: {parentColor.textColor}">{parentMessage.sender.name}</span>
      <span class="thread-parent-time">{formatTime(parentMessage.ts, 'short')}</span>
    </div>
    <div class="thread-parent-text">{parentMessage.body}</div>
  </div>

  <div class="thread-replies">
    {#each messages as reply (reply.id)}
      {@const replyColor = getParticipantColor(reply.sender.key)}
      <div class="thread-reply">
        <div class="thread-reply-avatar" style="background: {replyColor.gradient}">
          {reply.sender.name.slice(0, 2).toUpperCase()}
        </div>
        <div class="thread-reply-content">
          <div class="thread-reply-header">
            <span class="thread-reply-name" style="color: {replyColor.textColor}">{reply.sender.name}</span>
            <span class="thread-reply-time">{formatTime(reply.ts, 'short')}</span>
          </div>
          <div class="thread-reply-text">{reply.body}</div>
        </div>
      </div>
    {/each}
  </div>

  {#if useSharedComposer && threadStore}
    <div class="thread-composer" data-testid="thread-composer">
      <MessageInput
        store={threadStore}
        channelName={channelName ?? store?.activeChannel ?? ''}
        typingUsers={typingUsers}
        onOpenEmoji={onOpenEmoji ?? (() => {})}
      />
    </div>
  {:else}
    <div class="thread-input" data-testid="thread-input-legacy">
      <div class="thread-input-wrap">
        <label for="thread-reply-input-field" class="sr-only">Reply in thread</label>
        <input
          id="thread-reply-input-field"
          type="text"
          placeholder="Reply in thread..."
          bind:value={replyText}
          onkeydown={handleLegacyKeydown}
          data-testid="thread-reply-input"
        >
        <button class="thread-send" onclick={handleLegacySend} aria-label="Send reply" data-testid="thread-send">
          <Send size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .thread-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 360px;
    z-index: 45;
    background: rgba(17, 17, 19, 0.97);
    backdrop-filter: blur(24px) saturate(1.3);
    border-left: 1px solid var(--border);
    box-shadow: -12px 0 40px rgba(0,0,0,0.35);
    display: flex;
    flex-direction: column;
    animation: threadSlide 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .thread-header {
    padding: 16px 18px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .thread-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
  }

  .thread-title :global(svg) { color: var(--ember-400); opacity: 0.8; }

  .thread-reply-count {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
  }

  .thread-close {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
    flex-shrink: 0;
  }

  .thread-close:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--ember-700); }

  .thread-parent {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
    background: rgba(255, 255, 255, 0.01);
  }

  .thread-parent-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .thread-parent-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: #0a0a0c;
  }

  .thread-parent-name { font-size: 12px; font-weight: 700; }
  .thread-parent-time { font-size: 10px; color: var(--text-faint); margin-left: auto; }
  .thread-parent-text { font-size: 13px; color: var(--text-secondary); line-height: 1.55; }

  .thread-replies {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .thread-reply {
    display: flex;
    gap: 8px;
    animation: msgAppear 0.3s ease-out both;
  }

  .thread-reply-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: #0a0a0c;
    margin-top: 2px;
  }

  .thread-reply-content { flex: 1; min-width: 0; }

  .thread-reply-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 2px;
  }

  .thread-reply-name { font-size: 12px; font-weight: 700; }
  .thread-reply-time { font-size: 10px; color: var(--text-faint); }
  .thread-reply-text { font-size: 13px; color: var(--text-secondary); line-height: 1.55; }

  /* 3.12 path — MessageInput owns its own border-top + padding; override
     the top padding so it sits flush against the replies list without
     doubling the gap that already exists in MessageInput's own
     `.input-area` (12px 22px 18px). */
  .thread-composer :global(.input-area) {
    padding: 10px 14px 12px;
  }

  /* Legacy inline-input fallback (pre-3.12). Preserved verbatim for
     callers that haven't migrated to the `store=...` prop yet. */
  .thread-input {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    background: linear-gradient(180deg, transparent, rgba(0,0,0,0.1));
  }

  .thread-input-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 6px 3px 12px;
    transition: var(--transition-med);
  }

  .thread-input-wrap:focus-within {
    border-color: rgba(245,158,11,0.2);
    box-shadow: 0 0 0 2px var(--border-glow);
  }

  .thread-input-wrap input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: 13px;
    padding: 7px 0;
    font-family: inherit;
  }

  .thread-input-wrap input::placeholder { color: var(--text-faint); }

  .thread-send {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: none;
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    color: #0a0a0c;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }

  .thread-send:hover { filter: brightness(1.1); }
</style>
