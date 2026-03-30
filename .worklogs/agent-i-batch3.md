# Agent-I Batch 3: Svelte 5 Web Client (Obsidian Forge)

**Date:** 2026-03-29
**Agent:** Agent-I
**Work Package:** Svelte 5 Web Client (Obsidian Forge design)

## Summary

Created the complete Svelte 5 web client for Claude Comms under `/home/plafayette/claude-comms/web/`. All 34 specified files plus `index.html` entry point were created, faithfully replicating the Phantom Ember v2 R10 interactive mockup design.

## Files Created (35 total)

### Project Setup (5 files)
- `package.json` -- Svelte 5, Vite 6, Tailwind v4, mqtt.js
- `vite.config.js` -- @sveltejs/vite-plugin-svelte + @tailwindcss/vite
- `index.html` -- Entry HTML with Inter font
- `src/main.js` -- Mounts App.svelte via Svelte 5 `mount()` API
- `src/app.css` -- Tailwind v4 `@theme` with full Carbon Ember palette, all keyframe animations

### Core Stores (3 files)
- `src/lib/mqtt-store.svelte.js` -- `MqttChatStore` class using `$state`/`$derived` runes, connects to `ws://localhost:9001/mqtt`, handles all MQTT topics (messages, presence, typing, meta), client-side deduplication, typing indicators with 5s TTL
- `src/lib/notifications.svelte.js` -- Browser Notification API wrapper, tab focus tracking, auto-close
- `src/lib/utils.js` -- Time formatting, mention parsing, inline code parsing, participant color assignment, initials generation, UUID/key generation

### Root Layout (1 file)
- `src/App.svelte` -- 3-column layout (sidebar + chat + members), manages all overlay/panel state, wires MQTT store to all components

### Components (26 files)
- `Sidebar.svelte` -- Channel list with starred/conversations sections, collapsible, brand icon with breathing animation, search, user profile
- `ChatView.svelte` -- Message area with date separators, message grouping, auto-scroll, edge fade mask
- `MessageBubble.svelte` -- Bubble with avatar, sender line, timestamp, mentions, reactions, thread indicators, hover accent lines
- `MessageGroup.svelte` -- Groups consecutive same-sender messages
- `MessageActions.svelte` -- Hover action bar (Reply, React, More) with tooltip on hover
- `MemberList.svelte` -- Right sidebar with online/offline sections, presence dots, role badges, typing indicators
- `MessageInput.svelte` -- Input with toolbar, typing wave animation, send button with shine effect, @mention trigger
- `MentionDropdown.svelte` -- Floating autocomplete with keyboard navigation
- `CodeBlock.svelte` -- Syntax block with language badge, line numbers, copy button, hover highlight
- `Avatar.svelte` -- Colored circle with initials, optional status dot, hover scale
- `ThemeToggle.svelte` -- Dark/light mode switch button
- `ConnectionStatus.svelte` -- Banner with pulsing dot, connected/error/connecting states
- `EmojiPicker.svelte` -- Search, 8 category tabs, 8x grid, preview footer, backdrop dismiss
- `ThreadPanel.svelte` -- Slide-in panel with parent message, replies, reply input
- `PinnedPanel.svelte` -- Glassmorphic panel with pinned messages list
- `SearchPanel.svelte` -- Slide-in search with filter pills, highlighted results
- `ContextMenu.svelte` -- Right-click menu with Reply, Forward, Pin, Copy, React, Unread, Delete
- `ProfileCard.svelte` -- Popup card with banner, avatar, role badge, action buttons
- `ChannelModal.svelte` -- Create conversation modal with name validation, description, private toggle
- `NotificationToast.svelte` -- Top-right slide-in with exit animation
- `ScrollToBottom.svelte` -- Floating button with unread badge
- `FileAttachment.svelte` -- File display with type-colored icon, download button
- `LinkPreview.svelte` -- Rich link preview card with domain, title, description
- `ReadReceipt.svelte` -- Double-check icon with count
- `ReactionBar.svelte` -- Reaction pills with add button, hover visibility
- `DateSeparator.svelte` -- Centered pill with clock icon and formatted date

## Technical Decisions

1. **Svelte 5 runes only** -- All reactivity uses `$state`, `$derived`, `$effect`, `$props`. No Svelte 4 stores.
2. **`.svelte.js` extension** -- Used for `mqtt-store.svelte.js` and `notifications.svelte.js` since they use runes outside `.svelte` files.
3. **Tailwind v4** -- No `tailwind.config.js`. Theme configured via `@theme` directive in `app.css`. `@tailwindcss/vite` plugin in vite config.
4. **Plain Vite** -- Not SvelteKit. No SSR. Client-only SPA.
5. **MQTT topics** -- Follows architecture plan exactly: `claude-comms/conv/{channel}/messages` (QoS 1), `presence/+` (QoS 1, retained), `typing/+` (QoS 0).
6. **Deduplication** -- Bounded `Set` of seen message IDs (10k cap with 1k eviction).
7. **CSS custom properties** -- Both Tailwind `@theme` variables and raw CSS custom properties for component-level styling that matches the mockup exactly.
8. **All animations** -- Replicated from mockup: ambient drift, brand breath, badge pulse, header glow, message appear, wave bar typing, toast slide, panel slide, context menu, modal overlay, send shine, accent fade, live pulse, brand particle.

## MQTT Store API

```
store.connect()           -- Connect to broker via WebSocket
store.disconnect()        -- Disconnect cleanly
store.sendMessage(body, replyTo?)  -- Send to active channel
store.switchChannel(id)   -- Switch channels, clear unread
store.createChannel(id, topic)     -- Create new conversation
store.toggleStar(id)      -- Star/unstar channel
store.notifyTyping()      -- Debounced typing indicator
store.searchMessages(q)   -- Full-text search across all channels
store.togglePin(msg)      -- Pin/unpin a message
```

## Next Steps

- Run `npm install && npm run dev` to start dev server
- Ensure amqtt broker is running on port 9001 (WebSocket)
- Test with multiple browser tabs to verify real-time MQTT messaging
- Virtual scrolling library (`@humanspeak/svelte-virtual-list`) can be added for large message volumes
