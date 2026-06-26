/**
 * top-layer.svelte.js - the `topLayer` Svelte action (Overlay overhaul,
 * Phase 1, design §C).
 *
 * A single primitive that drives the browser **native top layer** for
 * floating overlays, so they escape EVERY ancestor stacking context
 * (`overflow` / `transform` / `filter` / `backdrop-filter` / `z-index`)
 * without any portal or manual z-index:
 *
 *   - modal: true  -> a `<dialog>` element via `showModal()` (backdrop +
 *                     focus-trap + inert background, native `::backdrop`).
 *   - modal: false -> the Popover API: `element.popover = dismiss` +
 *                     `showPopover()` ('auto' = light-dismiss, 'manual' =
 *                     component-controlled).
 *
 * Anchored positioning is done in JS with `getBoundingClientRect` (NOT CSS
 * anchor positioning, which is not yet Baseline) and re-run on capture-phase
 * `scroll` + `resize`, matching the existing context-menu pattern.
 *
 * ── CRITICAL capability-guard (design §F.3) ──────────────────────────────
 * jsdom 29.0.2 (the vitest DOM) implements NONE of the top-layer APIs:
 * no `showModal`/`showPopover`/`hidePopover`/`close`, no popover attribute,
 * no `:popover-open`/`:modal`, no `elementFromPoint`. Calling the native
 * show methods under vitest would throw and break every component unit test
 * that merely `render()`s an overlay.
 *
 * The action therefore DETECTS the absence of each native method
 * (`typeof node.showPopover !== 'function'` / `typeof node.showModal !==
 * 'function'`) and DEGRADES GRACEFULLY: it skips the native show/hide call
 * but still wires the `toggle`/`cancel` events, runs anchored positioning,
 * and performs the initial focus. Result: overlays still mount and behave
 * in jsdom (so unit tests pass), while the actual top-layer paint is only
 * exercised in real Chromium (Playwright Tier-2). The "actually on top"
 * assertion lives in `web/e2e/fixtures/topLayer.ts`.
 *
 * @typedef {Object} TopLayerOpts
 * @property {boolean} [modal=false] true -> `dialog.showModal()`; false ->
 *   `element.showPopover()`.
 * @property {'auto'|'manual'} [dismiss='auto'] popover light-dismiss vs
 *   component-controlled. Ignored when `modal:true` (modal is always
 *   Esc-dismiss via the native `cancel` event).
 * @property {HTMLElement|(() => (DOMRect|null))|null} [anchor] trigger
 *   element or a rect getter. Present => anchored positioning; absent =>
 *   centered (let `<dialog>` / CSS handle it).
 * @property {string} [placement='bottom-start'] e.g. 'bottom-start',
 *   'top-start', 'bottom-end', 'top-end'.
 * @property {number} [offset=6] px gap from the anchor.
 * @property {() => void} [onClose] fired on Esc / light-dismiss.
 * @property {boolean} [open] optional controlled flag; when omitted the
 *   action opens on mount.
 * @property {boolean} [trapInitialFocus=true] focus the first
 *   `[autofocus]`/`[data-autofocus]` element (or the node) on open.
 * @property {boolean} [restoreFocus=true] return focus to the
 *   previously-focused element on close.
 */

const DEFAULTS = {
  modal: false,
  dismiss: 'auto',
  anchor: null,
  placement: 'bottom-start',
  offset: 6,
  trapInitialFocus: true,
  restoreFocus: true,
};

const raf = (cb) =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : setTimeout(cb, 0);
const cancelRaf = (id) =>
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame(id)
    : clearTimeout(id);

/**
 * Pure positioning math. Exported so the rect logic can be unit-tested
 * without a real top layer. Returns clamped {left, top} in px for a panel
 * of size `panel` placed relative to anchor `rect`.
 *
 * @param {DOMRect|{top:number,bottom:number,left:number,right:number}} rect
 * @param {{width:number,height:number}} panel
 * @param {{placement?:string, offset?:number, viewportWidth:number, viewportHeight:number}} cfg
 * @returns {{left:number, top:number}}
 */
export function computePosition(rect, panel, cfg) {
  const placement = cfg.placement ?? 'bottom-start';
  const offset = cfg.offset ?? 6;
  const vw = cfg.viewportWidth;
  const vh = cfg.viewportHeight;

  let top = placement.startsWith('top')
    ? rect.top - panel.height - offset
    : rect.bottom + offset;
  let left = placement.endsWith('end') ? rect.right - panel.width : rect.left;

  left = Math.max(8, Math.min(left, vw - panel.width - 8));
  top = Math.max(8, Math.min(top, vh - panel.height - 8));
  return { left, top };
}

/**
 * The `topLayer` Svelte action.
 *
 * @param {HTMLElement} node
 * @param {TopLayerOpts} [opts]
 */
export function topLayer(node, opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  // Capability detection - see the file header. We capture these ONCE; the
  // jsdom env never grows the methods mid-test.
  const canModal = typeof node.showModal === 'function';
  const canPopover = typeof node.showPopover === 'function';

  const prevFocus =
    typeof document !== 'undefined'
      ? /** @type {HTMLElement|null} */ (document.activeElement)
      : null;

  let rafId = 0;
  let isOpen = false;
  let disposed = false;

  function rectOf() {
    if (typeof o.anchor === 'function') return o.anchor();
    if (typeof HTMLElement !== 'undefined' && o.anchor instanceof HTMLElement) {
      return o.anchor.getBoundingClientRect();
    }
    return null;
  }

  function position() {
    const rect = rectOf();
    if (!rect) return; // centered: let <dialog>/CSS handle it
    const { left, top } = computePosition(
      rect,
      { width: node.offsetWidth, height: node.offsetHeight },
      {
        placement: o.placement,
        offset: o.offset,
        viewportWidth: typeof innerWidth === 'number' ? innerWidth : 0,
        viewportHeight: typeof innerHeight === 'number' ? innerHeight : 0,
      },
    );
    // Defeat the popover UA `inset:0; margin:auto` centering so our explicit
    // coordinates take effect.
    node.style.position = 'fixed';
    node.style.margin = '0';
    node.style.inset = 'auto';
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  const reflow = () => {
    cancelRaf(rafId);
    rafId = raf(position);
  };

  function addReflowListeners() {
    if (!rectOf()) return;
    addEventListener('resize', reflow);
    addEventListener('scroll', reflow, true); // capture phase
  }
  function removeReflowListeners() {
    removeEventListener('resize', reflow);
    removeEventListener('scroll', reflow, true);
  }

  function focusInitial() {
    if (!o.trapInitialFocus) return;
    const target =
      node.querySelector('[autofocus],[data-autofocus]') || node;
    /** @type {HTMLElement} */ (target).focus?.();
  }

  function open() {
    if (isOpen) return;
    if (o.modal) {
      // The <Modal> wrapper guarantees `node` is a <dialog>. Guarded so
      // jsdom (no showModal) still mounts.
      if (canModal && !node.open) node.showModal();
    } else if (canPopover) {
      node.popover = o.dismiss; // 'auto' = light-dismiss; 'manual' = controlled
      node.showPopover();
    }
    // Positioning + focus run regardless of native support so jsdom unit
    // tests observe a mounted, positioned, focused overlay.
    position();
    addReflowListeners();
    focusInitial();
    isOpen = true;
  }

  function close() {
    if (!isOpen) return;
    try {
      if (o.modal) {
        if (canModal) node.close();
      } else if (canPopover) {
        node.hidePopover();
      }
    } catch {
      /* already closed / not in top layer - ignore */
    }
    removeReflowListeners();
    isOpen = false;
  }

  // Native dismiss surfaces: popover light-dismiss/Esc -> `toggle`
  // (newState 'closed'); dialog Esc -> `cancel`. Both notify the parent via
  // onClose. We do NOT call onClose from destroy() (the parent already
  // initiated that close), so listeners are removed first in destroy().
  const onToggle = (e) => {
    if (disposed) return;
    if (e.newState === 'closed') o.onClose?.();
  };
  const onCancel = () => {
    if (!disposed) o.onClose?.();
  };
  node.addEventListener('toggle', onToggle);
  node.addEventListener('cancel', onCancel);

  if (o.open !== false) open();

  return {
    /** @param {TopLayerOpts} next */
    update(next) {
      const hadOpenKey = next && 'open' in next;
      Object.assign(o, next);
      if (hadOpenKey) {
        if (next.open) open();
        else close();
      }
      if (isOpen) reflow();
    },
    destroy() {
      disposed = true;
      node.removeEventListener('toggle', onToggle);
      node.removeEventListener('cancel', onCancel);
      close();
      if (o.restoreFocus) prevFocus?.focus?.();
    },
  };
}
