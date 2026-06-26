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
      'mark-read', 'copy-link', 'leave', 'close', 'delete', 'info',
      'notif:cycle', 'notif:configure'
    The component calls `onClose()` immediately after firing onAction.
    v0.4.2 Step 3.9 (Wave G): the new 'notif:cycle' actionId fires
    when the user clicks the kebab quickview row at the top of the
    menu (1-click cycle ``All → Mentions → Off → All``). The new
    'notif:configure' actionId fires when "Configure notifications..."
    is clicked and is the discoverable entry point to the full
    NotificationPolicyMenu popover; the parent (App.svelte) listens
    for the ``claude-comms:configure-notifications`` window
    CustomEvent that this component dispatches alongside the
    actionId emission.
  @prop {Function} onClose - Callback invoked on outside-click, Escape,
    or after any action fires.
  @prop {{policy: 'All' | 'Mentions' | 'Off', highlightWords: string[]}} [currentNotificationPolicy] -
    v0.4.2 Step 3.9 (Wave G): the channel's current notification
    policy, sourced from ``store.getNotificationPolicy`` by the
    parent. Drives the Q8 quickview label at the top of the menu.
    Defaults to ``{policy: 'All', highlightWords: []}`` if omitted
    (e.g. for legacy callers that haven't been updated yet).
-->
<script>
  import { tick } from 'svelte';
  import { portal } from '../lib/portal.js';
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
    UserPlus,
    Settings as SettingsIcon,
  } from 'lucide-svelte';

  let {
    channel,
    anchorEvent,
    isMember = false,
    isCreator = false,
    // True when the caller holds the per-channel ``owner`` or ``admin``
    // role (hydrated from the server via ``comms_get_channel_role``).
    // Combined with ``isCreator`` to gate the admin affordances so a real
    // admin who did not literally create the channel still sees them.
    isAdminOrOwner = false,
    // True when the channel is reserved (``general`` / ``system``). The
    // daemon hard-refuses delete/archive on these regardless of role, so
    // we suppress those affordances rather than offer an always-403 action.
    isReserved = false,
    onAction,
    onClose,
    currentNotificationPolicy = { policy: 'All', highlightWords: [] },
  } = $props();

  // Unified admin gate: the original creator OR an owner/admin role-holder.
  // Replaces the old ``isCreator``-only rule for Close/Delete so both the
  // sidebar menu and the directory Admin panel use one consistent rule.
  const canAdmin = $derived(isCreator || isAdminOrOwner);

  // -----------------------------------------------------------------
  // Action visibility — computed up-front so keyboard nav can address
  // the rendered list by index without re-deriving on each keystroke.
  // Each entry: { id, label, icon, danger?, submenu? }
  // -----------------------------------------------------------------
  // v0.4.2 Step 3.9 (Wave G) — Q8 kebab quickview row + Configure item.
  // The quickview is the top-most row when the caller is a member; it
  // shows the current policy ("Notifications: <policy>") and a single
  // click cycles to the next state (All → Mentions → Off → All) via
  // the 'notif:cycle' actionId. The "Configure notifications..." row
  // sits next to the mute submenu and opens the full
  // NotificationPolicyMenu popover via the 'notif:configure' actionId
  // (which also dispatches a ``claude-comms:configure-notifications``
  // window CustomEvent for the parent to consume).
  const notifPolicyIcon = $derived.by(() => {
    switch (currentNotificationPolicy?.policy) {
      case 'Off':
        return BellOff;
      case 'Mentions':
        return BellRing;
      case 'All':
      default:
        return Bell;
    }
  });

  const items = $derived.by(() => {
    const list = [];
    const hasUnread = (channel?.unread ?? 0) > 0;

    if (isMember) {
      // Order preserves the v0.4.0 keyboard-nav contract for the
      // first two rows (idx 0=toggle-star, idx 1=mute-submenu) so
      // existing test fixtures + muscle memory stay valid. The Q8
      // quickview row + Configure-notifications entry point land
      // immediately after the legacy Mute submenu — still "near the
      // top" per Phil's G1 lock-in (top 4 of a 10-item menu) without
      // shifting the indices the existing test suite has internalized.
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
      // Q8 quickview — 1-click cycle All → Mentions → Off → All.
      list.push({
        id: 'notif:cycle',
        label: `Notifications: ${currentNotificationPolicy?.policy ?? 'All'}`,
        icon: notifPolicyIcon,
        quickview: true,
      });
      // Discoverable full-popover entry point for power-users that want
      // to set highlight-words or pick a policy without cycling.
      list.push({
        id: 'notif:configure',
        label: 'Configure notifications...',
        icon: SettingsIcon,
      });
      if (hasUnread) {
        list.push({
          id: 'mark-read',
          label: 'Mark all as read',
          icon: CheckCheck,
        });
      }
      // v0.4.2 Step 3.3 (Wave F): Invite participant... Visible to any
      // member; the server enforces auth and re-invite returns 409 so
      // we don't need a role gate client-side. Activation dispatches a
      // ``claude-comms:invite-participant`` window CustomEvent carrying
      // the channel object; App.svelte listens and mounts
      // ``InviteParticipantDialog``. Sidebar's existing
      // ``handleContextAction`` switch will no-op on this actionId,
      // which is the intentional integration pattern (Sidebar stays
      // read-only per the Wave F file ownership table).
      list.push({
        id: 'invite',
        label: 'Invite participant...',
        icon: UserPlus,
      });
    }

    list.push({ id: 'copy-link', label: 'Copy channel link', icon: LinkIcon });

    if (isMember && !canAdmin) {
      list.push({ id: 'leave', label: 'Leave', icon: LogOut, danger: true });
    }
    // Close (archive) + Delete are admin affordances. Suppress them on
    // reserved channels (#general / #system) since the daemon refuses
    // delete/archive there regardless of role.
    if (isMember && canAdmin && !isReserved) {
      list.push({ id: 'close', label: 'Close', icon: Archive });
    }
    if (canAdmin && !isReserved) {
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
    if (target instanceof Node) {
      if (menuEl.contains(target)) return;
      // The Mute submenu is portaled to <body> (see {@attach portal()} on
      // the submenu root), so it is NOT inside `menuEl`. Without this check a
      // real mouse click on a submenu item fires mousedown first → we'd close
      // the menu before the click/action fired (mouse Mute was unreachable).
      const submenuEl = document.querySelector('[data-testid="channel-ctx-submenu"]');
      if (submenuEl && submenuEl.contains(target)) return;
    }
    onClose?.();
  }

  function fireAction(actionId) {
    // v0.4.2 Step 3.3 (Wave F): the Invite action skips the standard
    // ``onAction`` routing through Sidebar (which is read-only in this
    // wave and has no handler for ``'invite'``) and emits a window-
    // level CustomEvent that App.svelte listens for. The event detail
    // carries the channel object so App.svelte can populate
    // ``InviteParticipantDialog`` without re-resolving the row.
    if (
      actionId === 'invite' &&
      typeof window !== 'undefined' &&
      typeof CustomEvent === 'function'
    ) {
      try {
        window.dispatchEvent(
          new CustomEvent('claude-comms:invite-participant', {
            detail: { channel },
          }),
        );
      } catch {
        // Defensive: if the host environment disallows CustomEvent
        // construction, fall back to the standard onAction path so
        // a future Sidebar handler can still pick it up.
      }
    }
    // v0.4.2 Step 3.9 (Wave G): the Configure-notifications action
    // mirrors the Invite pattern — Sidebar.svelte is read-only in
    // this wave, so we bus through a window CustomEvent that
    // App.svelte listens for and mounts NotificationPolicyMenu.
    // The event detail carries the channel object so App.svelte can
    // seed the popover from ``store.getNotificationPolicy`` without
    // re-resolving the row.
    if (
      actionId === 'notif:configure' &&
      typeof window !== 'undefined' &&
      typeof CustomEvent === 'function'
    ) {
      try {
        window.dispatchEvent(
          new CustomEvent('claude-comms:configure-notifications', {
            detail: { channel },
          }),
        );
      } catch {
        // Defensive: same fallback rationale as the invite path above.
      }
    }
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

<!--
  v0.4.4 hotfix (Bug 1): portal the menu into ``document.body`` via the
  ``portal`` attachment so it escapes any ancestor stacking context
  created by ``backdrop-filter`` on neighbouring panels (ArtifactPanel /
  ThreadPanel / SearchPanel / SettingsPanel all use it). Combined with
  ``z-index: 9999`` below the menu paints above all other UI regardless
  of where in the DOM it was declared.
-->
<div
  bind:this={menuEl}
  class="channel-ctx-menu"
  role="menu"
  tabindex="-1"
  data-testid="channel-ctx-menu"
  style:left="{menuX}px"
  style:top="{menuY}px"
  onkeydown={handleMenuKeydown}
  {@attach portal()}
>
  {#each items as item, idx (item.id)}
    <button
      type="button"
      class="ctx-row"
      class:danger={item.danger}
      class:quickview={item.quickview}
      role="menuitem"
      tabindex={idx === activeIndex ? 0 : -1}
      data-row-index={idx}
      data-action-id={item.id}
      data-testid="channel-ctx-item-{item.id}"
      data-quickview={item.quickview ? 'true' : undefined}
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
    {@attach portal()}
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
    /* v0.4.4 hotfix (Bug 1): max-out z-index above every other layer.
       Used alongside the {@attach portal()} relocation which lifts the
       element to <body>, escaping any ancestor stacking context
       (backdrop-filter / filter / transform create them). Either fix
       in isolation is fragile; both together guarantee top-layer
       paint. */
    z-index: 9999;
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

  /* v0.4.2 Step 3.9 (Wave G) — Q8 quickview row. Visually distinct
     from the rest of the menu so users see at a glance that one click
     here is a state cycle, not a sub-menu opener. Brighter text color
     + medium weight signals "current state badge"; no border dividers
     since the row sits in the middle of the menu, not at a section
     boundary. */
  .ctx-row.quickview {
    color: var(--text-primary, #f1f1f3);
    font-weight: 500;
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
