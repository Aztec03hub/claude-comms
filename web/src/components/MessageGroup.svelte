<!--
  @component MessageGroup
  @description Renders a group of consecutive messages from the same sender, marking the first as a full bubble (with avatar/name) and subsequent ones as consecutive (compact layout).
  @prop {Array} messages - Array of message objects in this group.
  @prop {object} currentUser - The current user's profile.
  @prop {object} participants - Map of participant keys to participant objects.
  @prop {Function} onOpenThread - Callback invoked with a message to open its thread.
  @prop {Function} onContextMenu - Callback invoked with context menu event data.
  @prop {Function} onShowProfile - Callback invoked with a participant to show their profile.
  @prop {Function} onReact - Callback invoked when adding a reaction to a message.
-->
<script>
  import MessageBubble from './MessageBubble.svelte';

  let { messages = [], currentUser, participants, onOpenThread, onContextMenu, onShowProfile, onReact } = $props();
</script>

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
  />
{/each}
