# Build Optimization Work Log

**Date:** 2026-03-30
**Task:** Investigate and reduce 795KB JS bundle

## Bundle Analysis

Before (single chunk): **795.20 KB** (gzip: 204.52 KB)

Breakdown by dependency:

| Package | Size | % of Total | Notes |
|---------|------|------------|-------|
| mqtt | 372 KB | 47% | MQTT client library, browser build |
| lucide-svelte | 191 KB | 24% | 37 icons used out of ~1700 available |
| bits-ui | 136 KB | 17% | ContextMenu, Dialog, Combobox used |
| App code | 96 KB | 12% | All Svelte components + lib code |

## Tree-Shaking Assessment

- **lucide-svelte**: Has `sideEffects: false` in package.json. Barrel file re-exports ~1686 icons, but tree-shaking works -- only used icons are included. The 191KB reflects Svelte component overhead for 37 icons plus the shared Icon component runtime. This is expected.
- **bits-ui**: Tree-shaking works. Only used components (Dialog, ContextMenu, Combobox) are included. The 136KB reflects their internal complexity (floating-ui, accessibility, etc).
- **mqtt**: Not tree-shakeable -- it's a monolithic browser build (360KB minified dist). This is the biggest single contributor.

## Changes Made

**File:** `web/vite.config.js`

Added `manualChunks` to split vendor code into cacheable chunks:
- `vendor-mqtt` -- mqtt.js (changes rarely)
- `vendor-ui` -- bits-ui + lucide-svelte (changes rarely)

## After

| Chunk | Size | Gzip |
|-------|------|------|
| index (app code) | 95.93 KB | 28.46 KB |
| vendor-ui | 326.55 KB | 65.03 KB |
| vendor-mqtt | 372.37 KB | 112.19 KB |

**500KB warning eliminated.** No single chunk exceeds 400KB.

Total transfer size unchanged (795 KB raw), but:
1. Vendor chunks cache independently -- app code changes don't bust vendor cache
2. Vite automatically adds `<link rel="modulepreload">` for vendor chunks
3. Build warning is gone

## Further Reduction Opportunities (NOT implemented)

1. **mqtt.js replacement**: Could switch to a lighter MQTT client (e.g., `mqtt-packet` + custom WebSocket wrapper) but would require rewriting `mqtt-store.svelte.js` -- not worth the risk.
2. **Dynamic import for mqtt**: Could lazy-load mqtt.js so initial paint doesn't wait for it, but the app needs MQTT immediately on load, so the benefit would be minimal.
3. **lucide-svelte individual imports**: Could import from `lucide-svelte/icons/check` instead of `lucide-svelte` to bypass barrel file, but tree-shaking is already working correctly.
4. **Compression**: The gzip sizes are already reasonable (204 KB total). If serving behind nginx/cloudflare, Brotli would reduce further.
