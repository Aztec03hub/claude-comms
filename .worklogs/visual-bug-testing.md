# Visual Bug Testing - 2026-03-29

## Summary

Performed visual QA testing of the Claude Comms Svelte web app using Playwright screenshots at multiple viewport sizes. Compared against the Phantom Ember v2 R10 design spec. Found and fixed 7 visual/layout bugs.

## Bugs Found and Fixed

### Bug 1: Mobile view - member list not hidden
- **File**: `web/src/components/MemberList.svelte`, `web/src/app.css`
- **Before**: The right sidebar (MemberList) was always visible, even on narrow viewports (480px), causing the layout to be cramped and the main content area to be squeezed
- **After**: Added `@media (max-width: 640px)` rule to hide the member list panel, and responsive CSS variable override for `--right-w`

### Bug 2: No empty state for channels with no messages
- **File**: `web/src/components/ChatView.svelte`
- **Before**: When viewing a channel with no messages, the message area was completely blank with no visual feedback
- **After**: Added an empty state component with a channel icon, "No messages yet" title, and subtitle prompting users to start the conversation

### Bug 3: Messages container mask fade too aggressive
- **File**: `web/src/components/ChatView.svelte`
- **Before**: The CSS `mask-image` gradient faded 20px at top and bottom edges, cutting off the first and last visible messages
- **After**: Reduced fade distance to 8px for a much subtler edge treatment that doesn't obscure content

### Bug 4: Scanline overlay not in design spec
- **File**: `web/src/App.svelte`
- **Before**: `.center::after` applied a repeating-linear-gradient scanline effect over the entire chat area, adding visual noise not present in the mockup
- **After**: Removed the scanline overlay entirely. The subtle dot grid pattern on `::before` remains, matching the design spec

### Bug 5: Chat header missing border-bottom from spec
- **File**: `web/src/App.svelte`
- **Before**: The `.chat-header` relied only on the animated `::after` pseudo-element glow line, missing the solid `border-bottom: 1px solid var(--border)` specified in the design
- **After**: Added `border-bottom: 1px solid var(--border)` and matched the background gradient from the spec (`linear-gradient(180deg, var(--bg-base), rgba(17,17,19,0.97))`)

### Bug 6: Connection status banner too prominent when connected
- **File**: `web/src/components/ConnectionStatus.svelte`
- **Before**: The green "Connected" banner had strong opacity (0.12/0.08), 6px padding, and 11.5px font size, drawing too much attention away from the chat content
- **After**: Reduced background opacity to 0.06/0.03, border opacity to 0.1, padding to 4px, and font-size to 10.5px for a more subtle status indicator

### Bug 7: Sidebar not positioned correctly on very narrow viewports
- **File**: `web/src/components/Sidebar.svelte`
- **Before**: On viewports under 480px, the sidebar took its full width inline, leaving almost no room for the main content area
- **After**: Added `@media (max-width: 480px)` to position the sidebar absolutely with z-index elevation and a drop shadow, overlaying the content area instead of squeezing it

## Files Modified

1. `web/src/app.css` - Added responsive breakpoints for sidebar and member list widths
2. `web/src/App.svelte` - Removed scanline overlay, added header border-bottom
3. `web/src/components/ChatView.svelte` - Reduced mask fade, added empty state
4. `web/src/components/MemberList.svelte` - Added responsive hiding on mobile
5. `web/src/components/ConnectionStatus.svelte` - Reduced prominence of connected banner
6. `web/src/components/Sidebar.svelte` - Added absolute positioning on very narrow viewports

## Screenshots

Before screenshots: `mockups/screenshot-*.png`
After screenshots: `mockups/screenshot-final-*.png`

## Testing Methodology

- Used Playwright (v1.58.2) headless Chromium browser
- Tested at 1440x900 (standard), 480x800 (mobile), and 1920x1080 (wide) viewports
- Tested interactions: message input, send, search panel, pinned panel, channel modal, channel switching
- Compared visuals against `mockups/concept-j-phantom-ember-v2-r10-interactive.html` design spec
