<!--
  @component UnreadDivider
  @description Horizontal "N new since you were here" marker inserted between
  the last-read message and the first-unread message in the chat viewport.
  v0.4.2 Step 3.7.

  Visual: a thin border-top line with a centered pill label like "3 new".
  Renders nothing when `unreadCount <= 0` so callers can mount this
  unconditionally without an outer #if.

  Caller responsibility:
    - Position this in the message list BETWEEN the message whose id matches
      `channel.unreadFrom` predecessor and the unread cursor itself. The
      divider does not compute that position; it only renders the visual.
    - Provide `unreadCount` from `channel.unread`.

  PUBLIC CONTRACT (do not rename):
    @prop {number} unreadCount - The number of unread messages below this
      divider. When 0 (or negative), the component renders nothing.
    @prop {string} [label] - Override the default "{N} new" label. Useful
      when callers want "{N} new since {timestamp}" copy.
-->
<script>
  let { unreadCount = 0, label = '' } = $props();

  let displayLabel = $derived(
    label && label.length > 0
      ? label
      : `${unreadCount} new`,
  );

  let visible = $derived(typeof unreadCount === 'number' && unreadCount > 0);
</script>

{#if visible}
  <div
    class="unread-divider"
    role="separator"
    aria-label={`${unreadCount} unread messages below`}
    data-testid="unread-divider"
  >
    <span class="unread-divider-line" aria-hidden="true"></span>
    <span class="unread-divider-label" data-testid="unread-divider-label">
      {displayLabel}
    </span>
    <span class="unread-divider-line" aria-hidden="true"></span>
  </div>
{/if}

<style>
  .unread-divider {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    padding: 0 4px;
    user-select: none;
    animation: dividerFadeIn 0.3s ease both;
  }

  .unread-divider-line {
    flex: 1;
    height: 1px;
    background: linear-gradient(
      to right,
      transparent,
      var(--ember-400, #f59e0b),
      transparent
    );
    opacity: 0.5;
  }

  .unread-divider-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--ember-400, #f59e0b);
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--bg-surface, transparent);
    border: 1px solid currentColor;
    white-space: nowrap;
  }

  @keyframes dividerFadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
