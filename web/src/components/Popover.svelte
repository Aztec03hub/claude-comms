<!--
  @component Popover (Overlay overhaul, Phase 1, design §C)
  @description Thin wrapper around the `topLayer` action for NON-MODAL,
  light-dismiss (or component-controlled) floating overlays: status
  editors, dropdowns, anchored menus, pickers, tooltips. Renders a single
  positioning `<div>` promoted into the browser native top layer via the
  Popover API (`showPopover()`), so it escapes every ancestor stacking
  context (`overflow` / `transform` / `backdrop-filter` / `z-index`) with
  NO portal and NO manual z-index.

  Anchored positioning is handled by the action (`getBoundingClientRect`
  re-run on capture-phase scroll + resize). Pass an `anchor` element (or a
  rect getter) to anchor; omit it to center.

  Any extra attributes (`class`, `data-testid`, `role`, `aria-label`,
  `tabindex`, ...) are spread onto the popover element, so callers keep
  full control of semantics and styling. Visual styling of the panel is
  the caller's responsibility (this wrapper adds none).

  @prop {HTMLElement|(() => (DOMRect|null))|null} [anchor]
  @prop {string} [placement='bottom-start']
  @prop {number} [offset=6]
  @prop {'auto'|'manual'} [dismiss='auto']
  @prop {() => void} [onClose]
  @prop {import('svelte').Snippet} [children]
-->
<script>
  import { topLayer } from '../lib/top-layer.svelte.js';

  /**
   * @type {{
   *   anchor?: HTMLElement | (() => (DOMRect|null)) | null,
   *   placement?: string,
   *   offset?: number,
   *   dismiss?: 'auto' | 'manual',
   *   onClose?: () => void,
   *   children?: import('svelte').Snippet,
   *   [key: string]: unknown,
   * }}
   */
  let {
    anchor = null,
    placement = 'bottom-start',
    offset = 6,
    dismiss = 'auto',
    onClose,
    children,
    ...rest
  } = $props();
</script>

<div use:topLayer={{ anchor, placement, offset, dismiss, onClose }} {...rest}>
  {@render children?.()}
</div>
