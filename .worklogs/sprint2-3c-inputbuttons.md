# Sprint 2 Batch 3 - Agent 3C: Input Button Wiring

**Agent:** 3C
**Date:** 2026-03-29
**Status:** Complete

## Task
Wire the 3 dead input buttons in MessageInput.svelte (Attach, Format, Snippet).

## Changes Made

### MessageInput.svelte
1. **Attach button** (`data-testid="input-attach"`):
   - Added hidden `<input type="file">` with `data-testid="input-file-hidden"`
   - Attach button click triggers file input via `handleAttachClick()`
   - On file selection, shows "File sharing coming soon" notice for 3 seconds
   - Notice displayed below the input wrap

2. **Format button** (`data-testid="input-format"`):
   - Added `showFormatHelp` state toggle
   - Click toggles a popover above the button showing: `**bold** *italic* \`code\` \`\`\`code block\`\`\``
   - Popover has `data-testid="format-help"`

3. **Snippet button** (`data-testid="input-snippet"`):
   - Click inserts a code block template at cursor position in the input
   - Template: triple-backtick language block with `// code here` placeholder
   - Focuses input and places cursor after the inserted text

### MessageActions.svelte
- Verified: 3D already correctly wired `onMore` prop. Props destructure includes `onMore`, and the More button has `onclick={onMore}`. No changes needed.

## New State Variables
- `showFormatHelp` - toggles format help popover
- `attachNotice` - temporary file attach notice text
- `fileInputEl` - ref to hidden file input

## New data-testids
- `input-format` - Format toolbar button
- `input-snippet` - Snippet toolbar button
- `input-file-hidden` - Hidden file input element
- `format-help` - Format help popover
- `attach-notice` - File attach notice

## Build Verification
- `npx vite build` passes (only pre-existing warnings, no new issues)
