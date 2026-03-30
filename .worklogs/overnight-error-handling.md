# Overnight: Error Handling and Edge Cases

**Agent:** Error Handling and Edge Case Agent
**Date:** 2026-03-30
**Status:** VERIFIED -- all changes already present in HEAD

## Scope

Exclusive files: `mqtt-store.svelte.js`, `ChannelModal.svelte`, `MessageInput.svelte`, `SettingsPanel.svelte`

## Round 1: MQTT Connection Error Handling

**File:** `web/src/lib/mqtt-store.svelte.js`

- Better error messages: "is claude-comms start running?" added to ECONNREFUSED and WebSocket errors
- `#failureCount` and `#backoffActive` private fields track connection state
- `#activateBackoff()` method: after 5 failures, stops mqtt.js auto-reconnect, applies exponential backoff (base 3s, max 30s), then retries
- User-facing message: "Broker unreachable after N attempts -- retrying in Xs. App works in local-only mode."
- On successful connect: failure count resets, backoff deactivates
- `safeStorage` wrapper (try/catch around localStorage) used for all storage access in `connect()`
- App remains functional in local-only mode (sendMessage already does local echo before publish)

## Round 2: Input Validation

### ChannelModal.svelte
- `sanitizedName` derived: lowercase, alphanumeric + dashes only, trimmed
- `nameError` derived: empty check, max 63 chars, auto-sanitization preview ("Will be saved as: ...")
- `nameIsValid` derived gates the Create button (disabled when invalid)
- Character counter shows `N/63` when name is non-empty
- Error/warning styling: red for errors, amber for auto-sanitization notice

### MessageInput.svelte
- `MAX_MESSAGE_LENGTH = 10000`, `CHAR_WARN_THRESHOLD = 9000`
- Character counter appears at 9,000+ chars: "9,000/10,000"
- Over-limit state (red + "message too long") prevents sending
- `sendMessage()` enforces length check before dispatching

### SettingsPanel.svelte
- `MAX_NAME_LENGTH = 50` with `maxlength` attribute on input
- `nameError` derived: empty check, max length check
- `handleNameChange` truncates at 50 chars, only persists valid (non-empty) names
- Validation feedback: red error text or gray char count hint
- `.input-error` class for red border styling

## Round 3: localStorage Graceful Fallback

- `mqtt-store.svelte.js`: `safeStorage` object wraps all localStorage calls in try/catch; returns null on failure; silently ignores write errors (private browsing, quota exceeded)
- `connect()`: all raw `localStorage` calls replaced with `safeStorage.getItem/setItem`
- `SettingsPanel.svelte`: `handleNameChange` wraps localStorage.setItem in try/catch

## Build Verification

- `npm run build` passes (vite build, 4348 modules, 6.23s)
- Pre-existing a11y warnings in ProfileCard.svelte and EmojiPicker.svelte (not in scope)

## Commit Status

All changes were already present in HEAD (commit b53558e and earlier). No new commit needed -- edits were confirmed as no-ops matching existing committed code.
