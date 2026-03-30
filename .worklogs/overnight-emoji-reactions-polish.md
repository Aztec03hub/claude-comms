# Overnight: Emoji Picker & Reaction Bar Polish

**Date:** 2026-03-30
**Commit:** 33fe813

## Changes

### EmojiPicker.svelte
- Widened picker from 340px to 380px for better desktop usability
- Increased emoji grid max-height from 200px to 260px so more emojis are visible without scrolling

### ReactionBar.svelte
- Increased badge background contrast: `rgba(255,255,255,0.06)` with `rgba(255,255,255,0.10)` border
- Added `box-shadow: 0 1px 3px rgba(0,0,0,0.2)` for depth/separation from message background
- Bumped emoji size from 14px to 15px
- Changed count text from `--text-muted` to `--text-secondary` with `font-weight: 700` for readability
- Active state: stronger border opacity (0.4), more saturated background (0.12), added ember glow shadow

## Verification
- Build passes cleanly (no new warnings)
- Committed and pushed to main
