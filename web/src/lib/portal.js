/**
 * Portal attachment for Svelte 5.
 *
 * Relocates an element to ``document.body`` (or a supplied target) for the
 * duration of its mount. Used by the v0.4.4 hotfix for the right-click
 * context menus (``MemberContextMenu`` / ``ChannelContextMenu``) so the
 * menu escapes any ancestor stacking context created by ``backdrop-filter``
 * / ``filter`` / ``transform`` / ``contain: paint`` and renders above all
 * other UI regardless of where in the DOM it was declared.
 *
 * Why ``backdrop-filter`` matters: ArtifactPanel, ThreadPanel, SearchPanel,
 * and SettingsPanel all set ``backdrop-filter`` which establishes a new
 * stacking context per CSS Containment Module Level 1. An element with
 * ``position: fixed; z-index: 250`` declared INSIDE a sidebar component
 * (whose ancestor chain ends at ``.app-layout``) can NOT escape that
 * stacking context - it's painted in document order against its siblings.
 * The right-side panels then render OVER it because they appear later in
 * the DOM tree under ``.app-layout``. The portal lifts the element out of
 * ``.app-layout`` entirely so its z-index applies against ``<body>``.
 *
 * @typedef {import('svelte/attachments').Attachment} Attachment
 *
 * @param {HTMLElement} [target] - The element to move into. Defaults to
 *   ``document.body``. Tests can override.
 * @returns {Attachment} A Svelte 5 attachment.
 */
export function portal(target) {
  return (node) => {
    if (typeof document === 'undefined') return; // SSR safety
    const dest = target ?? document.body;
    // Remember the original parent so we restore the node on cleanup. If
    // the node was already in the destination (rare; e.g. re-running
    // attachment), no-op the move.
    const originalParent = node.parentNode;
    if (originalParent !== dest) {
      dest.appendChild(node);
    }
    return () => {
      // On cleanup, remove from the portal target. The component is
      // unmounting; we don't need to restore to the original parent
      // because Svelte will be tearing down the original mount point too.
      if (node.parentNode === dest) {
        dest.removeChild(node);
      }
    };
  };
}
