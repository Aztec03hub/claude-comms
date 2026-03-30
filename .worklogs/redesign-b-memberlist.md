# Phase 3: MemberList UI Redesign

**Date:** 2026-03-30
**File:** `web/src/components/MemberList.svelte`

## Changes Made

1. **One row per user** — `{#each}` now keys on `member.key` (not composite `member.key + '-' + member.client`)
2. **Connection icons row** — Lucide icons (Globe, Monitor, Plug, Terminal, Link) shown next to the role badge for online members
3. **New data contract** — Props `online`/`offline` now expect `connections` sub-object per member instead of flat `client` field
4. **Icon mapping** — `CONNECTION_ICONS` and `CONNECTION_LABELS` maps for extensibility (add new client type = add one entry each)
5. **CSS transitions** — Icons fade in with `@keyframes iconFadeIn` (opacity + scale), hover highlights
6. **Hover tooltips** — Each icon has `title="Connected via Web UI"` etc.
7. **Removed** — All composite key rendering, `member-client` badge spans, `client-web`/`client-tui`/`client-mcp`/`client-unknown` CSS classes
8. **Kept** — Avatar, name, role badge (Admin/Agent), presence dot, search filter, typing indicators
9. **Fixed Svelte 5 deprecation** — Used `{@const IconComponent = ...}` + `<IconComponent />` instead of deprecated `<svelte:component>`

## Build Verification

- `npx vite build` passes cleanly (no errors, no warnings)
