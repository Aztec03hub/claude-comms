<!--
  @component SystemMessageGroup
  @description Collapses a run of 3+ consecutive system messages (join, leave,
    archive, topic_change, etc.) into a single summary row with click-to-expand.
    Runs of 1 or 2 system messages render inline as today (no collapse). The
    collapsed view is muted, smaller, and avatar-less — visually distinct from
    a regular MessageGroup so it reads as ambient channel chatter rather than
    a participant message.

    v0.4.2 Wave E.1 Step 3.11 (UX G-58). This component is mounted by
    MessageGroup whenever its incoming ``messages`` array carries
    ``sender.type === 'system'`` entries.

  @prop {Array} messages - Array of system message objects. Each entry is the
    shape pushed via ``mqtt-store.svelte.js`` ``#handleChatMessage``: at
    minimum ``{ id, ts, body, sender: { type: 'system', name } }``. The body
    is the canonical pre-rendered string (the Wave A Step 2.7 daemon already
    humanizes join/leave/archive/topic_changed/etc. before publish).
-->
<script>
  import { Info, ChevronDown, ChevronRight } from 'lucide-svelte';

  let { messages = [] } = $props();

  // Collapse threshold per Step 3.11 spec. 3+ consecutive system events
  // collapse to a single summary row; 1 or 2 render inline (the historical
  // behaviour from pre-Step-3.11 ChatView).
  const COLLAPSE_THRESHOLD = 3;

  let expanded = $state(false);

  let shouldCollapse = $derived(messages.length >= COLLAPSE_THRESHOLD);

  // Best-effort humanized summary. The daemon already renders the per-event
  // string into ``msg.body`` (Wave A Step 2.7 event taxonomy: join, leave,
  // archive, unarchive, delete, topic_changed, renamed, member_joined,
  // member_left). We stitch those bodies together with commas and append a
  // trailing event count so the row reads as "Alice joined, Bob left,
  // Carol archived #general (3 events)" without re-implementing the daemon's
  // humanizer here.
  let summary = $derived.by(() => {
    if (!messages.length) return '';
    const parts = messages
      .map((m) => (typeof m?.body === 'string' ? m.body.trim() : ''))
      .filter((s) => s.length > 0);
    if (!parts.length) return `${messages.length} events`;
    const joined = parts.join(', ');
    return `${joined} (${messages.length} events)`;
  });

  function toggleExpanded() {
    expanded = !expanded;
  }

  function handleKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpanded();
    }
  }
</script>

{#if !shouldCollapse}
  {#each messages as msg (msg.id)}
    <div
      class="system-message"
      data-message-id={msg.id}
      data-testid="system-message-{msg.id}"
    >
      <Info size={12} strokeWidth={2} />
      <span class="system-message-text">{msg.body}</span>
    </div>
  {/each}
{:else}
  <div class="system-group" data-testid="system-message-group">
    <button
      type="button"
      class="system-group-summary"
      onclick={toggleExpanded}
      onkeydown={handleKey}
      aria-expanded={expanded}
      aria-controls="system-group-events"
      data-testid="system-message-group-toggle"
    >
      {#if expanded}
        <ChevronDown size={12} strokeWidth={2} />
      {:else}
        <ChevronRight size={12} strokeWidth={2} />
      {/if}
      <span class="system-group-text">{summary}</span>
    </button>

    {#if expanded}
      <div
        id="system-group-events"
        class="system-group-events"
        data-testid="system-message-group-events"
      >
        {#each messages as msg (msg.id)}
          <div
            class="system-message"
            data-message-id={msg.id}
            data-testid="system-message-{msg.id}"
          >
            <Info size={12} strokeWidth={2} />
            <span class="system-message-text">{msg.body}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .system-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 2px 0;
  }

  .system-group-summary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 4px 12px;
    background: transparent;
    border: none;
    color: var(--text-faint);
    font-family: inherit;
    font-size: 11px;
    line-height: 1.5;
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .system-group-summary:hover {
    background: var(--bg-hover, rgba(255, 255, 255, 0.04));
    color: var(--text-muted);
  }

  .system-group-summary:focus-visible {
    outline: 2px solid var(--ember-400, #f59e0b);
    outline-offset: 2px;
  }

  .system-group-summary :global(svg) {
    flex-shrink: 0;
    opacity: 0.7;
  }

  .system-group-text {
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 80ch;
  }

  .system-group-events {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 8px;
    border-left: 2px solid var(--border, rgba(255, 255, 255, 0.06));
    margin-left: 16px;
  }

  .system-message {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 4px 12px;
    margin: 2px 0;
  }

  .system-message :global(svg) {
    color: var(--text-faint);
    flex-shrink: 0;
    opacity: 0.6;
  }

  .system-message-text {
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1.5;
  }
</style>
