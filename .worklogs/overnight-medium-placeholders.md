# Overnight: Medium-Priority Placeholder Fixes

**Date:** 2026-03-29
**Agent:** Claude Opus 4.6
**Scope:** Audit items #9, #20, #24/#25

---

## Changes Made

### 1. inAppToasts toggle wired (audit #9)

- **`web/src/lib/mqtt-store.svelte.js`** -- Added `inAppToasts = $state(true)` reactive field to `MqttChatStore` so the setting is shared across components.
- **`web/src/components/SettingsPanel.svelte`** -- Changed `inAppToasts` local state to initialize from `store.inAppToasts`. `toggleInAppToasts()` now writes back to `store.inAppToasts`.
- **`web/src/App.svelte`** -- The `$effect` that creates toasts for new messages now checks `store.inAppToasts` before calling `addToast()`. When disabled, no in-app toasts are created.

### 2. Channel mute flag checked (audit #20)

- **`web/src/App.svelte`** -- Same `$effect` block now looks up the channel object and checks `ch.muted`. Muted channels skip toast creation entirely.

Combined guard: `if (store.inAppToasts && !(ch && ch.muted))`

### 3. Version mismatch fixed (audit #24/#25)

- **`web/src/components/Sidebar.svelte`** -- Changed hardcoded `v0.9` to `v0.1.0` to match `__init__.py`'s `__version__ = "0.1.0"`.

---

## Verification

- `npm run build` passes cleanly (no new warnings introduced).
- All changes committed in `d96c0f6` and pushed to origin/main.

---

## Scope Compliance

- App.svelte edits were exclusively within the toast/notification `$effect` block (lines 111-131). No handlers, panels, or other state were touched.
