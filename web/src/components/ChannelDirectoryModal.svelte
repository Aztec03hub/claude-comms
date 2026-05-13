<!--
  ChannelDirectoryModal.svelte — full-screen modal opened via Ctrl+L or
  "Browse channels…" link in the sidebar's Available section. Hosts two
  tabs: Browse (mounts ConversationBrowser) + Admin (per-channel admin
  for channels you created).

  Wave 0 stub per §I.17. Step 2.13 implementation agent fills in:
  - Tab state machine + body content
  - Filter input + locked sort dropdown
  - Modal a11y (focus trap, Escape closes, return focus to invoker)
  - Admin tab gating + content

  PUBLIC CONTRACT (do not rename or restructure):
-->
<script>
  /**
   * @prop {Object} store — MqttChatStore instance (for channelsById, userProfile, joinChannel, etc.)
   * @prop {boolean} open — when true, modal renders. Two-way bindable.
   * @prop {string} initialTab — 'browse' | 'admin'. Default 'browse'.
   * @prop {string} initialFilter — pre-populates the filter input. Default ''.
   * @prop {Function} onClose — fired when modal should close (Escape, X button, outside click).
   * @prop {Function} onChannelClick — (channelId) => void. Fired when user clicks a row in Browse. Modal closes + invokes this.
   * @prop {Function} onChannelJoin — (channelId) => void. Fired when user clicks Join on a non-member row. Defaults to store.joinChannel.
   */
  let {
    store,
    open = $bindable(false),
    initialTab = 'browse',
    initialFilter = '',
    onClose,
    onChannelClick,
    onChannelJoin,
  } = $props();

  // Wave 0 stub: body filled in by Step 2.13 implementation agent.
</script>

{#if open}
  <div class="channel-directory-modal-stub" role="dialog" aria-modal="true" aria-label="Channel directory">
    <!-- Step 2.13 implementation agent fills this in. -->
    <p>ChannelDirectoryModal (Wave 0 stub) — Step 2.13 implementation pending</p>
    <button onclick={() => onClose?.()}>Close</button>
  </div>
{/if}

<style>
  .channel-directory-modal-stub {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
</style>
