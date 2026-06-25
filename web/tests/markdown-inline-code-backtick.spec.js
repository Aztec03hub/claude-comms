// Regression corpus for the message-body renderer's handling of inline code
// spans that CONTAIN backtick runs.
//
// Message bodies in the chat bubble are NOT rendered through the marked +
// shiki pipeline (`src/lib/markdown.js` — that path serves artifacts). They
// are rendered through the custom `parseRich()` token stream in
// `src/lib/rich-text-parser.js`, which `MessageBubble.svelte` maps to chips
// (`inline-code` → `.code-chip`) and fenced blocks (`block-code` /
// `unclosed-block` → the `CodeBlock` component).
//
// The bug: the inline-code scanner closed a span on the FIRST backtick it
// hit (the composer's deliberate "no-flicker" rule), regardless of run
// length. A 1-backtick span whose content contained a `` ``` `` run was
// therefore split into a stray single-space chip plus leftover backtick
// text bleeding over the surrounding prose. CommonMark requires the closing
// backtick run to MATCH the opener length; the read-side now does too via
// `parse(source, { strictInline: true })`.

import { describe, it, expect } from 'vitest';
import { parse, parseRich } from '../src/lib/rich-text-parser.js';
import { marked } from 'marked';

/** Convenience: just the inline-code chip values, in order. */
function chips(src) {
  return parseRich(src)
    .filter((t) => t.type === 'inline-code')
    .map((t) => t.value);
}

describe('inline code containing backtick runs (Phil repro)', () => {
  const REPRO = 'No more ` ```markdown ` code-block wrapping for prose.';

  it('EXACT REPRO: `` ` ```markdown ` `` renders as a single chip reading "```markdown"', () => {
    const out = parseRich(REPRO);
    expect(out.map((t) => t.type)).toEqual(['text', 'inline-code', 'text']);
    expect(out[0].value).toBe('No more ');
    expect(out[1]).toMatchObject({ type: 'inline-code', value: '```markdown' });
    expect(out[2].value).toBe(' code-block wrapping for prose.');
  });

  it('REPRO produces exactly ONE chip and no stray single-space chip / box', () => {
    const c = chips(REPRO);
    expect(c).toEqual(['```markdown']);
    // The pre-fix garbled output contained a chip whose value was a single
    // space (the "stray colored box"). Make sure that can never come back.
    expect(c).not.toContain(' ');
  });

  it('the surrounding prose is intact (no leftover backticks bleeding into text)', () => {
    const text = parseRich(REPRO)
      .filter((t) => t.type === 'text')
      .map((t) => t.value)
      .join('');
    expect(text).toBe('No more  code-block wrapping for prose.');
    expect(text).not.toContain('`');
  });

  it('confirms the marked/shiki pipeline (artifact path) was never the offender', () => {
    // marked alone parses the repro correctly to a single <code> element —
    // proof the bug lived in the custom read-side parser, not marked.
    const html = marked.parse(REPRO).trim();
    expect(html).toBe(
      '<p>No more <code>```markdown</code> code-block wrapping for prose.</p>',
    );
  });
});

describe('inline code: 1/2/3-backtick delimiters and backtick content', () => {
  it('1-backtick delimiter, plain content', () => {
    expect(chips('use `--flag` now')).toEqual(['--flag']);
  });

  it('1-backtick delimiter whose content is a longer backtick run', () => {
    // A span can only contain a backtick run of a DIFFERENT length than its
    // delimiter (an equal-length run would close it — CommonMark).
    expect(chips('a ` `` ` b')).toEqual(['``']); // content is two backticks
    expect(chips('a ` ``` ` b')).toEqual(['```']); // content is three backticks
  });

  it('2-backtick delimiter whose content is a single backtick', () => {
    expect(chips('a `` ` `` b')).toEqual(['`']);
  });

  it('2-backtick delimiter, content contains a single backtick', () => {
    const out = parseRich('a ``x`y`` b');
    expect(out.map((t) => t.type)).toEqual(['text', 'inline-code', 'text']);
    expect(out[1].value).toBe('x`y');
  });

  it('3-backtick delimiter mid-line, content contains 1- and 2-backtick runs', () => {
    const out = parseRich('a ```x`y``z``` b');
    expect(out.map((t) => t.type)).toEqual(['text', 'inline-code', 'text']);
    expect(out[1].value).toBe('x`y``z');
  });

  it('CommonMark space-stripping only strips ONE space each side', () => {
    // ` `x` ` → "x"; `  x  ` → " x " (one stripped each side).
    expect(chips('a ` x ` b')).toEqual(['x']);
    expect(chips('a `  x  ` b')).toEqual([' x ']);
  });
});

describe('robust backtick edge cases', () => {
  it('adjacent inline-code runs each become their own chip', () => {
    const out = parseRich('`a` `b` `c`');
    expect(out.map((t) => t.type)).toEqual([
      'inline-code',
      'text',
      'inline-code',
      'text',
      'inline-code',
    ]);
    expect(chips('`a` `b` `c`')).toEqual(['a', 'b', 'c']);
  });

  it('mixed inline-code + a real fenced block in one message', () => {
    const out = parseRich('pre `x` mid\n```js\ncode()\n```\ntail');
    expect(out.map((t) => t.type)).toEqual([
      'text',
      'inline-code',
      'text',
      'block-code',
      'text',
    ]);
    const block = out.find((t) => t.type === 'block-code');
    expect(block.lang).toBe('js');
    expect(block.value).toBe('code()');
  });

  it('a lone / unbalanced backtick stays literal text (no chip)', () => {
    expect(chips('a lone ` here')).toEqual([]);
    expect(chips('a ``` mid line stuff')).toEqual([]);
    expect(parseRich('a lone ` here')).toEqual([
      { type: 'text', value: 'a lone ` here' },
    ]);
  });

  it('round-trips: rendered tokens reconstruct the original source', () => {
    const samples = [
      'No more ` ```markdown ` code-block wrapping for prose.',
      'a ``x`y`` b',
      '`a` `b` `c`',
      'pre `x` mid\n```js\ncode()\n```\ntail',
      'a lone ` here',
    ];
    for (const src of samples) {
      const out = parseRich(src);
      const reconstructed = out
        .map((t) => t.raw ?? t.value)
        .join('');
      // Emphasis/text tokens carry no `raw`; for these samples the inline
      // chips and blocks carry `raw`, and text round-trips via `value`.
      // Note: space-stripping changes a chip's `value` but NOT its `raw`,
      // so reconstruction stays faithful.
      expect(reconstructed).toBe(src);
    }
  });
});

describe('a real fenced block still becomes a CodeBlock token', () => {
  it('closed fence → block-code (MessageBubble renders via CodeBlock)', () => {
    const out = parseRich('```python\nprint("hi")\n```');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'block-code',
      lang: 'python',
      value: 'print("hi")',
    });
  });

  it('unclosed fence → unclosed-block (still routed to CodeBlock)', () => {
    const out = parseRich('```\nstill typing');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'unclosed-block', value: 'still typing' });
  });

  it('backticks INSIDE a fenced block stay literal', () => {
    const out = parseRich('```\nlet x = `1`\n```');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('block-code');
    expect(out[0].value).toBe('let x = `1`');
  });
});

describe('ordinary inline markdown basics (no regressions)', () => {
  it('bold, italic, strike, and inline code all render as distinct tokens', () => {
    const out = parseRich('**b** *i* ~~s~~ and `code`');
    expect(out.map((t) => t.type)).toEqual([
      'bold',
      'text',
      'italic',
      'text',
      'strike',
      'text',
      'inline-code',
    ]);
    expect(out[0].value).toBe('b');
    expect(out[2].value).toBe('i');
    expect(out[4].value).toBe('s');
    expect(out[6].value).toBe('code');
  });

  it('emphasis inside an inline-code chip stays literal (code wins)', () => {
    const out = parseRich('see `**not bold**` here');
    expect(out.map((t) => t.type)).toEqual(['text', 'inline-code', 'text']);
    expect(out[1].value).toBe('**not bold**');
  });

  it('a bullet list passes through as clean text (no stray chips/emphasis)', () => {
    // parseRich does not transform bullet lists into list markup; the point
    // is that list syntax must not garble — it stays plain text, no spurious
    // inline-code or emphasis tokens.
    const src = '- first\n- second\n- third';
    const out = parseRich(src);
    expect(out).toEqual([{ type: 'text', value: src }]);
  });
});

describe('composer parse() is unchanged (no-flicker rule preserved)', () => {
  it('default parse() keeps closing on the first backtick of a run', () => {
    // The composer relies on this for live-typing caret stability.
    const out = parse('`a``b`');
    expect(out.map((t) => t.type)).toEqual(['inline-code', 'inline-code']);
    expect(out[0].value).toBe('a');
  });

  it('default parse() leaves the repro garbled (proves strictInline is read-side only)', () => {
    const out = parse('No more ` ```markdown ` code-block wrapping for prose.');
    const c = out.filter((t) => t.type === 'inline-code').map((t) => t.value);
    // Default (composer) behavior: stray single-space chip — intentional.
    expect(c).toEqual([' ']);
  });
});
