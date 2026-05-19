<!--
  @component MessageGroup
  @description Renders a group of consecutive messages from the same sender,
    marking the first as a full bubble (with avatar/name) and subsequent ones
    as consecutive (compact layout).

    v0.4.2 Wave E.1 Step 3.11 (UX G-58): when the incoming ``messages`` array
    is a run of system events (``sender.type === 'system'``), MessageGroup
    delegates to ``SystemMessageGroup`` which collapses runs of 3+ into a
    single muted summary row with click-to-expand. Runs of 1 or 2 system
    events still render inline. Non-system runs render through MessageBubble
    exactly as they did pre-3.11 (zero behaviour change for regular chat).

  @prop {Array} messages - Array of message objects in this group.
  @prop {object} currentUser - The current user's profile.
  @prop {object} participants - Map of participant keys to participant objects.
  @prop {Function} onOpenThread - Callback invoked with a message to open its thread.
  @prop {Function} onContextMenu - Callback invoked with context menu event data.
  @prop {Function} onShowProfile - Callback invoked with a participant to show their profile.
  @prop {Function} onReact - Callback invoked when adding a reaction to a message.
  @prop {Function} [onRetryMessage] - Optional callback invoked with a message id when the user clicks the Retry affordance on a `status === 'failed'` bubble. Forwarded to each MessageBubble's `onRetry` prop. Wire from App.svelte to `store.retryMessage(id)` (UX G-62 follow-up, Step 1.5b).
-->
<script>
  import MessageBubble from './MessageBubble.svelte';
  import SystemMessageGroup from './SystemMessageGroup.svelte';

  let { messages = [], currentUser, participants, onOpenThread, onContextMenu, onShowProfile, onReact, onRetryMessage } = $props();

  // A group is "system" when every entry is a system event. Defensive: an
  // empty array is not a system group (renders to nothing via the each
  // block below). We check ALL entries rather than just the first to avoid
  // a malformed mixed group sneaking into the SystemMessageGroup branch.
  let isSystemGroup = $derived(
    messages.length > 0 &&
      messages.every((m) => m?.sender?.type === 'system')
  );
</script>

{#if isSystemGroup}
  <SystemMessageGroup {messages} />
{:else}
  {#each messages as msg, i (msg.id)}
    <MessageBubble
      message={msg}
      consecutive={i > 0}
      {currentUser}
      {participants}
      {onOpenThread}
      {onContextMenu}
      {onShowProfile}
      {onReact}
      onRetry={onRetryMessage}
    />
  {/each}
{/if}
