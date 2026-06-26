// lib/safe-storage.js — shared localStorage wrapper.
//
// A plain ES module (no runes) so it can be imported by both rune modules
// (`mqtt-store.svelte.js`, `resizable-panel.svelte.js`) and plain ones, and
// unit-tested in isolation.
//
// `getItem` / `setItem` tolerate environments where `localStorage` is
// unavailable or throws — private browsing, quota exceeded, SSR / Node test
// runs without a DOM — by silently no-oping (return `null` on read, swallow
// on write). This consolidates the byte-identical copies that previously
// lived inside `mqtt-store.svelte.js` and `resizable-panel.svelte.js`
// (#55 follow-up: the third-copy unification flagged in resizable-panel).

/**
 * Safe localStorage wrapper that falls back gracefully when storage is
 * unavailable (private browsing, quota exceeded, etc.).
 */
export const safeStorage = {
  /**
   * @param {string} key
   * @returns {string|null} The stored value, or null if missing/unavailable.
   */
  getItem(key) {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  /**
   * @param {string} key
   * @param {string} value
   */
  setItem(key, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // localStorage unavailable (private browsing, quota exceeded) -- silently ignore
    }
  },
};
