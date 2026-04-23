/**
 * lib/autoresize.js — `{@attach autoresize}` helper for the artifact editor's
 * textarea (plan §4 R4-2 / R5-5 / R6-3).
 *
 * Plain `.js` module (no runes) — imported by `ArtifactEditor.svelte` and used
 * via the Svelte 5.29+ attachment idiom `<textarea {@attach autoresize}>`.
 *
 * Responsibilities:
 *  - Auto-grow the textarea height to fit its scrollHeight, clamped by a
 *    dynamic max computed from the current viewport and any remote-update
 *    banner that may push the editor down.
 *  - Throttle recalcs to at most one per animation frame to avoid
 *    `ResizeObserver loop` warnings (R5-5).
 *  - Track the banner element appearing / disappearing via a scoped
 *    MutationObserver (childList only, no subtree, per R6-3).
 *  - Listen for viewport resizes, and re-measure when the banner resizes.
 *  - Clean everything up on destroy so switching artifacts doesn't leak
 *    listeners or observers.
 *
 * Signature: `autoresize(node)` → `{ destroy() }`. Matches both the Svelte 4
 * `use:` action shape and the Svelte 5 `{@attach}` cleanup contract (a bare
 * function return is also valid, but returning `{ destroy }` keeps backwards
 * compatibility with tests that call `.destroy()` directly).
 *
 * @param {HTMLTextAreaElement} node - The textarea to auto-grow.
 * @returns {{ destroy: () => void }}
 */
export function autoresize(node) {
  /** @type {number | null} */
  let rafHandle = null;
  /** @type {Element | null} */
  let lastBannerNode = null;
  /** @type {ResizeObserver | null} */
  let bannerObserver = null;

  const recalc = () => {
    const banner =
      typeof document !== 'undefined'
        ? document.querySelector('.remote-update-banner')
        : null;
    const bannerH = banner ? /** @type {HTMLElement} */ (banner).offsetHeight + 8 : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const maxH = Math.min(vh - 320 - bannerH, 720);
    // Reset height so scrollHeight reflects the content, not the old height.
    node.style.height = 'auto';
    const next = Math.min(node.scrollHeight, Math.max(maxH, 0));
    node.style.height = `${next}px`;
  };

  const schedule = () => {
    if (rafHandle !== null) return; // already scheduled this frame
    if (typeof requestAnimationFrame === 'undefined') {
      // jsdom fallback — synchronous recalc is fine in tests.
      recalc();
      return;
    }
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      recalc();
    });
  };

  // Watch for the banner element coming / going so we can (re-)observe its size.
  const rebindBannerObserver = () => {
    const current =
      typeof document !== 'undefined'
        ? document.querySelector('.remote-update-banner')
        : null;
    if (current === lastBannerNode) return;
    if (bannerObserver) {
      bannerObserver.disconnect();
      bannerObserver = null;
    }
    lastBannerNode = current;
    if (current && typeof ResizeObserver !== 'undefined') {
      bannerObserver = new ResizeObserver(schedule);
      bannerObserver.observe(current);
    }
    schedule();
  };

  // MutationObserver scoped to direct children only — the banner is a direct
  // child of the panel body per the §1 spec. subtree:false avoids reacting to
  // every markdown re-render, toast animation, or dropdown-state change.
  /** @type {MutationObserver | null} */
  let mo = null;
  const mutationRoot = node.parentElement || (typeof document !== 'undefined' ? document.body : null);
  if (mutationRoot && typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(rebindBannerObserver);
    mo.observe(mutationRoot, { childList: true, subtree: false });
  }

  const onInput = () => schedule();
  const onResize = () => schedule();
  node.addEventListener('input', onInput);
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
  }

  rebindBannerObserver();
  schedule(); // initial measurement

  return {
    destroy() {
      if (rafHandle !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      node.removeEventListener('input', onInput);
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onResize);
      }
      if (bannerObserver) {
        bannerObserver.disconnect();
        bannerObserver = null;
      }
      if (mo) {
        mo.disconnect();
        mo = null;
      }
      lastBannerNode = null;
    },
  };
}
