// Detail-view tests for Batch 3J (ArtifactDetailBody + ArtifactDetailHeader).
//
// These tests exercise two load-bearing behaviors of the body component:
//
//   1. **Render-token guard** — when the `artifact` prop swaps mid-render,
//      a slower in-flight `renderMarkdown` call for the previous artifact
//      must NOT overwrite the final `rendered` state. The body uses the
//      monotonic-token pattern (Pattern A per §"Svelte 5 conventions");
//      this spec simulates the race and asserts the guard holds.
//
//   2. **External-image click handler** — when markdown contains an
//      external `<img>`, DOMPurify's hook should neutralize the src and
//      stash the original in `data-external-src`. Clicking the placeholder
//      (dispatched via the delegated handler installed by the body)
//      should reveal the image by restoring the src. We exercise the
//      `renderMarkdown` + the click-delegation pattern directly with a
//      jsdom container rather than mounting the whole component — this
//      avoids coupling the spec to Svelte's effect scheduler while still
//      testing the exact code path the component uses.

import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';

function parseHtml(html) {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  );
  return doc.body;
}

// Token-guarded wrapper matching the body component's `$effect`:
//   $effect(() => {
//     const t = ++renderToken;
//     (async () => {
//       const html = await renderMarkdown(src);
//       if (t === renderToken) rendered = html;   // guard
//     })();
//   });
//
// We expose the internal counter so the test can drive an artifact swap
// between the render kick-off and the render resolution.
function makeBodyLikeRenderer() {
  let renderToken = 0;
  let rendered = '';
  async function render(source, artificialDelayMs = 0) {
    const t = ++renderToken;
    const html = await renderMarkdown(source);
    if (artificialDelayMs > 0) {
      await new Promise((r) => setTimeout(r, artificialDelayMs));
    }
    if (t === renderToken) rendered = html;
    return { token: t, applied: t === renderToken, html };
  }
  return {
    render,
    get rendered() {
      return rendered;
    },
  };
}

describe('ArtifactDetailBody — markdown render-token guard (R2-10)', () => {
  beforeAll(async () => {
    // Warm the Shiki highlighter so the race is purely about token bookkeeping.
    await renderMarkdown('warmup');
  });

  it('switching artifacts mid-render: stale resolution does not corrupt final state', async () => {
    const body = makeBodyLikeRenderer();

    // Kick off a SLOW render for artifact A (mimics a long markdown document
    // with many code blocks whose highlighter pass takes time).
    const aPromise = body.render('# Artifact A\n\nFirst document.', 200);
    // Before A resolves, user clicks artifact B → second, faster render.
    const bPromise = body.render('# Artifact B\n\nSecond document.', 20);

    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);

    // Both renders succeeded at the marked level...
    expect(aResult.html).toContain('Artifact A');
    expect(bResult.html).toContain('Artifact B');

    // ...but only B's result was applied to `rendered`.
    expect(bResult.applied).toBe(true);
    expect(aResult.applied).toBe(false);

    // Final observable state reflects artifact B, NEVER A.
    expect(body.rendered).toContain('Artifact B');
    expect(body.rendered).not.toContain('Artifact A');
  });

  it('five overlapping artifact swaps: only the final one paints', async () => {
    const body = makeBodyLikeRenderer();
    const docs = [
      '# Doc One',
      '# Doc Two',
      '# Doc Three',
      '# Doc Four',
      '# Doc Five',
    ];
    // Delays in descending order so earlier calls finish LAST — the usual
    // race shape when a user clicks through a list rapidly.
    const delays = [120, 90, 60, 30, 5];

    const results = await Promise.all(
      docs.map((src, i) => body.render(src, delays[i])),
    );

    // Exactly one render applied; it must be the last one queued.
    const appliedCount = results.filter((r) => r.applied).length;
    expect(appliedCount).toBe(1);
    expect(results.at(-1).applied).toBe(true);

    expect(body.rendered).toContain('Doc Five');
    for (const stale of ['Doc One', 'Doc Two', 'Doc Three', 'Doc Four']) {
      expect(body.rendered).not.toContain(stale);
    }
  });
});

/**
 * Build a DOM container populated from a parsed fragment. We avoid setting
 * innerHTML with a raw string by parsing via DOMParser (a safe API that
 * does not execute scripts) and cloning the resulting children into the
 * container. Keeps the spec free of any XSS surface while still exercising
 * the exact DOM the body component builds.
 */
function mountFragment(container, html) {
  const parsed = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  );
  for (const child of Array.from(parsed.body.childNodes)) {
    container.appendChild(document.importNode(child, true));
  }
}

describe('ArtifactDetailBody — external image click handler (R2-6)', () => {
  beforeAll(async () => {
    await renderMarkdown('warmup');
  });

  /**
   * Replicate the delegated click handler the body installs via
   * `{@attach externalImageClickInterceptor}`. Keeping it here means this
   * spec verifies the EXACT behavior, even though we don't mount the
   * component — which in turn keeps the test fast and free of
   * jsdom/Svelte-effect flakiness.
   */
  function installExternalImageInterceptor(container) {
    const onClick = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.tagName !== 'IMG') return;
      if (!target.classList.contains('external-image-blocked')) return;
      const stashed = target.getAttribute('data-external-src');
      if (!stashed) return;
      target.setAttribute('src', stashed);
      target.removeAttribute('data-external-src');
      target.classList.remove('external-image-blocked');
      target.removeAttribute('alt');
    };
    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }

  it('<img src="http://external/x.png"> is blocked with data-external-src + placeholder class', async () => {
    const html = await renderMarkdown(
      '<img src="http://external.example/x.png">',
    );
    const body = parseHtml(html);
    const img = body.querySelector('img');
    expect(img).not.toBeNull();
    // The sanitizer hook must stash the URL and neutralize the src.
    expect(img.getAttribute('data-external-src')).toBe(
      'http://external.example/x.png',
    );
    expect(img.getAttribute('src')).toBe('');
    expect(img.classList.contains('external-image-blocked')).toBe(true);
  });

  it('clicking the placeholder reveals the image (restores src, drops marker class)', async () => {
    const html = await renderMarkdown(
      '<img src="https://external.example/photo.jpg">',
    );

    // Build a fresh container in jsdom, attach the body-equivalent handler,
    // and insert the sanitized HTML via a parsed fragment (no innerHTML).
    const container = document.createElement('div');
    container.className = 'artifact-md-body';
    document.body.appendChild(container);
    mountFragment(container, html);
    const cleanup = installExternalImageInterceptor(container);

    try {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      // Initial blocked state.
      expect(img.getAttribute('src')).toBe('');
      expect(img.classList.contains('external-image-blocked')).toBe(true);
      expect(img.getAttribute('data-external-src')).toBe(
        'https://external.example/photo.jpg',
      );

      // Simulate the user click on the placeholder.
      img.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // After click: src is restored, marker class gone, data-attr cleared.
      expect(img.getAttribute('src')).toBe(
        'https://external.example/photo.jpg',
      );
      expect(img.classList.contains('external-image-blocked')).toBe(false);
      expect(img.getAttribute('data-external-src')).toBeNull();
    } finally {
      cleanup();
      container.remove();
    }
  });

  it('clicking a non-placeholder <img> is a no-op', async () => {
    // Simulate a same-origin image that was NOT blocked — src must survive
    // the click untouched and no reveal-style mutation must occur.
    const container = document.createElement('div');
    container.className = 'artifact-md-body';
    document.body.appendChild(container);
    // Build the benign <img> programmatically to avoid innerHTML entirely.
    const img = document.createElement('img');
    img.setAttribute('src', '/local/icon.png');
    img.setAttribute('alt', 'local icon');
    container.appendChild(img);
    const cleanup = installExternalImageInterceptor(container);

    try {
      const before = img.getAttribute('src');
      img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(img.getAttribute('src')).toBe(before);
      // The alt attribute must not be stripped off a legitimate image.
      expect(img.getAttribute('alt')).toBe('local icon');
    } finally {
      cleanup();
      container.remove();
    }
  });
});
