// Markdown rendering + sanitizing + syntax highlighting.
//
// Plain ES module — no runes, no `.svelte.js`. Consumed by Svelte components
// that wrap `renderMarkdown` in a `$effect` with a render-token guard (R2-10).
//
// R4-4: `createCssVariablesTheme` is imported from `shiki/core` (NOT from a
// nonexistent `@shikijs/themes/css-variables` package path). Shiki v3 exposes
// it as a programmatic theme factory — we build the theme object in-process
// with `variablePrefix: '--shiki-'` so code blocks emit class-based spans
// whose colors are driven by CSS variables set by the host app.
//
// R4-5: If the highlighter promise rejects, we null out the cached promise so
// the next caller gets a fresh attempt. A transient failure (corrupt install,
// flaky dynamic import) would otherwise poison highlighting app-wide.
//
// R2-6: Tight `ALLOWED_URI_REGEXP` blocks `file:`, `blob:`, `javascript:`,
// `data:` for all URI attrs. A module-level `afterSanitizeAttributes` hook
// intercepts cross-origin `<img src>` and rewrites to a click-to-load
// placeholder.
//
// R3-5: The hook is added at module top-level so it runs exactly once on
// import and applies to every `renderMarkdown()` call globally.

import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import DOMPurify from 'dompurify';
import {
  createHighlighterCore,
  createCssVariablesTheme,
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// ---------------------------------------------------------------------------
// Shiki — CSS-variables theme (R4-4)
// ---------------------------------------------------------------------------
const cssVarsTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  variableDefaults: {
    // Fallbacks used when the host app has not yet set the CSS variables.
    // Keep in sync with the Carbon Ember palette — see §9 of the plan.
    foreground: '#c9c5bd',
    background: '#0e0e11',
    'token-constant': '#c084fc',
    'token-string': '#34d399',
    'token-comment': '#4a4540',
    'token-keyword': '#f59e0b',
    'token-parameter': '#c9c5bd',
    'token-function': '#67e8f9',
    'token-string-expression': '#34d399',
    'token-punctuation': '#9a9489',
    'token-link': '#fbbf24',
  },
  fontStyle: true,
});

// ---------------------------------------------------------------------------
// Highlighter lifecycle (R4-5 retry-on-rejection)
// ---------------------------------------------------------------------------
let highlighterPromise = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [cssVarsTheme],
      langs: [
        import('@shikijs/langs/typescript'),
        import('@shikijs/langs/javascript'),
        import('@shikijs/langs/bash'),
        import('@shikijs/langs/python'),
        import('@shikijs/langs/json'),
      ],
      engine: createJavaScriptRegexEngine(),
    }).catch((err) => {
      // Null the cached promise so the next caller retries instead of
      // re-receiving the poisoned rejection.
      highlighterPromise = null;
      // eslint-disable-next-line no-console
      console.warn(
        '[claude-comms] Shiki init failed, will retry on next call:',
        err,
      );
      throw err;
    });
  }
  return highlighterPromise;
}

// ---------------------------------------------------------------------------
// marked configuration
// ---------------------------------------------------------------------------
let mdConfigured = false;

async function configureMarked() {
  if (mdConfigured) return;
  const hl = await getHighlighter();
  marked.use(
    markedHighlight({
      async: true,
      async highlight(code, lang) {
        try {
          return hl.codeToHtml(code, {
            lang: lang || 'text',
            theme: 'css-variables',
          });
        } catch {
          return `<pre><code>${escapeHtml(code)}</code></pre>`;
        }
      },
    }),
  );
  marked.setOptions({ gfm: true, breaks: false, async: true });
  mdConfigured = true;
}

// ---------------------------------------------------------------------------
// Escape helper
// ---------------------------------------------------------------------------
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch],
  );
}

// ---------------------------------------------------------------------------
// DOMPurify strict config (R2-6)
// ---------------------------------------------------------------------------
const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
  // Allow http/https/mailto/tel + in-page (#), relative (/, ./, ../) URIs
  // only. Rejects `file:`, `blob:`, `javascript:`, `data:`.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i,
};

// ---------------------------------------------------------------------------
// Module-level hook: external-image interception (R2-6 + R3-5)
//
// Lives OUTSIDE configureMarked() so it runs exactly once on import and
// applies to every `renderMarkdown()` call globally. Also runs even if the
// caller happens to invoke `DOMPurify.sanitize(...)` directly elsewhere
// (belt-and-braces).
// ---------------------------------------------------------------------------
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!node || typeof node.tagName !== 'string') return;
  if (node.tagName !== 'IMG') return;

  const src = node.getAttribute('src') || '';
  // If there's no src, nothing to do.
  if (!src) return;

  // Strip non-http(s) schemes outright (redundant with ALLOWED_URI_REGEXP
  // for the href attribute but <img src> uses a separate code path in
  // DOMPurify, so belt-and-braces here).
  const isHttp = /^https?:/i.test(src);
  const isRelative = src.startsWith('/') || src.startsWith('./') || src.startsWith('../');

  if (!isHttp && !isRelative) {
    // file:, blob:, data:, javascript: — strip entirely.
    node.removeAttribute('src');
    return;
  }

  if (isHttp) {
    // Cross-origin if it doesn't begin with the current origin.
    // (In non-browser contexts like tests, `window.location.origin` is
    // `about:blank` or the jsdom default; we treat everything as external
    // then, which is the safe default.)
    let origin = '';
    try {
      origin = typeof window !== 'undefined' ? window.location.origin : '';
    } catch {
      origin = '';
    }
    const isSameOrigin = origin && src.startsWith(origin);
    if (!isSameOrigin) {
      node.setAttribute('data-external-src', src);
      node.setAttribute('src', '');
      node.setAttribute('alt', 'External image blocked — click to load');
      if (node.classList && typeof node.classList.add === 'function') {
        node.classList.add('external-image-blocked');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Public: render markdown → sanitized HTML string
// ---------------------------------------------------------------------------
export async function renderMarkdown(source) {
  await configureMarked();
  const raw = await marked.parse(source || '');
  return DOMPurify.sanitize(raw, PURIFY_CONFIG);
}

// ---------------------------------------------------------------------------
// Public: highlight a single code string → array of per-line HTML fragments
//
// Consumed by `CodeBlock.svelte` (Batch 2G) which renders its own line-number
// column. We return one HTML string per line so the consumer can interleave
// line-number cells.
//
// Interface: (code: string, lang: string) => Promise<string[]>
// ---------------------------------------------------------------------------
export async function highlightCode(code, lang) {
  const src = code ?? '';
  let hl;
  try {
    hl = await getHighlighter();
  } catch {
    return escapeHtml(src).split('\n');
  }

  try {
    const html = hl.codeToHtml(src, {
      lang: lang || 'text',
      theme: 'css-variables',
    });
    // Shiki wraps output in `<pre ...><code ...>...</code></pre>` with
    // per-line `<span class="line">…</span>` children. We want just the
    // inner HTML so the consumer component can own the outer <pre>.
    const inner = html
      .replace(/^<pre[^>]*><code[^>]*>/, '')
      .replace(/<\/code><\/pre>\s*$/, '');
    return inner.split('\n');
  } catch {
    // Unknown language or grammar failure — fall back to escaped plain text.
    return escapeHtml(src).split('\n');
  }
}
