/**
 * lib/resizable-panel.svelte.js — shared drag-to-resize controller for the
 * slide-out side panels (ArtifactPanel + ThreadPanel).
 *
 * This is a `.svelte.js` rune module: it declares `$state` / `$effect`, so
 * `createResizablePanel(...)` MUST be called synchronously during a
 * component's initialization (top of `<script>`), the same contract as any
 * other rune-based "create…" factory.
 *
 * Before this module, ArtifactPanel and ThreadPanel each carried a verbatim
 * copy (~130 lines) of `safeStorage`, `clampWidth`, `initialPanelWidth`, the
 * pointer/keyboard handlers, and the viewport re-clamp `$effect` — differing
 * only in the MIN / MAX / DEFAULT constants and the localStorage key. Any
 * resize bug had to be fixed in two places. This consolidates them.
 *
 * NOTE: mqtt-store.svelte.js keeps its OWN `safeStorage` copy; unifying that
 * third copy is a separate follow-up (different file owner) and is left as a
 * known remaining duplication.
 *
 * Behaviour is byte-for-byte equivalent to the previous in-component logic:
 *   - Width persisted per-panel in localStorage, clamped to [min, max] with a
 *     viewport-aware upper bound that reserves `minChatReserve` px for chat.
 *   - Pointer Events API (mouse + touch + pen) with cursor-to-edge offset so
 *     the grip tracks under the cursor without a jump.
 *   - ARIA window-splitter keyboard nudges (ArrowLeft grows, ArrowRight
 *     shrinks, Home = max, End = min), each committed change persisted.
 *
 * @param {object} opts
 * @param {number} opts.minWidth        - Minimum width in px.
 * @param {number} opts.maxWidth        - Maximum width in px (further clamped by viewport).
 * @param {number} opts.defaultWidth    - Width used when no persisted value exists.
 * @param {string} opts.storageKey      - localStorage key for persistence.
 * @param {number} [opts.minChatReserve=200] - px reserved for the main chat area.
 * @param {number} [opts.keyStep=16]    - Keyboard nudge step in px.
 * @returns {{
 *   readonly width: number,
 *   readonly isResizing: boolean,
 *   minWidth: number,
 *   maxWidth: number,
 *   clampWidth: (w: number) => number,
 *   attachHandle: (node: HTMLElement) => (() => void),
 *   onPointerDown: (e: PointerEvent) => void,
 *   onPointerMove: (e: PointerEvent) => void,
 *   onPointerUp: (e: PointerEvent) => void,
 *   onKeydown: (e: KeyboardEvent) => void,
 * }}
 */
export function createResizablePanel({
  minWidth,
  maxWidth,
  defaultWidth,
  storageKey,
  minChatReserve = 200,
  keyStep = 16,
}) {
  /**
   * Safe localStorage wrapper. Tolerates private browsing / quota errors by
   * silently no-oping.
   */
  const safeStorage = {
    getItem(key) {
      try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
      } catch {
        // localStorage unavailable -- silently ignore
      }
    },
  };

  /**
   * Clamp a requested width to the allowed range, with the upper bound
   * further constrained by the viewport so the panel never covers the whole
   * screen on a laptop.
   */
  function clampWidth(w) {
    const viewport = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const upper = Math.min(maxWidth, Math.max(minWidth, viewport - minChatReserve));
    if (!Number.isFinite(w)) return defaultWidth;
    return Math.max(minWidth, Math.min(upper, w));
  }

  /** Read the persisted width (if any), clamped to the current viewport. */
  function initialPanelWidth() {
    const raw = safeStorage.getItem(storageKey);
    const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
    return clampWidth(Number.isFinite(parsed) ? parsed : defaultWidth);
  }

  let width = $state(initialPanelWidth());
  let isResizing = $state(false);

  /** @type {HTMLElement | null} */
  let handleEl = null;
  /**
   * Offset between the cursor's clientX and the panel's left edge at the
   * moment drag started. Without this, the first pointermove would snap the
   * left edge onto the cursor, causing a visible jump equal to the handle
   * width (or further if the user clicked near the edge of the handle).
   */
  let dragOffsetX = 0;

  /** Attachment that captures the handle element for pointer-capture calls. */
  function attachHandle(node) {
    handleEl = node;
    return () => {
      if (handleEl === node) handleEl = null;
    };
  }

  /**
   * pointerdown on the handle: capture the pointer so move/up fire on the
   * handle even if the cursor leaves the element. Flip into resizing mode to
   * suppress transitions. Record the cursor-to-left-edge offset so subsequent
   * pointermove events can preserve the grip position under the cursor.
   */
  function onPointerDown(e) {
    // Ignore non-primary buttons to avoid right-click dragging.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (!handleEl) return;
    e.preventDefault();
    const viewport = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const panelLeftEdge = viewport - width;
    dragOffsetX = e.clientX - panelLeftEdge;
    isResizing = true;
    try {
      handleEl.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw on detached elements; non-fatal.
    }
  }

  /**
   * pointermove while dragging: maintain the original cursor-to-left-edge
   * offset captured on pointerdown so the handle tracks smoothly under the
   * cursor instead of snapping to it. Clamped to [min, max].
   */
  function onPointerMove(e) {
    if (!isResizing) return;
    const viewport = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const desiredLeftEdge = e.clientX - dragOffsetX;
    width = clampWidth(viewport - desiredLeftEdge);
  }

  /**
   * pointerup / pointercancel: release capture, exit resizing mode, and
   * persist the final width.
   */
  function onPointerUp(e) {
    if (!isResizing) return;
    isResizing = false;
    if (handleEl) {
      try {
        handleEl.releasePointerCapture(e.pointerId);
      } catch {
        // Non-fatal if already released.
      }
    }
    safeStorage.setItem(storageKey, String(Math.round(width)));
  }

  /**
   * Keyboard nudges for the ARIA separator. ArrowLeft grows the panel,
   * ArrowRight shrinks it, matching the visual metaphor of dragging the
   * handle horizontally. Home/End jump to the extremes. Each committed change
   * is persisted.
   */
  function onKeydown(e) {
    let next = width;
    switch (e.key) {
      case 'ArrowLeft':
        next = clampWidth(width + keyStep);
        break;
      case 'ArrowRight':
        next = clampWidth(width - keyStep);
        break;
      case 'Home':
        next = clampWidth(maxWidth);
        break;
      case 'End':
        next = clampWidth(minWidth);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next !== width) {
      width = next;
      safeStorage.setItem(storageKey, String(Math.round(width)));
    }
  }

  /**
   * Re-clamp the stored width whenever the viewport shrinks enough that our
   * current value would cover the chat area.
   */
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      const clamped = clampWidth(width);
      if (clamped !== width) {
        width = clamped;
        safeStorage.setItem(storageKey, String(Math.round(width)));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  return {
    get width() {
      return width;
    },
    get isResizing() {
      return isResizing;
    },
    minWidth,
    maxWidth,
    clampWidth,
    attachHandle,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeydown,
  };
}
