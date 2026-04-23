// Render-race test (R2-10).
//
// The `renderToken` pattern in consumer components is: increment a monotonic
// counter at the start of each $effect, capture the value, and only apply the
// awaited result if the captured value still equals the current counter. This
// guards against stale resolution when the user switches artifacts faster
// than markdown renders.
//
// This test exercises the same guard against `renderMarkdown` directly by
// simulating two overlapping renders where the first (slower) resolves
// AFTER the second. We assert that a token-guarded wrapper never assigns
// the stale result.

import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';

// Token-guarded wrapper — the same pattern used inside Svelte $effect blocks.
function makeGuardedRenderer() {
  let token = 0;
  let latest = '';
  async function render(source, artificialDelayMs = 0) {
    const t = ++token;
    const html = await renderMarkdown(source);
    if (artificialDelayMs > 0) {
      await new Promise((r) => setTimeout(r, artificialDelayMs));
    }
    // Only apply if we are still the most recent call.
    if (t === token) {
      latest = html;
    }
    return { token: t, applied: t === token, html };
  }
  return {
    render,
    get latest() {
      return latest;
    },
  };
}

describe('renderMarkdown — render race guard', () => {
  // Warm highlighter so the race is purely about our token bookkeeping, not
  // first-call init latency.
  beforeAll(async () => {
    await renderMarkdown('warmup');
  });

  it('guard: slow first render does not overwrite faster second render', async () => {
    const g = makeGuardedRenderer();

    // Kick off the slow one FIRST.
    const slow = g.render('# Artifact A\n\nSlow content.', 200);
    // Kick off the fast one immediately after.
    const fast = g.render('# Artifact B\n\nFast content.', 20);

    const [slowResult, fastResult] = await Promise.all([slow, fast]);

    // Both calls produced HTML.
    expect(slowResult.html).toContain('Artifact A');
    expect(fastResult.html).toContain('Artifact B');

    // Only the most recent (second) render should have been applied.
    expect(fastResult.applied).toBe(true);
    expect(slowResult.applied).toBe(false);

    // The exposed `latest` reflects the fast (second) render.
    expect(g.latest).toContain('Artifact B');
    expect(g.latest).not.toContain('Artifact A');
  });

  it('guard: N overlapping renders — only the last wins', async () => {
    const g = makeGuardedRenderer();
    const sources = [
      '# First',
      '# Second',
      '# Third',
      '# Fourth',
      '# Fifth',
    ];
    // Progressively-shorter delays so earlier calls resolve later.
    const delays = [120, 90, 60, 30, 5];

    const results = await Promise.all(
      sources.map((src, i) => g.render(src, delays[i])),
    );

    // Exactly one render applied; it must be the final one.
    const appliedCount = results.filter((r) => r.applied).length;
    expect(appliedCount).toBe(1);
    expect(results[results.length - 1].applied).toBe(true);

    expect(g.latest).toContain('Fifth');
    expect(g.latest).not.toContain('First');
    expect(g.latest).not.toContain('Second');
    expect(g.latest).not.toContain('Third');
    expect(g.latest).not.toContain('Fourth');
  });
});
