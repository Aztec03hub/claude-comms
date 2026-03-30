# Overnight Accessibility & Keyboard Navigation Audit

**Date:** 2026-03-29
**Agent:** Accessibility Auditor

---

## Round 1: ARIA Audit

### Findings & Fixes

| Component | Issue | Fix Applied |
|---|---|---|
| ChatView.svelte | Messages container missing role/aria-label | Added `role="log"` and `aria-label="Chat messages"` with `aria-live="polite"` |
| MessageBubble.svelte | div with `oncontextmenu` lacked semantic role (svelte-ignore suppression) | Added `role="article"` and `aria-label="Message from {sender}"` |
| MessageActions.svelte | Icon-only buttons had `title` but no `aria-label`; container lacked toolbar role | Added `role="toolbar"`, `aria-label` on each button, `aria-haspopup` on More button |
| EmojiPicker.svelte | Backdrop had svelte-ignore suppression; dialog missing aria-modal; emoji items had no label; search input had no label | Added `role="presentation"` to backdrop, `aria-modal="true"` and `aria-label` to dialog, `aria-label={name}` on each emoji button, sr-only label for search |
| ProfileCard.svelte | Two svelte-ignore suppressions; no keyboard event on backdrop; dialog missing aria-label | Added `role="presentation"` + keydown to backdrop, `aria-label` + `aria-modal` on dialog |
| SearchPanel.svelte | svelte-ignore suppression on div; close button no aria-label; search input no label | Added `role="search"`, `aria-label` on close, sr-only label for input |
| PinnedPanel.svelte | svelte-ignore suppression | Added `role="complementary"`, `aria-label` on close button |
| ThreadPanel.svelte | Close button no aria-label; input no label; panel no role | Added `role="complementary"`, `aria-label` on close, sr-only label for reply input |
| SettingsPanel.svelte | Close button no aria-label; panel no role | Added `role="complementary"`, `aria-label` on close |
| FileAttachment.svelte | svelte-ignore suppression | Removed suppression (already had role="button" + tabindex + onkeydown), added `aria-label` |
| ChannelModal.svelte | Toggle switch missing keyboard handler | Added `onkeydown` for Enter/Space, added `aria-label` |
| ThemeToggle.svelte | Icon-only button, had title only | Added `aria-label` with current mode |
| ScrollToBottom.svelte | Icon-only button, had title only | Added `aria-label` with unread count |
| NotificationToast.svelte | Missing role and close button label | Added `role="alert"` + `aria-live="polite"`, `aria-label` on dismiss |
| ConnectionStatus.svelte | Status banner missing role | Added `role="status"`/`role="alert"` and `aria-live`, `aria-hidden` on decorative dots |
| ReactionBar.svelte | Reaction buttons missing labels; add button missing label | Added `aria-label` with emoji name + count, `aria-pressed` state, `aria-hidden` on emoji span |
| CodeBlock.svelte | Copy button missing aria-label | Added dynamic `aria-label` (changes to "Copied" after click) |
| DateSeparator.svelte | Inline SVG not hidden from screen readers | Added `aria-hidden="true"` on SVG, `role="separator"` + `aria-label` on container |
| ReadReceipt.svelte | Decorative SVG exposed to screen readers | Added `aria-hidden="true"` |
| Avatar.svelte | Clickable avatar missing aria-label | Added `aria-label="View profile for {name}"` |

### Components NOT edited (owned by other agents)
- App.svelte
- Sidebar.svelte
- MessageInput.svelte
- MemberList.svelte

---

## Round 2: Keyboard Navigation

### Verified via Playwright (10 tests, all passing)

| Test | Result |
|---|---|
| Tab moves focus through interactive elements | PASS |
| All focused elements have visible focus ring (--focus-ring CSS var) | PASS |
| Enter activates focused buttons (theme toggle test) | PASS |
| Escape closes panels without focus trap | PASS |
| Chat view has role="log" | PASS |
| Connection status has role="status" | PASS |
| Message actions toolbar has proper ARIA | PASS |
| Icon-only buttons have aria-labels | PASS |
| sr-only class exists in stylesheet | PASS |

### Focus ring implementation
Enhanced `app.css` with explicit `focus-visible` rules for buttons, inputs, textareas, and ARIA roles (button, switch, tabindex).

---

## Round 3: svelte-ignore a11y Suppression Removal

### All 7 suppressions removed

| File | Suppression | How Fixed |
|---|---|---|
| FileAttachment.svelte:27 | `a11y_no_static_element_interactions` | Already had `role="button"` + `tabindex="0"` + `onkeydown`; just removed comment + added `aria-label` |
| MessageBubble.svelte:27 | `a11y_no_static_element_interactions` | Added `role="article"` + `aria-label` |
| PinnedPanel.svelte:9 | `a11y_no_static_element_interactions` | Added `role="complementary"` + `aria-label` |
| EmojiPicker.svelte:48 | `a11y_no_static_element_interactions` | Changed backdrop to `role="presentation"` + added `onkeydown` |
| ProfileCard.svelte:12 | `a11y_no_static_element_interactions` | Changed backdrop to `role="presentation"` |
| ProfileCard.svelte:13 | `a11y_click_events_have_key_events` | Added `onkeydown` handler to backdrop |
| SearchPanel.svelte:42 | `a11y_no_static_element_interactions` | Added `role="search"` |

**Verification:** `grep -rn "svelte-ignore a11y" web/src/` returns 0 matches.

---

## Round 4: Screen Reader Text

### Changes

1. **app.css** - Added `.sr-only` utility class (position: absolute, clip, 1px dimensions)
2. **EmojiPicker.svelte** - Added `<label class="sr-only">` for emoji search input
3. **SearchPanel.svelte** - Added `<label class="sr-only">` for search input
4. **ThreadPanel.svelte** - Added `<label class="sr-only">` for thread reply input
5. **DateSeparator.svelte** - SVG marked `aria-hidden="true"`
6. **ReadReceipt.svelte** - SVG marked `aria-hidden="true"`
7. **ConnectionStatus.svelte** - Decorative dots marked `aria-hidden="true"`
8. **ReactionBar.svelte** - Emoji spans marked `aria-hidden="true"` (label is on the button)
9. **All icon-only buttons** - Have `aria-label` attributes now

### Focus Styles
Added enhanced `focus-visible` CSS rules in `app.css` targeting buttons, inputs, textareas, and ARIA interactive roles with a visible 2px outline + box-shadow.

---

## Test Suite

New test file: `web/e2e/a11y-keyboard.spec.js` (10 tests, all passing)

---

## Files Modified

- `web/src/app.css` (sr-only class + enhanced focus styles)
- `web/src/components/Avatar.svelte`
- `web/src/components/ChannelModal.svelte`
- `web/src/components/ChatView.svelte`
- `web/src/components/CodeBlock.svelte`
- `web/src/components/ConnectionStatus.svelte`
- `web/src/components/DateSeparator.svelte`
- `web/src/components/EmojiPicker.svelte`
- `web/src/components/FileAttachment.svelte`
- `web/src/components/MessageActions.svelte`
- `web/src/components/MessageBubble.svelte`
- `web/src/components/NotificationToast.svelte`
- `web/src/components/PinnedPanel.svelte`
- `web/src/components/ProfileCard.svelte`
- `web/src/components/ReactionBar.svelte`
- `web/src/components/ReadReceipt.svelte`
- `web/src/components/ScrollToBottom.svelte`
- `web/src/components/SearchPanel.svelte`
- `web/src/components/SettingsPanel.svelte`
- `web/src/components/ThemeToggle.svelte`
- `web/src/components/ThreadPanel.svelte`
- `web/e2e/a11y-keyboard.spec.js` (new)
