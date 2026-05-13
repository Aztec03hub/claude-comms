<!--
  @component ChannelContextMenu
  @description Right-click context menu for a channel row in the sidebar
    (Design Spec §7, Phil's CTX-MENU-NEW constraint). Renders the action
    set as menuitems with a Mute submenu; the parent owns the routing of
    each emitted `actionId` to store methods + downstream modals.

    Action set (visibility computed from `isMember` / `isCreator` props +
    `channel` fields). Q1=archive locked for v0.4.0, so the creator's
    "Close" action emits the `'close'` actionId and the parent's store
    handles archive vs delete dispatch.

    Submenu: Mute → 3 mutually exclusive options (`mute:all`,
    `mute:mentions`, `mute:off`); opens on hover, Enter, or ArrowRight
    when the Mute item is focused.

    Positioning: fixed at `anchorEvent.clientX/clientY`. After mount the
    component measures its own bounding rect and flips up + / or left if
    the menu would overflow the viewport.

    Keyboard / a11y:
      - role="menu", each row role="menuitem"
      - First item is focused on mount
      - ArrowUp / ArrowDown navigate (skipping disabled rows are not used
        — invisible rows are simply not rendered)
      - Enter / Space activate
      - Escape closes (onClose)
      - ArrowRight on Mute opens submenu; ArrowLeft inside submenu
        returns to parent menu
      - Outside-click closes via window mousedown listener

  @prop {object} channel - Channel row object (consults .name, .id,
    .starred, .muted, .unread, .createdBy, .member fields for label /
    visibility logic). Required.
  @prop {MouseEvent} anchorEvent - The contextmenu MouseEvent (used for
    .clientX / .clientY positioning). Required.
  @prop {boolean} isMember - True when the current user is a member of
    the channel. Drives visibility for Star, Mute, Mark-read, Leave,
    Close.
  @prop {boolean} isCreator - True when the current user is the channel
    creator. Drives visibility for Close + Delete; suppresses Leave.
  @prop {Function} onAction - Callback `(actionId: string) => void`
    invoked once per click. Possible actionIds:
      'toggle-star', 'mute:all', 'mute:mentions', 'mute:off',
      'mark-read', 'copy-link', 'leave', 'close', 'delete', 'info'
    The component calls `onClose()` immediately after firing onAction.
  @prop {Function} onClose - Callback invoked on outside-click, Escape,
    or after any action fires.
-->
<script>
  import { tick } from 'svelte';
  import {
    Star,
    StarOff,
    BellOff,
    Bell,
    BellRing,
    Check as CheckIcon,
    CheckCheck,
    Link as LinkIcon,
    LogOut,
    Archive,
    Trash2,
    Info,
    ChevronRight,
  } from 'lucide-svelte';

  let {
    channel,
    anchorEvent,
    isMember = false,
    isCreator = false,
    onAction,
    onClose,
  } = $props();

  // -----------------------------------------------------------------
  // Action visibility — computed up-front so keyboard nav can address
  // the rendered list by index without re-deriving on each keystroke.
  // Each entry: { id, label, icon, danger?, submenu? }
  // -----------------------------------------------------------------
  const items = $derived.by(() => {
    const list = [];
    const hasUnread = (channel?.unread ?? 0) > 0;

    if (isMember) {
      list.push({
        id: 'toggle-star',
        label: channel?.starred ? 'Unstar' : 'Star',
        icon: channel?.starred ? StarOff : Star,
      });
      list.push({
        id: 'mute-submenu',
        label: 'Mute',
        icon: channel?.muted ? BellOff : Bell,
        submenu: [
          { id: 'mute:all', label: 'All messages', icon: BellOff },
          { id: 'mute:mentions', label: 'Only mentions', icon: BellRing },
          { id: 'mute:off', label: 'Off', icon: Bell },
        ],
      });
      if (hasUnread) {
        list.push({
          id: 'mark-read',
          label: 'Mark all as read',
          icon: CheckCheck,
        });
      }
    }

    list.push({ id: 'copy-link', label: 'Copy channel link', icon: LinkIcon });

    if (isMember && !isCreator) {
      list.push({ id: 'leave', label: 'Leave', icon: LogOut, danger: true });
    }
    if (isMember && isCreator) {
      list.push({ id: 'close', label: 'Close', icon: Archive });
    }
    if (isCreator) {
      list.push({ id: 'delete', label: 'Delete', icon: Trash2, danger: true });
    }

    list.push({ id: 'info', label: 'Channel info', icon: Info });

    return list;
  });

  // -----------------------------------------------------------------
  // Position state. Default to 0,0; once the menu has mounted the
  // $effect below reads `anchorEvent.clientX/Y`, measures the rendered
  // rect, and sets the final coords (possibly flipped). The component
  // is mounted/unmounted on each right-click in the parent shell, so a
  // stale anchorEvent value cannot occur during a single instance.
  // -----------------------------------------------------------------
  let menuX = $state(0);
  let menuY = $state(0);
  let menuEl = $state(null);

  // Submenu state.
  let submenuOpenIndex = $state(/** @type {number | null} */ (null));
  let submenuX = $state(0);
  let submenuY = $state(0);

  // Active item index for keyboard navigation. Defaults to 0 once the
  // menu mounts; ArrowUp / ArrowDown move it.
  let activeIndex = $state(0);
  let submenuActiveIndex = $state(0);

  // -----------------------------------------------------------------
  // Position + initial focus after mount. We use $effect with a
  // run-once latch instead of onMount so jsdom test environments
  // (which do not run microtask animation frames) still execute the
  // measurement pass before assertions.
  // -----------------------------------------------------------------
  let positioned = false;
  $effect(() => {
    if (!menuEl || positioned) return;
    positioned = true;

    const initialX = anchorEvent?.clientX ?? 0;
    const initialY = anchorEvent?.clientY ?? 0;

    // Default to the raw cursor coords, then flip if we would overflow.
    const rect = menuEl.getBoundingClientRect();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;

    let nextY = initialY;
    if (initialY + rect.height > vh && initialY - rect.height >= 0) {
      nextY = Math.max(0, initialY - rect.height);
    }
    let nextX = initialX;
    if (initialX + rect.width > vw && initialX - rect.width >= 0) {
      nextX = Math.max(0, initialX - rect.width);
    }
    menuX = nextX;
    menuY = nextY;

    // Focus the first menuitem.
    tick().then(() => {
      const first = menuEl?.querySelector('[role="menuitem"]');
      if (first instanceof HTMLElement) first.focus();
    });
  });

  // -----------------------------------------------------------------
  // Outside-click + Escape handlers attached at <svelte:window>.
  // -----------------------------------------------------------------
  function handleWindowMouseDown(event) {
    if (!menuEl) return;
    const target = event.target;
    if (target instanceof Node && menuEl.contains(target)) return;
    onClose?.();
  }

  function fireAction(actionId) {
    onAction?.(actionId);
    onClose?.();
  }

  function activateItem(index) {
    const item = items[index];
    if (!item) return;
    if (item.submenu) {
      openSubmenu(index);
      return;
    }
    fireAction(item.id);
  }

  async function openSubmenu(index) {
    submenuOpenIndex = index;
    submenuActiveIndex = 0;
    // Position the submenu to the right of the parent row.
    await tick();
    const row = menuEl?.querySelector(`[data-row-index="${index}"]`);
    if (row instanceof HTMLElement) {
      const rect = row.getBoundingClientRect();
      submenuX = rect.right;
      submenuY = rect.top;
      // Focus the first submenu item.
      await tick();
      const firstSub = document.querySelector(
        '[data-testid="channel-ctx-submenu"] [role="menuitem"]'
      );
      if (firstSub instanceof HTMLElement) firstSub.focus();
    }
  }

  function closeSubmenu() {
    if (submenuOpenIndex === null) return;
    const parentIndex = submenuOpenIndex;
    submenuOpenIndex = null;
    // Return focus to the parent row.
    tick().then(() => {
      const row = menuEl?.querySelector(`[data-row-index="${parentIndex}"]`);
      if (row instanceof HTMLElement) row.focus();
    });
  }

  function focusMenuItem(index) {
    const row = menuEl?.querySelector(`[data-row-index="${index}"]`);
    if (row instanceof HTMLElement) row.focus();
  }

  function handleMenuKeydown(event) {
    if (submenuOpenIndex !== null) return;
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = (activeIndex + 1) % items.length;
        activeIndex = next;
        focusMenuItem(next);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = (activeIndex - 1 + items.length) % items.length;
        activeIndex = prev;
        focusMenuItem(prev);
        break;
      }
      case 'ArrowRight': {
        const cur = items[activeIndex];
        if (cur?.submenu) {
          event.preventDefault();
          openSubmenu(activeIndex);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        activateItem(activeIndex);
        break;
      }
      case 'Escape': {
        event.preventDefault();
        event.stopPropagation();
        onClose?.();
        break;
      }
    }
  }

  function handleSubmenuKeydown(event) {
    const sub = items[submenuOpenIndex ?? -1]?.submenu;
    if (!sub) return;
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = (submenuActiveIndex + 1) % sub.length;
        submenuActiveIndex = next;
        focusSubmenuItem(next);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = (submenuActiveIndex - 1 + sub.length) % sub.length;
        submenuActiveIndex = prev;
        focusSubmenuItem(prev);
        break;
      }
      case 'ArrowLeft':
      case 'Escape': {
        event.preventDefault();
        event.stopPropagation();
        closeSubmenu();
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        fireAction(sub[submenuActiveIndex].id);
        break;
      }
    }
  }

  function focusSubmenuItem(index) {
    const root = document.querySelector('[data-testid="channel-ctx-submenu"]');
    if (!root) return;
    const row = root.querySelector(`[data-sub-index="${index}"]`);
    if (row instanceof HTMLElement) row.focus();
  }

  // Hover-open for the submenu (mouse users).
  function handleRowMouseEnter(index) {
    const item = items[index];
    activeIndex = index;
    if (item?.submenu) {
      if (submenuOpenIndex !== index) openSubmenu(index);
    } else if (submenuOpenIndex !== null) {
      submenuOpenIndex = null;
    }
  }
</script>

<svelte:window
  onmousedown={handleWindowMouseDown}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose?.();
    }
  }}
/>

<div
  bind:this={menuEl}
  class="channel-ctx-menu"
  role="menu"
  tabindex="-1"
  data-testid="channel-ctx-menu"
  style:left="{menuX}px"
  style:top="{menuY}px"
  onkeydown={handleMenuKeydown}
>
  {#each items as item, idx (item.id)}
    <button
      type="button"
      class="ctx-row"
      class:danger={item.danger}
      role="menuitem"
      tabindex={idx === activeIndex ? 0 : -1}
      data-row-index={idx}
      data-action-id={item.id}
      data-testid="channel-ctx-item-{item.id}"
      aria-haspopup={item.submenu ? 'menu' : undefined}
      aria-expanded={item.submenu ? submenuOpenIndex === idx : undefined}
      onclick={() => activateItem(idx)}
      onmouseenter={() => handleRowMouseEnter(idx)}
      onfocus={() => { activeIndex = idx; }}
    >
      <item.icon size={14} aria-hidden="true" />
      <span class="ctx-label">{item.label}</span>
      {#if item.submenu}
        <ChevronRight size={12} aria-hidden="true" class="ctx-chevron" />
      {/if}
    </button>
  {/each}
</div>

{#if submenuOpenIndex !== null}
  {@const sub = items[submenuOpenIndex]?.submenu ?? []}
  <div
    class="channel-ctx-menu submenu"
    role="menu"
    tabindex="-1"
    data-testid="channel-ctx-submenu"
    style:left="{submenuX}px"
    style:top="{submenuY}px"
    onkeydown={handleSubmenuKeydown}
  >
    {#each sub as subItem, subIdx (subItem.id)}
      <button
        type="button"
        class="ctx-row"
        role="menuitem"
        tabindex={subIdx === submenuActiveIndex ? 0 : -1}
        data-sub-index={subIdx}
        data-action-id={subItem.id}
        data-testid="channel-ctx-item-{subItem.id}"
        onclick={() => fireAction(subItem.id)}
        onmouseenter={() => { submenuActiveIndex = subIdx; }}
        onfocus={() => { submenuActiveIndex = subIdx; }}
      >
        <subItem.icon size={14} aria-hidden="true" />
        <span class="ctx-label">{subItem.label}</span>
        {#if channel?.muted && subItem.id === 'mute:all'}
          <CheckIcon size={12} aria-hidden="true" class="ctx-check" />
        {/if}
        {#if !channel?.muted && subItem.id === 'mute:off'}
          <CheckIcon size={12} aria-hidden="true" class="ctx-check" />
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .channel-ctx-menu {
    position: fixed;
    z-index: 250;
    min-width: 200px;
    background: rgba(37, 37, 40, 0.96);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm, 8px);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.02);
    padding: 4px;
    animation: ctxMenuIn 0.12s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes ctxMenuIn {
    from { opacity: 0; transform: translateY(-2px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .ctx-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    border: none;
    background: none;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-secondary, #c8c8cf);
    outline: none;
    transition: background 80ms ease, color 80ms ease;
  }

  .ctx-row:hover,
  .ctx-row:focus-visible,
  .ctx-row:focus {
    background: var(--bg-surface, rgba(255, 255, 255, 0.05));
    color: var(--text-primary, #f1f1f3);
  }

  .ctx-row.danger { color: #ef4444; }
  .ctx-row.danger:hover,
  .ctx-row.danger:focus-visible,
  .ctx-row.danger:focus {
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
  }

  .ctx-label { flex: 1; }

  :global(.channel-ctx-menu .ctx-chevron) {
    opacity: 0.6;
  }

  :global(.channel-ctx-menu .ctx-check) {
    opacity: 0.85;
    color: var(--ember-400, #fbbf24);
  }
</style>
