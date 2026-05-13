// Central keyboard shortcut registry — v0.4.0 Step 2.17.
//
// Lives at the application root: App.svelte instantiates ONE registry on
// mount, registers per-binding handlers, and lets the registry own the
// `window.keydown` listener for the lifetime of the app. The registry
// intentionally keeps no DOM coupling beyond a single `keydown` listener,
// so unit tests can exercise it against a synthetic ``KeyboardEvent``
// without rendering any components.
//
// PUBLIC SURFACE (test contract):
//   - ``new KeyboardRegistry()`` — wires the listener (idempotent — calling
//     ``destroy()`` removes it).
//   - ``register(combo, handler, opts?)`` — combos serialize as
//     ``[Ctrl+][Alt+][Shift+]<key>`` per ``#serializeCombo``. Re-registering
//     the same combo overwrites the previous handler.
//   - ``unregister(combo)`` — removes a binding.
//   - ``setDescription(combo, label)`` — register a human-readable label for
//     the help overlay (Step 2.17 spec: bindings list + descriptions).
//   - ``bindings`` (``$state``) — reactive map of combo → handler.
//   - ``descriptions`` (``$state``) — reactive map of combo → label.
//   - ``helpVisible`` (``$state``) — bound by the help overlay component.
//   - ``destroy()`` — removes the window listener (idempotent, SSR-safe).
//
// Focus context rule (§III.4 step 2.17): every binding EXCEPT ``Escape``
// is suppressed when the keydown target is an ``INPUT``/``TEXTAREA`` or a
// ``contenteditable`` element. Escape always fires so the universal-close
// path works even when focus is in a search box.
//
// Combo serialization: modifier order is ``Ctrl+Alt+Shift+<key>`` and the
// key portion is lower-cased so ``Ctrl+L`` and ``Ctrl+l`` map to the same
// binding (browser yields different cases depending on Shift). ``Ctrl``
// covers ``ctrlKey`` OR ``metaKey`` so macOS Cmd+L also matches.

/**
 * @typedef {(event: KeyboardEvent) => void} KeyboardHandler
 */

export class KeyboardRegistry {
  /** @type {Record<string, KeyboardHandler>} */
  bindings = $state({});

  /** @type {Record<string, string>} */
  descriptions = $state({});

  /** Whether the help overlay is currently visible. App.svelte binds to this. */
  helpVisible = $state(false);

  /** @type {((event: KeyboardEvent) => void) | null} */
  #boundListener = null;

  constructor() {
    this.#installListener();
  }

  /**
   * Register (or replace) the handler for ``combo``. Combos are serialized
   * via ``serializeCombo`` so a registration of ``'Ctrl+L'`` matches both
   * ``Ctrl+L`` and ``Ctrl+l`` browser events.
   *
   * @param {string} combo
   * @param {KeyboardHandler} handler
   * @param {{ description?: string }} [opts]
   */
  register(combo, handler, opts = {}) {
    if (typeof combo !== 'string' || combo.length === 0) return;
    if (typeof handler !== 'function') return;
    const key = normalizeCombo(combo);
    this.bindings[key] = handler;
    if (opts.description) {
      this.descriptions[key] = opts.description;
    }
  }

  /**
   * Remove the handler (and optional description) for ``combo``.
   * @param {string} combo
   */
  unregister(combo) {
    const key = normalizeCombo(combo);
    delete this.bindings[key];
    delete this.descriptions[key];
  }

  /**
   * Attach a human-readable label to a combo for the help overlay.
   * Safe to call before or after ``register``.
   * @param {string} combo
   * @param {string} label
   */
  setDescription(combo, label) {
    const key = normalizeCombo(combo);
    this.descriptions[key] = label;
  }

  /**
   * Programmatic dispatch — used by tests and by the registry's own
   * keydown listener. Returns ``true`` if a binding fired.
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  dispatch(event) {
    const combo = serializeCombo(event);
    if (!combo) return false;

    const handler = this.bindings[combo];
    const isEscape = combo === 'Escape';

    // Focus context check (§III.4 step 2.17 focus rule): every binding
    // except Escape is suppressed when typing into an input.
    if (!isEscape && isEditableTarget(event.target)) {
      return false;
    }

    if (!handler) return false;
    event.preventDefault();
    handler(event);
    return true;
  }

  /**
   * Remove the window listener. Idempotent; safe to call from SSR.
   */
  destroy() {
    if (typeof window === 'undefined') return;
    if (this.#boundListener) {
      window.removeEventListener('keydown', this.#boundListener);
      this.#boundListener = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  #installListener() {
    if (typeof window === 'undefined') return; // SSR safety
    this.#boundListener = (event) => this.dispatch(event);
    window.addEventListener('keydown', this.#boundListener);
  }
}

/**
 * Serialize a ``KeyboardEvent`` into the registry's canonical combo
 * string. Modifier order is always ``Ctrl+Alt+Shift+<key>``. Plain printable
 * keys (e.g. ``?``) round-trip as the key itself. Bare modifier keypresses
 * (just Shift, just Alt, just Ctrl) return ``''`` so the registry doesn't
 * accidentally fire when the user is mid-chord.
 *
 * @param {KeyboardEvent} event
 * @returns {string}
 */
export function serializeCombo(event) {
  if (!event) return '';
  const key = typeof event.key === 'string' ? event.key : '';
  if (!key) return '';

  // Skip lone modifier keypresses — they're never bindings on their own.
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
    return '';
  }

  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');

  // Single printable keys lower-case so ``Ctrl+L`` (Shift pressed) and
  // ``Ctrl+l`` collide on the same binding. Multi-char keys (``Escape``,
  // ``ArrowUp``, ...) keep their canonical casing.
  const keyPart = key.length === 1 ? key.toLowerCase() : key;

  // Shift is included in the combo only when it materially changes the
  // BINDING — i.e. when the produced key is a letter or digit. For symbol
  // keys (``?``, ``!``, ``:``…) Shift is the typing mechanism, not a
  // distinct modifier, so we drop it here. This makes the natural
  // registration ``'?'`` match the actual browser event ``{ key: '?',
  // shiftKey: true }`` rather than forcing every author to think about
  // keyboard layout.
  const shiftIsMeaningful =
    event.shiftKey &&
    (keyPart.length !== 1 || /^[a-z0-9]$/.test(keyPart));
  if (shiftIsMeaningful) parts.push('Shift');

  parts.push(keyPart);
  return parts.join('+');
}

/**
 * Normalize a user-supplied combo string (``'Ctrl+L'``, ``'ctrl+L'``,
 * ``'Ctrl+l'``) to the canonical form used by ``serializeCombo``.
 *
 * @param {string} combo
 * @returns {string}
 */
export function normalizeCombo(combo) {
  if (typeof combo !== 'string' || combo.length === 0) return '';
  const segments = combo.split('+').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return '';

  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = '';

  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'meta') {
      ctrl = true;
    } else if (lower === 'alt' || lower === 'option') {
      alt = true;
    } else if (lower === 'shift') {
      shift = true;
    } else {
      // Last non-modifier segment wins; single-char keys lower-case to
      // match ``serializeCombo``'s canonical form.
      key = seg.length === 1 ? seg.toLowerCase() : seg;
    }
  }

  if (!key) return '';
  const parts = [];
  if (ctrl) parts.push('Ctrl');
  if (alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * Whether the keydown target is an editable surface that should swallow
 * non-Escape shortcuts. Exported for the test suite.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const el = /** @type {HTMLElement} */ (target);
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  return false;
}

// Module-level singleton so any component can ``import { keyboard }`` and
// share the same registry without prop-drilling. Created lazily so tests
// can call ``createKeyboardRegistry()`` for isolated instances.
let _singleton = /** @type {KeyboardRegistry | null} */ (null);

/**
 * Get (and lazily create) the app-wide registry. App.svelte calls this on
 * mount; tests prefer ``createKeyboardRegistry()`` for isolation.
 * @returns {KeyboardRegistry}
 */
export function getKeyboardRegistry() {
  if (!_singleton) {
    _singleton = new KeyboardRegistry();
  }
  return _singleton;
}

/**
 * Spawn a fresh, isolated registry. Tests use this so each spec gets a
 * clean ``bindings`` map and an independent listener it can ``destroy()``.
 * @returns {KeyboardRegistry}
 */
export function createKeyboardRegistry() {
  return new KeyboardRegistry();
}

/**
 * Reset the module-level singleton (for tests only). The current
 * singleton's listener is torn down before the reference is dropped.
 */
export function resetKeyboardRegistry() {
  if (_singleton) {
    _singleton.destroy();
    _singleton = null;
  }
}
