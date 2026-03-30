# Bug Fix Loop -- Web Client Sweep

**Date**: 2026-03-29
**Agent**: Claude Opus 4.6 (Bug Hunter)

## Summary

Reviewed all 27 Svelte components, 3 JS library files, and the Python backend. Found and fixed 12 bugs across 3 categories: MQTT integration, event handling, and accessibility.

## Bugs Found and Fixed

### MQTT Integration (3 bugs)

1. **Topic routing miss** -- `#handleMessage` in `mqtt-store.svelte.js` used `parts[2] === 'conv' || parts[1] === 'conv'` which never matched `system/participants/+` topics. The participant registry subscription was present but messages were silently dropped. Fixed by stripping prefix first and matching on `topicParts[0]`.

2. **Typing channel extraction** -- `#handleTyping` stored `this.activeChannel` as the typing channel instead of extracting it from the MQTT topic (`conv/{channel}/typing/{key}`). This caused all typing indicators to appear in the current viewer's channel regardless of where the typing actually occurred. Fixed by passing the channel from the topic parser.

3. **LWT topic scope** -- LWT was published to `conv/{activeChannel}/presence/{key}` which only marked the user offline in one channel. Changed to `system/participants/{key}` for global offline visibility.

### Event Handling (1 bug)

4. **Sidebar onShowProfile mismatch** -- Sidebar passed raw participant objects but App.svelte expected `e.detail` wrapper (legacy CustomEvent pattern). The linter normalized all callback props to direct passing, which was the correct Svelte 5 pattern.

### Accessibility (8 fixes)

5. **Clickable elements without keyboard handlers** -- Added `onkeydown` (Enter/Space) to: Sidebar channel items, Sidebar user avatar, MemberList member items, MessageBubble sender name, MessageBubble thread indicator.

6. **Non-semantic interactive elements** -- Converted to `<button>`: App.svelte header-members (div), Sidebar collapse arrows (span), SearchPanel filter pills (span).

7. **Labels without controls** -- Added `for`/`id` to ChannelModal labels.

8. **Icon button without label** -- Added `aria-label` to ThreadPanel send button.

9. **Avatar noninteractive tabindex** -- Split into conditional branches to avoid tabindex on non-clickable avatars.

## Verification

- `npx vite build` -- ZERO warnings, clean build
- `python3 -m pytest tests/ -x --tb=short` -- 360 passed, 0 failed
- CHANGELOG.md updated with all fixes

## Files Modified

- `web/src/App.svelte` -- header-members div->button, style fix
- `web/src/lib/mqtt-store.svelte.js` -- topic routing, typing channel, LWT topic
- `web/src/components/Sidebar.svelte` -- onShowProfile fix, arrow span->button, onkeydown, arrow style
- `web/src/components/MemberList.svelte` -- onkeydown on member divs
- `web/src/components/MessageBubble.svelte` -- contextmenu a11y ignore, sender onkeydown, thread onkeydown
- `web/src/components/Avatar.svelte` -- split into clickable/static branches
- `web/src/components/ChannelModal.svelte` -- label for/id associations
- `web/src/components/ThreadPanel.svelte` -- send button aria-label
- `web/src/components/SearchPanel.svelte` -- filter span->button, font-family
- `CHANGELOG.md` -- documented all fixes
