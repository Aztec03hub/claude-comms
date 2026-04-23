import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

export default defineConfig({
  // The `svelteTesting` plugin prepends the `browser` resolve condition so
  // Svelte 5's client-side `mount()` is loaded instead of the SSR stub —
  // required by @testing-library/svelte's `render()` (Batch 4L: a11y scan).
  plugins: [svelte({ hot: !process.env.VITEST }), svelteTesting()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    // Exclude Playwright e2e specs so Vitest only picks up unit tests.
    include: ['tests/**/*.spec.js'],
    exclude: ['node_modules', 'dist', 'e2e', 'test-results'],
  },
});
