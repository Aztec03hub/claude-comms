<!--
  @component ContextMenu
  @description Right-click context menu for message actions (reply, forward, pin, copy, react, mark unread, delete). Uses bits-ui ContextMenu primitives and positions itself at the triggering click coordinates.
  @prop {number} x - Horizontal click coordinate for menu positioning.
  @prop {number} y - Vertical click coordinate for menu positioning.
  @prop {object|null} message - The message object the context menu was opened on.
  @prop {Function} onAction - Callback invoked with { action, message } when an item is selected.
  @prop {Function} onClose - Callback invoked when the menu is dismissed.
-->
<script>
  import { ContextMenu } from 'bits-ui';
  import { Reply, Forward, Pin, Copy, Smile, MailOpen, Trash2 } from 'lucide-svelte';
  import { tick, onMount } from 'svelte';

  let { x = 0, y = 0, message = null, onAction, onClose } = $props();

  let open = $state(false);
  let triggerEl = $state(null);

  function handleOpenChange(newOpen) {
    if (!newOpen && open) {
      open = false;
      onClose();
    }
  }

  function handleAction(action) {
    onAction({ action, message });
  }

  // On mount, simulate a right-click on the trigger to open the menu at (x, y)
  onMount(() => {
    tick().then(() => {
      if (triggerEl) {
        // Create and dispatch a real contextmenu event with our coordinates
        const evt = new MouseEvent('contextmenu', {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        });
        triggerEl.dispatchEvent(evt);
      }
    });
  });
</script>

<ContextMenu.Root bind:open onOpenChange={handleOpenChange}>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <!-- Invisible trigger positioned at click point; bits-ui uses this as anchor -->
      <div
        {...props}
        bind:this={triggerEl}
        style="position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none;opacity:0;"
      ></div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content
    class="context-menu"
    data-testid="context-menu"
    loop={true}
    sideOffset={0}
    alignOffset={0}
    avoidCollisions={true}
    onInteractOutside={() => { open = false; onClose(); }}
  >
    <ContextMenu.Item
      class="ctx-item"
      data-testid="ctx-reply"
      onSelect={() => handleAction('reply')}
    >
      <Reply size={14} />
      <span>Reply</span>
      <span class="ctx-kbd">R</span>
    </ContextMenu.Item>
    <ContextMenu.Item
      class="ctx-item"
      data-testid="ctx-forward"
      onSelect={() => handleAction('forward')}
    >
      <Forward size={14} />
      <span>Forward</span>
    </ContextMenu.Item>
    <ContextMenu.Item
      class="ctx-item"
      data-testid="ctx-pin"
      onSelect={() => handleAction('pin')}
    >
      <Pin size={14} />
      <span>Pin Message</span>
      <span class="ctx-kbd">P</span>
    </ContextMenu.Item>
    <ContextMenu.Item
      class="ctx-item"
      data-testid="ctx-copy"
      onSelect={() => handleAction('copy')}
    >
      <Copy size={14} />
      <span>Copy Text</span>
      <span class="ctx-kbd">C</span>
    </ContextMenu.Item>
    <ContextMenu.Separator class="ctx-divider" />
    <ContextMenu.Item
      class="ctx-item"
      data-testid="ctx-react"
      onSelect={() => handleAction('react')}
    >
      <Smile size={14} />
      <span>React</span>
    </ContextMenu.Item>
    <ContextMenu.Item
      class="ctx-item"
      data-testid="ctx-unread"
      onSelect={() => handleAction('unread')}
    >
      <MailOpen size={14} />
      <span>Mark Unread</span>
    </ContextMenu.Item>
    <ContextMenu.Separator class="ctx-divider" />
    <ContextMenu.Item
      class="ctx-item danger"
      data-testid="ctx-delete"
      onSelect={() => handleAction('delete')}
    >
      <Trash2 size={14} />
      <span>Delete</span>
      <span class="ctx-kbd">Del</span>
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>

<style>
  :global([data-context-menu-content]) {
    z-index: 200;
    width: 200px;
    background: rgba(37, 37, 40, 0.96);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm);
    box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02);
    padding: 4px;
    animation: ctxIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  :global([data-context-menu-item]) {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: var(--transition-fast);
    font-size: 13px;
    color: var(--text-secondary);
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    font-family: inherit;
    outline: none;
  }

  :global([data-context-menu-item]:hover),
  :global([data-context-menu-item][data-highlighted]) {
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  :global([data-context-menu-item].danger) {
    color: #ef4444;
  }

  :global([data-context-menu-item].danger:hover),
  :global([data-context-menu-item].danger[data-highlighted]) {
    background: rgba(239,68,68,0.1);
    color: #f87171;
  }

  :global([data-context-menu-item] svg) {
    flex-shrink: 0;
    opacity: 0.7;
  }

  :global([data-context-menu-item] span) {
    flex: 1;
  }

  :global([data-context-menu-item] .ctx-kbd) {
    font-size: 9px;
    color: var(--text-faint);
    font-family: 'SF Mono', Consolas, monospace;
  }

  :global([data-context-menu-separator]) {
    height: 1px;
    background: var(--border);
    margin: 4px 8px;
  }
</style>
