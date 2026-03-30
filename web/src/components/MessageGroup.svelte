<script>
  import MessageBubble from './MessageBubble.svelte';

  let { messages = [], currentUser, participants, onOpenThread, onContextMenu, onShowProfile } = $props();
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
  />
{/each}
