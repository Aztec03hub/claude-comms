<!--
  @component MemberContextMenu
  @description Right-click context menu for a member row in the right
    sidebar (v0.4.2 Step 3.5b, Wave E.4). Mirrors ChannelContextMenu's
    visual + keyboard contract: role="menu" with menuitems, ArrowUp /
    ArrowDown navigation, Enter / Space activation, Escape + outside-
    click closes. Positioning is fixed at the cursor coordinates; if the
    rendered rect would overflow the viewport the menu flips up + / or
    left so it stays on screen.

    Action set (visibility computed from ``currentChannelRole`` +
    ``member.key`` vs ``currentUserKey``):

      - "Kick from #..."     visible when ``currentChannelRole`` is
                             'owner' or 'admin' AND the target is not
                             the caller (we never kick ourselves; that
                             affordance lives in the channel menu's
                             "Leave" action).
      - "Mute globally"     / "Unmute globally" -- toggled label based
                             on ``store.isUserGloballyMuted(target)``.
                             Always visible for any other user; never
                             for self.
      - "Start a DM"         visible when ``member.key !== currentUserKey``.

    The parent (App.svelte) owns the actual store calls + the
    destructive-confirm dialog: this component only emits the
    chosen actionId via ``onAction(actionId)`` and then calls
    ``onClose()`` so the menu unmounts.

  @prop {object} member - Member row object (consults .key, .name,
    .type). Required.
  @prop {object} channel - Channel object containing at minimum
    ``.id`` and ``.name`` so the Kick label can render
    ``Kick from #channel-name``. Required.
  @prop {'owner' | 'admin' | 'member' | null} currentChannelRole -
    Caller's per-channel role; drives Kick visibility.
  @prop {string} currentUserKey - Caller's 8-hex-char participant
    key; the row referencing self filters its own DM / kick / mute
    affordances out so the menu can't act on the caller's own row.
  @prop {boolean} isMuted - Snapshot of the global-mute state for
    the target. The parent reads it from ``store.isUserGloballyMuted``
    so the menu doesn't have to import the store; the menu just
    renders the label and emits the toggle action.
  @prop {number} x - clientX cursor coord (mouse event-based).
  @prop {number} y - clientY cursor coord.
  @prop {Function} onAction - Callback ``(actionId: string) => void``
    invoked once on click / Enter. Possible actionIds:
      'kick', 'mute', 'unmute', 'dm'
    The component calls ``onClose()`` immediately after firing
    onAction.
  @prop {Function} onClose - Callback invoked on outside-click,
    Escape, or after any action fires.
-->
<script>
  import { tick } from 'svelte';
  import { UserX, BellOff, Bell, MessageSquare } from 'lucide-svelte';
  import { portal } from '../lib/portal.js';

  let {
    member,
    channel,
    currentChannelRole = 'member',
    currentUserKey = '',
    isMuted = false,
    x = 0,
    y = 0,
    onAction,
    onClose,
  } = $props();

  // -----------------------------------------------------------------
  // Action visibility. Computed once per render via $derived so the
  // keyboard nav can address the rendered list by index.
  //
  // v0.4.4 hotfix (Bug 4): the self row STILL mounts the menu - Phil's
  // Layer B pass against v0.4.3 caught that right-clicking own username
  // emitted nothing visible (no error, no menu). Pre-fix, when ALL
  // items were filtered out for self the entire ``{#if items.length}``
  // gate kept the menu un-rendered, so the user saw no feedback. Post-
  // fix the menu always mounts when invoked; self-row shows a single
  // "No actions available" empty-state if nothing applies. In practice
  // the only items that hide for self are Kick (owner/admin only) and
  // DM (start-a-dm to self is nonsensical); Mute-globally is now
  // VISIBLE for self too so users can mute their own notifications
  // chain across the app (matches Slack's "Pause notifications" being
  // available from anywhere including one's own row).
  // -----------------------------------------------------------------
  let isSelf = $derived(
    typeof currentUserKey === 'string' &&
      currentUserKey &&
      member?.key === currentUserKey,
  );
  let canKick = $derived(
    !isSelf &&
      (currentChannelRole === 'owner' || currentChannelRole === 'admin'),
  );
  let canDM = $derived(!isSelf);
  // Mute globally is available for self too (W-12 mitigation per v0.4.4
  // iteration log): users get visible feedback that the right-click was
  // registered, and self-muting is a legitimate "quiet hours" toggle.
  let canMute = $derived(true);

  let items = $derived.by(() => {
    const list = [];
    if (canKick) {
      list.push({
        id: 'kick',
        label: `Kick from #${channel?.name ?? channel?.id ?? ''}`,
        icon: UserX,
        danger: true,
      });
    }
    if (canMute) {
      list.push(
        isMuted
          ? { id: 'unmute', label: 'Unmute globally', icon: Bell }
          : { id: 'mute', label: 'Mute globally', icon: BellOff },
      );
    }
    if (canDM) {
      list.push({ id: 'dm', label: 'Start a DM', icon: MessageSquare });
    }
    return list;
  });

  // -----------------------------------------------------------------
  // Position state. Default to the supplied cursor coords; once the
  // menu element mounts, the $effect below measures its rect and
  // flips up / left if it would overflow the viewport. Mount /
  // unmount per right-click in the parent so a stale anchor cannot
  // persist between menu instances.
  // -----------------------------------------------------------------
  let menuX = $state(0);
  let menuY = $state(0);
  let menuEl = $state(/** @type {HTMLElement | null} */ (null));
  let activeIndex = $state(0);

  let positioned = false;
  $effect(() => {
    if (!menuEl || positioned) return;
    positioned = true;

    const rect = menuEl.getBoundingClientRect();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;

    let nextY = y;
    if (y + rect.height > vh && y - rect.height >= 0) {
      nextY = Math.max(0, y - rect.height);
    }
    let nextX = x;
    if (x + rect.width > vw && x - rect.width >= 0) {
      nextX = Math.max(0, x - rect.width);
    }
    menuX = nextX;
    menuY = nextY;

    tick().then(() => {
      const first = menuEl?.querySelector('[role="menuitem"]');
      if (first instanceof HTMLElement) first.focus();
    });
  });

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
    fireAction(item.id);
  }

  function focusMenuItem(index) {
    const row = menuEl?.querySelector(`[data-row-index="${index}"]`);
    if (row instanceof HTMLElement) row.focus();
  }

  function handleMenuKeydown(event) {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (items.length === 0) return;
        const next = (activeIndex + 1) % items.length;
        activeIndex = next;
        focusMenuItem(next);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (items.length === 0) return;
        const prev = (activeIndex - 1 + items.length) % items.length;
        activeIndex = prev;
        focusMenuItem(prev);
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
  v0.4.4 hotfix (Bug 1 + Bug 4): the menu ALWAYS mounts when invoked so
  users get visible feedback (Bug 4); it is portaled into ``document.body``
  via the ``portal`` attachment so it escapes any ancestor stacking context
  (the right-side ArtifactPanel / ThreadPanel / SearchPanel / SettingsPanel
  all use ``backdrop-filter`` which creates a new stacking context that a
  ``position: fixed`` element declared INSIDE the sidebar cannot escape via
  z-index alone). The portal lifts the menu out of ``.app-layout``
  entirely; combined with ``z-index: 9999`` the menu paints above every
  other UI surface (Bug 1).
-->
<div
  bind:this={menuEl}
  class="member-ctx-menu"
  role="menu"
  tabindex="-1"
  data-testid="member-ctx-menu"
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
      role="menuitem"
      tabindex={idx === activeIndex ? 0 : -1}
      data-row-index={idx}
      data-action-id={item.id}
      data-testid="member-ctx-item-{item.id}"
      onclick={() => activateItem(idx)}
      onmouseenter={() => {
        activeIndex = idx;
      }}
      onfocus={() => {
        activeIndex = idx;
      }}
    >
      <item.icon size={14} aria-hidden="true" />
      <span class="ctx-label">{item.label}</span>
    </button>
  {/each}
  {#if items.length === 0}
    <!--
      v0.4.4 hotfix (Bug 4): empty-state for the rare case that every
      action filters out (e.g. self-row with future role rules). Shows
      "No actions available" so the user sees the menu opened + sees
      that nothing applies, rather than the menu silently failing to
      mount (which was the pre-fix bug).
    -->
    <div
      class="ctx-empty"
      role="menuitem"
      aria-disabled="true"
      data-testid="member-ctx-empty"
    >
      No actions available
    </div>
  {/if}
</div>

<style>
  .member-ctx-menu {
    position: fixed;
    /* v0.4.4 hotfix (Bug 1): max-out z-index above every other layer
       in the app. Used alongside the {@attach portal()} relocation
       which lifts the element to <body>, escaping any ancestor
       stacking context. Either fix in isolation is fragile; both
       together guarantee top-layer paint. */
    z-index: 9999;
    min-width: 200px;
    background: rgba(37, 37, 40, 0.96);
    backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm, 8px);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5),
      0 0 0 1px rgba(255, 255, 255, 0.02);
    padding: 4px;
    animation: ctxMenuIn 0.12s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes ctxMenuIn {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
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

  .ctx-row.danger {
    color: #ef4444;
  }
  .ctx-row.danger:hover,
  .ctx-row.danger:focus-visible,
  .ctx-row.danger:focus {
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
  }

  .ctx-label {
    flex: 1;
  }

  /* v0.4.4 hotfix (Bug 4): empty-state row when every action filters
     out. Visually muted + not interactive (aria-disabled) but still
     present so users see the menu opened. */
  .ctx-empty {
    padding: 7px 10px;
    font-size: 12px;
    color: var(--text-faint, #8a8a90);
    font-style: italic;
    pointer-events: none;
  }
</style>
