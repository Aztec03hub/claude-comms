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
    },
  },
  build: {
    outDir: 'dist',
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
