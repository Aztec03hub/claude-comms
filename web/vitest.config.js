import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

// Performance note (web unit-test suite):
// The suite's cost was dominated by per-file overhead. The same module graph
// (App, mqtt-store, components, bits-ui, the lucide-svelte icon barrel) was
// re-imported, re-executed, and the jsdom env re-created for every one of the
// ~94 spec files. Actual test execution is cheap.
//
// The `vmThreads` pool runs each spec file in its own fresh V8 VM context
// (full per-file isolation, so no cross-file state leakage: the bits-ui
// teardown fix in tests/setup.js and the clean 0-unhandled / 0-stderr output
// are preserved) while REUSING the worker's compiled-module cache across
// files. That collapses the dominant import/transform/environment cost and
// roughly halves wall-clock without touching a single assertion.
//
// Caveat: under `vmThreads` the VM's `window` / `location` globals are
// non-configurable, so the handful of specs that REPLACE the whole `window`
// or `location` object (not just define a property on it) cannot run there.
// They are routed to a standard `forks` project instead. This list only needs
// to grow if a new spec reassigns the entire `window` / `location` global;
// such a spec fails loudly under `vmThreads`, never silently.
const NON_VM_SPECS = [
  'tests/api-base-derivation.spec.js', // vi.stubGlobal('window', ...)
  'tests/connection-status.spec.js', // Object.defineProperty(window, 'location', ...)
  'tests/slash-commands.spec.js', // globalThis.window = { ... }
];

// Exclude Playwright e2e specs so Vitest only picks up unit tests.
const BASE_EXCLUDE = ['node_modules', 'dist', 'e2e', 'test-results'];

export default defineConfig({
  // The `svelteTesting` plugin prepends the `browser` resolve condition so
  // Svelte 5's client-side `mount()` is loaded instead of the SSR stub,
  // required by @testing-library/svelte's `render()` (Batch 4L: a11y scan).
  plugins: [svelte({ hot: !process.env.VITEST }), svelteTesting()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.js'],
    projects: [
      {
        extends: true,
        test: {
          name: 'vm',
          pool: 'vmThreads',
          include: ['tests/**/*.spec.js'],
          exclude: [...BASE_EXCLUDE, ...NON_VM_SPECS],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom-globals',
          pool: 'threads',
          include: NON_VM_SPECS,
          exclude: BASE_EXCLUDE,
        },
      },
    ],
  },
});
