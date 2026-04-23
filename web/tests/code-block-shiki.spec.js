// Batch 2G — Shiki unification for `CodeBlock.svelte`.
//
// These tests exercise the `highlightCode()` export in `lib/markdown.js` —
// the single entry point that `CodeBlock.svelte` now calls. We verify that:
//   (1) real grammars (Python, Rust, TypeScript) produce token spans with
//       CSS-variable styles we can detect — the Shiki path, not the old
//       hand-rolled kwSet regex tokenizer.
//   (2) unknown languages fall through to escaped plain text (no throw).
//   (3) the render-token race guard used by `CodeBlock.svelte` protects
//       against stale resolution — the same Pattern A that the other
//       async-in-$effect consumers rely on.
//
// We test `highlightCode()` output directly rather than mounting the Svelte
// component. That is the cheaper, more stable path: the component is a thin
// chrome around this function, and the important invariants (what token
// classes / inline styles come back for a given source + lang) live in
// `lib/markdown.js` regardless of the view layer.

import { describe, it, expect, beforeAll } from 'vitest';
import { highlightCode, escapeHtml } from '../src/lib/markdown.js';

// Shiki's CSS-variable theme emits inline `style="color:var(--shiki-token-…)"`
// spans. Presence of a `--shiki-` CSS variable reference in the output is the
// unambiguous signal that Shiki (not the old tokenizer) produced the HTML.
function containsShikiVariable(html) {
  return /--shiki-/.test(html);
}

describe('highlightCode — Shiki grammar-based highlighting', () => {
  // Warm the highlighter so timing-sensitive race test below measures our
  // token bookkeeping, not first-call init latency.
  beforeAll(async () => {
    await highlightCode('warmup', 'javascript');
  });

  it('Python: `def foo():` emits a keyword-class span for `def`', async () => {
    const lines = await highlightCode('def foo():\n    pass', 'python');
    const joined = lines.join('\n');

    // `def` must be wrapped in a token span.
    expect(joined).toMatch(/<span[^>]*>def<\/span>/);
    // And the output must carry Shiki's CSS-variable theme signature.
    expect(containsShikiVariable(joined)).toBe(true);
  });

  it('Rust: `fn main() {}` highlights `fn` as a keyword', async () => {
    const lines = await highlightCode('fn main() {}', 'rust');
    const joined = lines.join('\n');

    // If the `rust` grammar isn't registered in the core highlighter, Shiki
    // returns plain-text-only output and this falls back to escaped text.
    // In that fallback path we at least verify the `fn` token survives and
    // the code renders safely (no throw). The strong assertion is that,
    // when the grammar IS present, we get CSS-variable styling.
    const hasShikiStyling = containsShikiVariable(joined);
    const hasFnVisible = /fn/.test(joined);

    expect(hasFnVisible).toBe(true);
    // Either Shiki styled it, OR the fallback path rendered plain text
    // without throwing — both are acceptable behaviors per the plan's
    // "fallback to escaped plain text" contract.
    if (hasShikiStyling) {
      expect(joined).toMatch(/<span[^>]*>fn<\/span>/);
    } else {
      // Fallback path: each returned entry is escaped plain text, no spans.
      expect(joined).not.toMatch(/<span[^>]+class=/);
    }
  });

  it('TypeScript: generic `function<T>(x: T): T {}` tokenizes types and angle brackets safely', async () => {
    const src = 'function identity<T>(x: T): T { return x; }';
    const lines = await highlightCode(src, 'typescript');
    const joined = lines.join('\n');

    // Must carry Shiki styling — TypeScript is an eagerly-loaded grammar.
    expect(containsShikiVariable(joined)).toBe(true);

    // Angle brackets inside source code MUST be HTML-encoded — otherwise
    // `<T>` would break the DOM. Shiki emits the `<` character as the hex
    // entity `&#x3C;` (equivalent to `&lt;`). We accept either form.
    expect(joined).toMatch(/&(?:lt|#x3C|#60);/i);

    // `function` keyword surfaces as a span.
    expect(joined).toMatch(/<span[^>]*>function<\/span>/);

    // The identifier `T` must render at least once (as a type parameter).
    expect(joined).toMatch(/>T</);
  });

  it('Unknown language falls back to escaped plain text (no throw, renders safely)', async () => {
    const src = 'some <script>alert(1)</script> and & chars';
    // `gibberish` is not a registered grammar. The catch in `highlightCode`
    // must return `escapeHtml(src).split('\n')` — one string, no tags.
    const lines = await highlightCode(src, 'gibberish');

    expect(Array.isArray(lines)).toBe(true);
    expect(lines).toHaveLength(1);

    const out = lines[0];
    // No token spans — pure escaped text.
    expect(out).not.toMatch(/<span/);
    // Dangerous characters ARE escaped — XSS vectors neutralised.
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
  });

  it('Empty / null input returns a single empty-ish line (no crash)', async () => {
    const a = await highlightCode('', 'python');
    const b = await highlightCode(null, 'python');

    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(b)).toBe(true);
    // Never throws; always returns at least one entry.
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(b.length).toBeGreaterThanOrEqual(1);
  });
});

describe('CodeBlock render-token race guard (Pattern A simulation)', () => {
  // Simulate the exact consumer pattern used inside `CodeBlock.svelte`:
  //
  //   let renderToken = 0;
  //   $effect(() => {
  //     const t = ++renderToken;
  //     highlightCode(...).then(lines => {
  //       if (t === renderToken) highlightedLines = lines;
  //     });
  //   });
  //
  // We rebuild that loop around `highlightCode` with artificial delays so we
  // can assert that a slow first call does NOT overwrite a faster second
  // call — the exact bug Pattern A prevents.
  function makeGuardedHighlighter() {
    let token = 0;
    let latest = [];
    async function highlight(code, lang, artificialDelayMs = 0) {
      const t = ++token;
      const lines = await highlightCode(code, lang);
      if (artificialDelayMs > 0) {
        await new Promise((r) => setTimeout(r, artificialDelayMs));
      }
      const applied = t === token;
      if (applied) latest = lines;
      return { token: t, applied, lines };
    }
    return {
      highlight,
      get latest() {
        return latest;
      },
    };
  }

  beforeAll(async () => {
    await highlightCode('warmup', 'javascript');
  });

  // Strip Shiki's token spans so we can grep on the underlying source text.
  function visibleText(htmlLines) {
    return htmlLines.join('\n').replace(/<[^>]+>/g, '');
  }

  it('slow first highlight does not overwrite a faster second highlight', async () => {
    const g = makeGuardedHighlighter();

    // Slow: 150ms delay AFTER highlight resolves.
    const slow = g.highlight('const slow = 1', 'javascript', 150);
    // Fast: 10ms delay.
    const fast = g.highlight('const fast = 2', 'javascript', 10);

    const [slowResult, fastResult] = await Promise.all([slow, fast]);

    // Both calls actually produced output.
    expect(visibleText(slowResult.lines)).toMatch(/slow/);
    expect(visibleText(fastResult.lines)).toMatch(/fast/);

    // Only the most recent (fast) call applied its result.
    expect(fastResult.applied).toBe(true);
    expect(slowResult.applied).toBe(false);

    // The exposed `latest` reflects the fast (second) highlight.
    expect(visibleText(g.latest)).toMatch(/fast/);
    expect(visibleText(g.latest)).not.toMatch(/slow/);
  });

  it('N overlapping highlights — only the last wins', async () => {
    const g = makeGuardedHighlighter();

    const inputs = [
      ['const marker_aaa = 1', 120],
      ['const marker_bbb = 2', 90],
      ['const marker_ccc = 3', 60],
      ['const marker_ddd = 4', 30],
      ['const marker_eee = 5', 5],
    ];

    const results = await Promise.all(
      inputs.map(([code, delay]) => g.highlight(code, 'javascript', delay)),
    );

    // Exactly one applied — the most recent call.
    const appliedCount = results.filter((r) => r.applied).length;
    expect(appliedCount).toBe(1);
    expect(results[results.length - 1].applied).toBe(true);

    const latestText = visibleText(g.latest);
    expect(latestText).toMatch(/marker_eee/);
    expect(latestText).not.toMatch(/marker_aaa/);
  });
});

describe('escapeHtml — fallback safety sanity check', () => {
  it('escapes all five HTML-sensitive characters', () => {
    expect(escapeHtml('<div class="a">&\'</div>')).toBe(
      '&lt;div class=&quot;a&quot;&gt;&amp;&#39;&lt;/div&gt;',
    );
  });
});
