import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte()
  ],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9920',
        changeOrigin: true,
      },
      // Single-origin Phase 2: the daemon bridges the embedded broker at
      // /mqtt on the web port (:9921). Proxy the dev server's /mqtt WS to it
      // so `npm run dev` connects same-origin just like production.
      '/mqtt': {
        target: 'ws://127.0.0.1:9921',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    // Emit straight into the Python package so wheel + editable installs
    // resolve assets via `importlib.resources.files("claude_comms")/web/dist`.
    // Symlinks/copies in the build hook are unnecessary as a result.
    outDir: '../src/claude_comms/web/dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-mqtt': ['mqtt'],
          'vendor-ui': ['bits-ui', 'lucide-svelte'],
          // Batch 4M: explicit chunks so the CI bundle-size check can
          // measure markdown and diff vendor surface against documented
          // ceilings (see scripts/check-bundle-size.mjs and
          // CONTRIBUTING.md "Bundle size" section).
          'vendor-markdown': ['marked', 'marked-highlight', 'dompurify', 'shiki'],
          'vendor-diff': ['diff'],
        }
      }
    }
  }
});
