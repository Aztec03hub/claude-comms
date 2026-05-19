<!--
  @component ChannelAdminPanel
  @description Per-channel admin actions surface, rendered inside the
    ChannelDirectoryModal's Admin tab. Action visibility is gated by
    `currentChannelRole` per Q6 lock-in (2026-05-13):
      - 'owner'  -> Rename, Transfer, Visibility, Mode, Archive, Delete
      - 'admin'  -> Rename, Visibility, Mode, Archive (no Transfer, no Delete)
      - 'member' -> empty state: "You don't have admin rights in this channel."

    Destructive actions route through the shared `onConfirmDestructive`
    helper prop-drilled from App.svelte:
      - Archive -> { severity: 'warning' } (skips typed-name gate)
      - Delete  -> { severity: 'danger'  } (typed-name required)

    Wave 0 STUB: this file only declares the prop contract. The actions,
    the role gating, and the role-aware UI all land in Step 3.1
    (Wave A). Do NOT implement business logic here.

  @prop {Object} channel - Channel row object from store.channelsById[id].
    Carries id, name, topic, mode, visibility, createdBy, archived, etc.
    Required.
  @prop {'owner'|'admin'|'member'|null} currentChannelRole - Caller's
    role on this channel per Q6. `null` while the role table is still
    hydrating; the panel renders a skeleton placeholder in that case.
    Step 3.1 wires this to a store accessor (provisional name
    `store.getChannelRole(channel.id)`).
  @prop {Object} store - MqttChatStore instance (for the action wiring
    that Step 3.1 will add: setTopic, archiveChannel, deleteChannel,
    etc.). Required.
  @prop {Function} onConfirmDestructive - Promise-based confirm helper
    from App.svelte. Signature: (opts) => Promise<boolean>. Opts shape:
    { resourceName, requireTypedName, title, body, confirmLabel,
      severity: 'danger' | 'warning' }. Required for Archive + Delete
    actions to be reachable.
  @prop {Function} [onClose] - Optional. Called after a destructive
    action commits so the parent modal can close itself.
-->
<script>
  let {
    channel,
    currentChannelRole,
    store,
    onConfirmDestructive,
    onClose,
  } = $props();
</script>

<div data-testid="channel-admin-panel-stub">Admin panel stub - Wave A Step 3.1 fills this in</div>
