# Remaining Placeholder Fixes

**Date:** 2026-03-30
**Commit:** 51b92ab
**Scope:** MessageBubble.svelte, ChatView.svelte, FileAttachment.svelte

---

## Changes Made

### 1. Link URL auto-detection in messages (MessageBubble.svelte)

**Audit items:** #13 (LinkPreview never rendered), partially #13 (URL detection)

- Added `parseBody()` function that extends `parseMentions()` to also split text segments on URL patterns (`https?://...`), producing `{ type: 'link', value }` segments.
- Template now renders `link` segments as `<a class="inline-link">` tags with `target="_blank"` and `rel="noopener noreferrer"`.
- Added `.inline-link` CSS with ember-themed underline styling.
- The existing `detectedUrls` derived + `LinkPreview` rendering (lines 91-97) was already wired from a prior session -- URLs in messages now get both inline clickable links AND a LinkPreview card below the bubble.

### 2. Read receipts "seen" tracking (ChatView.svelte)

**Audit item:** #12 (Read receipts never populated)

- ChatView already had a complete IntersectionObserver implementation calling `store.markSeen(msgId)` (lines 69-103), but it queried for `[data-message-id]` which didn't exist on MessageBubble's DOM.
- **Fix:** Added `data-message-id={message.id}` attribute to MessageBubble's outer div, wiring the observer to actual message elements.
- Now when a message scrolls into view (50% threshold), `store.markSeen()` is called, feeding the ReadReceipt component.

### 3. File attachment architecture comment (FileAttachment.svelte)

**Audit item:** #14 (FileAttachment has no backend)

- Added a comprehensive JSDoc comment above the `<script>` tag documenting the planned 5-phase architecture:
  1. Upload path (inline base64 for small files, HTTP endpoint for large)
  2. Message schema (`{ name, type, size, url, inline_data? }`)
  3. Download path (Blob URLs for inline, signed URLs for HTTP)
  4. Retention and cleanup policy
  5. Security (MIME validation, signed URL expiry, sanitization)

---

## Build Verification

- `npm run build` succeeded with no new warnings (only pre-existing a11y warnings in EmojiPicker and ProfileCard).
- Output: 91 KB CSS, 787 KB JS (unchanged from prior build).

## Files Modified

- `/home/plafayette/claude-comms/web/src/components/MessageBubble.svelte` -- parseBody, inline-link template+CSS, data-message-id
- `/home/plafayette/claude-comms/web/src/components/FileAttachment.svelte` -- JSDoc architecture comment
- `/home/plafayette/claude-comms/web/src/components/ChatView.svelte` -- no changes needed (already complete)
