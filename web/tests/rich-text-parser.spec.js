import { describe, it, expect } from 'vitest';
import {
  parse,
  modeAtCaret,
  inlineChipAtCaret,
  parseEmphasis,
  parseRich,
} from '../src/lib/rich-text-parser.js';

describe('rich-text-parser: parse()', () => {
  it('returns empty array for empty input', () => {
    expect(parse('')).toEqual([]);
  });

  it('returns empty array for non-string input', () => {
    expect(parse(null)).toEqual([]);
    expect(parse(undefined)).toEqual([]);
    expect(parse(42)).toEqual([]);
  });

  it('plain text becomes a single text token', () => {
    expect(parse('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('preserves newlines in text tokens', () => {
    const out = parse('line one\nline two');
    expect(out).toEqual([{ type: 'text', value: 'line one\nline two' }]);
  });

  describe('inline code', () => {
    it('emits an inline-code token for a simple pair', () => {
      const out = parse('hello `world` end');
      expect(out).toEqual([
        { type: 'text', value: 'hello ' },
        { type: 'inline-code', value: 'world', raw: '`world`', start: 6, end: 13 },
        { type: 'text', value: ' end' },
      ]);
    });

    it('handles a chip at the very start', () => {
      const out = parse('`foo` bar');
      expect(out[0]).toMatchObject({ type: 'inline-code', value: 'foo' });
      expect(out[1]).toEqual({ type: 'text', value: ' bar' });
    });

    it('handles a chip at the very end', () => {
      const out = parse('bar `foo`');
      expect(out[0]).toEqual({ type: 'text', value: 'bar ' });
      expect(out[1]).toMatchObject({ type: 'inline-code', value: 'foo' });
    });

    it('emits multiple chips on the same line', () => {
      const out = parse('a `b` c `d` e');
      const types = out.map((t) => t.type);
      expect(types).toEqual(['text', 'inline-code', 'text', 'inline-code', 'text']);
      expect(out[1].value).toBe('b');
      expect(out[3].value).toBe('d');
    });

    it('does NOT emit a chip for an empty pair', () => {
      // Backticks adjacent → no chip, both ticks remain literal.
      const out = parse('hello `` end');
      expect(out).toEqual([{ type: 'text', value: 'hello `` end' }]);
    });

    it('does NOT emit a chip for an unclosed tick', () => {
      const out = parse('hello `world end');
      expect(out).toEqual([{ type: 'text', value: 'hello `world end' }]);
    });

    it('does NOT emit a chip when ticks straddle a newline', () => {
      const out = parse('hello `world\nbar` end');
      // Same-line rule: opener at idx 6, no closer on the same line.
      // Falls through as plain text.
      expect(out).toEqual([{ type: 'text', value: 'hello `world\nbar` end' }]);
    });

    it('emits a chip then resumes plain-text after closing tick', () => {
      const out = parse('`a` `b`');
      expect(out.map((t) => t.type)).toEqual(['inline-code', 'text', 'inline-code']);
    });

    it('source offsets point at raw including ticks', () => {
      const out = parse('xx `yy` zz');
      const chip = out.find((t) => t.type === 'inline-code');
      expect(chip.start).toBe(3);
      expect(chip.end).toBe(7);
      expect(chip.raw).toBe('`yy`');
    });
  });

  describe('block code', () => {
    it('emits a block-code token for triple-tick at start of input', () => {
      const out = parse('```\nhello\n```');
      expect(out).toEqual([
        {
          type: 'block-code',
          value: 'hello',
          lang: null,
          raw: '```\nhello\n```',
          start: 0,
          end: 13,
        },
      ]);
    });

    it('emits a block-code token for triple-tick at start of a line (preceded by \\n)', () => {
      const out = parse('intro text\n```\nbody\n```');
      expect(out[0]).toEqual({ type: 'text', value: 'intro text\n' });
      expect(out[1]).toMatchObject({ type: 'block-code', value: 'body', lang: null });
    });

    it('captures the language tag', () => {
      const out = parse('```python\nprint(1)\n```');
      const block = out.find((t) => t.type === 'block-code');
      expect(block.lang).toBe('python');
      expect(block.value).toBe('print(1)');
    });

    it('treats triple-tick mid-line as literal text', () => {
      const out = parse('hello ```not-a-block``` end');
      // Mid-line triple-tick → no block fence; the inner-content check for
      // single-tick scanning hits ``` and skips runs of >=2, so the line
      // stays plain text.
      expect(out).toEqual([{ type: 'text', value: 'hello ```not-a-block``` end' }]);
    });

    it('emits unclosed-block when the closing fence is missing', () => {
      const out = parse('```\nfoo\nbar');
      expect(out).toEqual([
        {
          type: 'unclosed-block',
          value: 'foo\nbar',
          lang: null,
          raw: '```\nfoo\nbar',
          start: 0,
          end: 11,
        },
      ]);
    });

    it('treats backticks INSIDE a block as literal', () => {
      const out = parse('```\nlet x = `1`\n```');
      const block = out.find((t) => t.type === 'block-code');
      expect(block.value).toBe('let x = `1`');
    });

    it('handles content on the opening line as part of the lang tag', () => {
      // Per spec: lang is "from after the 3 ticks to end of line, trimmed".
      // ` ```js whatever\n... ` parses lang as 'js whatever' (the parser
      // doesn't strip extras). Documented as known v1 behavior.
      const out = parse('```js extra\nbody\n```');
      const block = out.find((t) => t.type === 'block-code');
      expect(block.lang).toBe('js extra');
      expect(block.value).toBe('body');
    });

    it('plain text + chip + block in the same source', () => {
      const out = parse('hello `chip` text\n```py\ncode\n```\ntail');
      const types = out.map((t) => t.type);
      expect(types).toEqual(['text', 'inline-code', 'text', 'block-code', 'text']);
    });

    it('selection-spanning-block-boundary delete leaves no block in output', () => {
      // Simulates: user selected from mid-text through past the close fence,
      // pressed Delete, leaving only some prefix. Parser should see plain
      // text.
      const after = 'hello `chip` taprefix';
      const out = parse(after);
      const types = out.map((t) => t.type);
      expect(types).not.toContain('block-code');
      expect(types).toContain('inline-code');
    });
  });

  describe('performance budget', () => {
    it('parses 10k chars under 5ms (best of 5 runs)', () => {
      const big = (
        'hello world '.repeat(500) + // ~6000 chars of text
        '`chip` more text '.repeat(50) + // ~850 chars + many chips
        '```\nbody body body\n```\n'.repeat(80) // ~1900 chars of blocks
      ).slice(0, 10000);
      const runs = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        parse(big);
        runs.push(performance.now() - t0);
      }
      const best = Math.min(...runs);
      expect(best).toBeLessThan(5);
    });
  });

  describe('trailing-tick stability (no flicker)', () => {
    // Phoenix + sage agreed: extra ticks after a closed chip should NOT
    // dissolve the chip. The most common pattern is `--flag` followed by
    // typing or punctuation. The parser closes on the first tick of any
    // run; extra ticks in the run stay as literal text after the chip.
    it('chip + trailing literal tick: `x`` produces chip(x) + literal `', () => {
      const out = parse('`x``');
      const chips = out.filter((t) => t.type === 'inline-code');
      expect(chips).toHaveLength(1);
      expect(chips[0].value).toBe('x');
      // Faithful reconstruction including the trailing literal tick.
      const reconstructed = out.map((t) => t.raw ?? t.value).join('');
      expect(reconstructed).toBe('`x``');
    });

    it('`a``b` becomes chip(a) followed by literal/chip continuation, never chip(a``b)', () => {
      const out = parse('`a``b`');
      // First chip closes at the first tick of the middle run.
      const chips = out.filter((t) => t.type === 'inline-code');
      expect(chips.length).toBeGreaterThanOrEqual(1);
      expect(chips[0].value).toBe('a');
      expect(chips[0].value).not.toBe('a``b');
      // Round-trip preserved.
      const reconstructed = out.map((t) => t.raw ?? t.value).join('');
      expect(reconstructed).toBe('`a``b`');
    });

    it('`--flag` followed by stray tick stays stable (the canonical no-flicker case)', () => {
      const out = parse('`--flag`` typed extra');
      const chips = out.filter((t) => t.type === 'inline-code');
      // Chip survives the trailing tick.
      expect(chips).toHaveLength(1);
      expect(chips[0].value).toBe('--flag');
      // The stray tick + remaining text are preserved as plain text.
      const reconstructed = out.map((t) => t.raw ?? t.value).join('');
      expect(reconstructed).toBe('`--flag`` typed extra');
    });
  });

  describe('block body & lang edge cases', () => {
    it('empty body: ```\\n``` → block-code with value=""', () => {
      const out = parse('```\n```');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: 'block-code',
        value: '',
        lang: null,
      });
    });

    it('multi-line body preserves internal newlines', () => {
      const out = parse('```\nline1\nline2\nline3\n```');
      const block = out.find((t) => t.type === 'block-code');
      expect(block.value).toBe('line1\nline2\nline3');
    });

    it('two adjacent fenced blocks both parse', () => {
      const out = parse('```\na\n```\n```\nb\n```');
      const blocks = out.filter((t) => t.type === 'block-code');
      expect(blocks).toHaveLength(2);
      expect(blocks.map((b) => b.value)).toEqual(['a', 'b']);
    });

    it('lang trims leading/trailing whitespace', () => {
      const out = parse('```  ts  \nlet a = 1;\n```');
      const block = out.find((t) => t.type === 'block-code');
      expect(block.lang).toBe('ts');
    });

    it('opening fence with nothing else (just ```) is unclosed-block with empty body', () => {
      const out = parse('```');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: 'unclosed-block', value: '' });
    });

    it('opening fence + newline only — unclosed empty body', () => {
      const out = parse('```\n');
      expect(out[0]).toMatchObject({ type: 'unclosed-block', value: '' });
    });

    it('unclosed block carries lang', () => {
      const out = parse('```js\nconst x = 1');
      expect(out[0]).toMatchObject({
        type: 'unclosed-block',
        lang: 'js',
        value: 'const x = 1',
      });
    });
  });

  describe('v2-composer aftermath (parser invariants)', () => {
    // The §5.1.1 early-trigger gesture and §5.4 block-backspace semantics
    // both manipulate the inline-textarea source by stripping or dissolving
    // fence chars. These tests assert the parser's view of the resulting
    // source is what the composer expects — pure plain text, no ghost tokens.

    it('post-gesture source (fence stripped, body lives in dedicated block textarea) → parser sees only plain text in inline source', () => {
      // Inline textarea after gesture: pre-block prose lives here without
      // the ``` line. The block body lives in a separate textarea that the
      // parser never sees. From the parser's PoV, the inline source is just
      // text.
      const inlineAfterGesture = 'pre prose\n';
      const out = parse(inlineAfterGesture);
      expect(out).toEqual([{ type: 'text', value: 'pre prose\n' }]);
    });

    it('post-gesture inline source preserves a captured-but-different lang the user typed before triggering', () => {
      // Even if the user typed ```python then Space (gesture fires),
      // the composer strips both `\`\`\`` and `python`. Parser sees clean text.
      const inlineAfterGesture = 'pre\n';
      const out = parse(inlineAfterGesture);
      expect(out.every((t) => t.type === 'text')).toBe(true);
    });

    it('§5.4 block-dissolve aftermath: fence + body merged back as plain text → parser sees plain text', () => {
      // User pressed backspace at row 0 col 0 of a non-empty triple-tick
      // block; deletion shifted the fence off its own line. Composer dissolves
      // the fence, body merges as plain text inserted at deletion point.
      // Result for the parser: no block token, just text.
      const dissolved = 'preceding chars body line one\nbody line two';
      const out = parse(dissolved);
      expect(out.find((t) => t.type === 'block-code' || t.type === 'unclosed-block')).toBeUndefined();
      expect(out.every((t) => t.type === 'text')).toBe(true);
    });

    it('Esc-exit-block keeps the source intact: parser still emits the (closed or unclosed) block', () => {
      // Esc moves caret out of the block textarea but does NOT dissolve the
      // fence. Source still contains the fence + body. Parser still tokenizes
      // the block.
      const closed = '```\nbody\n```\n';
      const closedOut = parse(closed);
      expect(closedOut[0].type).toBe('block-code');

      const unclosed = '```\nstill being typed';
      const unclosedOut = parse(unclosed);
      expect(unclosedOut[0].type).toBe('unclosed-block');
    });

    it('round-trip survives the gesture/dissolve transitions (text-only source reconstructs verbatim)', () => {
      const samples = [
        'pre prose\n',
        'preceding chars body line one\nbody line two',
        '\n',
        'just one line of plain text',
      ];
      for (const src of samples) {
        const out = parse(src);
        const reconstructed = out.map((t) => t.raw ?? t.value).join('');
        expect(reconstructed).toBe(src);
      }
    });

    it('caret at exact fence boundary in unclosed block returns BLOCK mode (composer needs this for §5.4 detection)', () => {
      // Per §5.4: when caret rests at row 0 col 0 of the block body (right
      // after `` ```\n ``), composer treats backspace specially. modeAtCaret
      // must report BLOCK so the composer's keydown handler can branch.
      const src = '```\n';
      const r = modeAtCaret(src, 4); // just past `\n`
      expect(r.mode).toBe('BLOCK');
      expect(r.token.type).toBe('unclosed-block');
      expect(r.fenceLineStart).toBe(0);
    });
  });

  describe('source round-trip (reconstruction faithfulness)', () => {
    // Critical invariant: tokens must round-trip back to the source string.
    // The composer relies on this for caret math + send-path correctness.
    const samples = [
      '',
      'plain text',
      'use `flag` here',
      '`a` and `b` and `c`',
      'pre `chip` post\n```py\nbody\n```\ntail',
      '`unclosed text continues',
      '``',
      '```\nempty close\n```',
      '```\nunclosed body to eof',
      'multi\nline\ntext\nwith no ticks',
      'mixed `inline`\n```\nblock body\nwith `literal ticks`\n```\nafter',
    ];
    for (const src of samples) {
      it(`round-trips: ${JSON.stringify(src.slice(0, 40))}`, () => {
        const out = parse(src);
        const reconstructed = out.map((t) => t.raw ?? t.value).join('');
        expect(reconstructed).toBe(src);
      });
    }
  });
});

describe('rich-text-parser: modeAtCaret()', () => {
  it('returns NORMAL for caret in plain text', () => {
    const r = modeAtCaret('hello world', 5);
    expect(r.mode).toBe('NORMAL');
  });

  it('returns BLOCK when caret is inside a closed block', () => {
    const src = '```\nbody\n```';
    const r = modeAtCaret(src, 6); // inside body
    expect(r.mode).toBe('BLOCK');
    expect(r.token.type).toBe('block-code');
  });

  it('returns BLOCK when caret is inside an unclosed block', () => {
    const src = '```\nbody';
    const r = modeAtCaret(src, 6);
    expect(r.mode).toBe('BLOCK');
    expect(r.token.type).toBe('unclosed-block');
  });

  it('returns NORMAL when caret is in text after a closed block', () => {
    const src = '```\nbody\n```\ntail';
    const r = modeAtCaret(src, 16); // inside "tail"
    expect(r.mode).toBe('NORMAL');
  });

  it('returns NORMAL when caret is in text BEFORE a block opener', () => {
    const src = 'pre text\n```\nbody\n```';
    const r = modeAtCaret(src, 3); // inside "pre"
    expect(r.mode).toBe('NORMAL');
  });

  it('caret inside an inline-code chip does NOT trigger BLOCK', () => {
    const src = 'use `flag` here';
    const r = modeAtCaret(src, 6); // inside the chip
    expect(r.mode).toBe('NORMAL');
  });

  it('returns fenceLineStart pointing at the opening fence start', () => {
    const src = 'pre\n```\nbody\n```';
    // Opening fence starts at offset 4 (after 'pre\n').
    const r = modeAtCaret(src, 9); // inside "body"
    expect(r.mode).toBe('BLOCK');
    expect(r.fenceLineStart).toBe(4);
  });

  it('empty source + caret at 0 → NORMAL', () => {
    const r = modeAtCaret('', 0);
    expect(r.mode).toBe('NORMAL');
    expect(r.token).toBeNull();
  });
});

describe('rich-text-parser: inlineChipAtCaret()', () => {
  it('returns null in plain text', () => {
    expect(inlineChipAtCaret('hello world', 3)).toBe(null);
  });

  it('returns the chip when caret is mid-chip', () => {
    const src = 'foo `bar` end';
    // chip at [4, 9), inner '5..8'
    const r = inlineChipAtCaret(src, 6);
    expect(r).not.toBeNull();
    expect(r.value).toBe('bar');
  });

  it('returns null when caret is exactly at chip boundary (start)', () => {
    const src = 'foo `bar` end';
    // chip starts at offset 4. Caret AT 4 = "before opening tick", outside.
    expect(inlineChipAtCaret(src, 4)).toBe(null);
  });

  it('returns null when caret is exactly at chip boundary (end)', () => {
    const src = 'foo `bar` end';
    // chip ends at offset 9. Caret AT 9 = "after closing tick", outside.
    expect(inlineChipAtCaret(src, 9)).toBe(null);
  });

  it('with multiple chips, returns the chip the caret is inside', () => {
    const src = '`a` `b`';
    // a: 0..3, b: 4..7. Strict-interior: caret at 1 → a; at 5 → b.
    expect(inlineChipAtCaret(src, 1).value).toBe('a');
    expect(inlineChipAtCaret(src, 5).value).toBe('b');
  });

  it('returns null between chips', () => {
    const src = '`a` `b`';
    // offset 3 is right after first chip (the space); offset 4 is start
    // of second chip.
    expect(inlineChipAtCaret(src, 3)).toBe(null);
    expect(inlineChipAtCaret(src, 4)).toBe(null);
  });

  it('returns null for caret in plain text after the chip', () => {
    const src = '`a` text';
    expect(inlineChipAtCaret(src, 6)).toBe(null);
  });
});

// ===========================================================================
// Emphasis pass — parseEmphasis() + parseRich()
// ===========================================================================

describe('parseEmphasis()', () => {
  it('returns empty array for empty / non-string input', () => {
    expect(parseEmphasis('')).toEqual([]);
    expect(parseEmphasis(null)).toEqual([]);
    expect(parseEmphasis(undefined)).toEqual([]);
  });

  it('plain text emits a single text segment', () => {
    expect(parseEmphasis('hello world')).toEqual([
      { type: 'text', value: 'hello world', relStart: 0, relEnd: 11 },
    ]);
  });

  describe('bold', () => {
    it('emits bold for **text**', () => {
      const out = parseEmphasis('a **foo** b');
      expect(out.map((s) => s.type)).toEqual(['text', 'bold', 'text']);
      expect(out[1]).toMatchObject({ type: 'bold', value: 'foo', raw: '**foo**' });
    });

    it('handles bold at the very start', () => {
      const out = parseEmphasis('**foo** bar');
      expect(out[0].type).toBe('bold');
      expect(out[0].value).toBe('foo');
    });

    it('handles bold at the very end', () => {
      const out = parseEmphasis('bar **foo**');
      const last = out[out.length - 1];
      expect(last.type).toBe('bold');
      expect(last.value).toBe('foo');
    });

    it('multiple bold runs on the same line', () => {
      const out = parseEmphasis('**a** and **b**');
      expect(out.map((s) => s.type)).toEqual(['bold', 'text', 'bold']);
    });

    it('does NOT match bold across newlines', () => {
      const out = parseEmphasis('**foo\nbar**');
      expect(out.find((s) => s.type === 'bold')).toBeUndefined();
    });

    it('rejects empty bold (****)', () => {
      const out = parseEmphasis('a **** b');
      expect(out.find((s) => s.type === 'bold')).toBeUndefined();
    });

    it('rejects bold with leading/trailing whitespace inside (** foo **)', () => {
      const out = parseEmphasis('a ** foo ** b');
      expect(out.find((s) => s.type === 'bold')).toBeUndefined();
    });

    it('matches single-character bold (**x**)', () => {
      const out = parseEmphasis('**x**');
      expect(out[0]).toMatchObject({ type: 'bold', value: 'x' });
    });
  });

  describe('italic', () => {
    it('emits italic for *text*', () => {
      const out = parseEmphasis('a *foo* b');
      expect(out.map((s) => s.type)).toEqual(['text', 'italic', 'text']);
      expect(out[1]).toMatchObject({ type: 'italic', value: 'foo', raw: '*foo*' });
    });

    it('does NOT match italic when surrounded by other asterisks (** part)', () => {
      // The lookahead/lookbehind (?!\*) and (?<!\*) prevent half-of-bold matches.
      const out = parseEmphasis('**foo**');
      expect(out.find((s) => s.type === 'italic')).toBeUndefined();
      expect(out[0].type).toBe('bold');
    });

    it('rejects empty italic (**)', () => {
      const out = parseEmphasis('a ** b');
      // The lone ** with no closer is not italic.
      expect(out.find((s) => s.type === 'italic')).toBeUndefined();
    });

    it('rejects italic with leading/trailing whitespace (* foo *)', () => {
      const out = parseEmphasis('a * foo * b');
      expect(out.find((s) => s.type === 'italic')).toBeUndefined();
    });

    it('does NOT match math expression (5*7=35)', () => {
      const out = parseEmphasis('5*7=35');
      expect(out.find((s) => s.type === 'italic')).toBeUndefined();
      expect(out).toEqual([
        { type: 'text', value: '5*7=35', relStart: 0, relEnd: 6 },
      ]);
    });

    it('matches italic mid-sentence', () => {
      const out = parseEmphasis('this is *very* important');
      const it_ = out.find((s) => s.type === 'italic');
      expect(it_).toBeTruthy();
      expect(it_.value).toBe('very');
    });

    it('does NOT match italic across newlines', () => {
      const out = parseEmphasis('*foo\nbar*');
      expect(out.find((s) => s.type === 'italic')).toBeUndefined();
    });

    it('matches single-character italic (*x*)', () => {
      const out = parseEmphasis('*x*');
      expect(out[0]).toMatchObject({ type: 'italic', value: 'x' });
    });
  });

  describe('strike', () => {
    it('emits strike for ~~text~~', () => {
      const out = parseEmphasis('a ~~foo~~ b');
      expect(out.map((s) => s.type)).toEqual(['text', 'strike', 'text']);
      expect(out[1]).toMatchObject({ type: 'strike', value: 'foo', raw: '~~foo~~' });
    });

    it('rejects empty strike (~~~~)', () => {
      const out = parseEmphasis('a ~~~~ b');
      expect(out.find((s) => s.type === 'strike')).toBeUndefined();
    });

    it('rejects strike with leading/trailing whitespace (~~ foo ~~)', () => {
      const out = parseEmphasis('a ~~ foo ~~ b');
      expect(out.find((s) => s.type === 'strike')).toBeUndefined();
    });

    it('does NOT match strike with single tilde (~foo~)', () => {
      const out = parseEmphasis('~foo~');
      expect(out.find((s) => s.type === 'strike')).toBeUndefined();
    });

    it('does NOT match strike across newlines', () => {
      const out = parseEmphasis('~~foo\nbar~~');
      expect(out.find((s) => s.type === 'strike')).toBeUndefined();
    });
  });

  describe('precedence and composition', () => {
    it('bold matches before italic (greedy on length)', () => {
      const out = parseEmphasis('**foo**');
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe('bold');
    });

    it('triple-asterisk falls through as literal text (no nesting v1)', () => {
      // Plan §8.1 + phoenix: `***foo***` → literal. Interior of bold can't
      // start with `*` per our regex; interior of italic can't be `*foo*`.
      // Result: no match, plain text.
      const out = parseEmphasis('***foo***');
      expect(out.find((s) => s.type === 'bold' || s.type === 'italic')).toBeUndefined();
      expect(out).toEqual([
        { type: 'text', value: '***foo***', relStart: 0, relEnd: 9 },
      ]);
    });

    it('bold then italic on same line are independent', () => {
      const out = parseEmphasis('**bold** and *italic*');
      const types = out.map((s) => s.type);
      expect(types).toEqual(['bold', 'text', 'italic']);
    });

    it('italic + strike + bold all on same line', () => {
      const out = parseEmphasis('one *two* three ~~four~~ five **six**');
      const kinds = out.filter((s) => s.type !== 'text').map((s) => s.type);
      expect(kinds).toEqual(['italic', 'strike', 'bold']);
    });

    it('relative offsets are correct for emphasis tokens', () => {
      const out = parseEmphasis('aa *bb* cc');
      const it_ = out.find((s) => s.type === 'italic');
      expect(it_.relStart).toBe(3);
      expect(it_.relEnd).toBe(7);
    });

    it('decorative ***divider*** stays literal', () => {
      // Triple-asterisk runs (e.g., visual dividers) should not render.
      const out = parseEmphasis('--- ***divider*** ---');
      const emphasis = out.filter((s) => s.type !== 'text');
      expect(emphasis).toHaveLength(0);
    });
  });
});

describe('parseRich()', () => {
  it('plain text composes as a single text token', () => {
    expect(parseRich('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('emphasis is emitted from text regions only', () => {
    const out = parseRich('a **bold** b');
    expect(out.map((t) => t.type)).toEqual(['text', 'bold', 'text']);
    expect(out[1]).toMatchObject({ type: 'bold', value: 'bold' });
  });

  describe('code wins over emphasis', () => {
    it('asterisks INSIDE an inline-code chip stay literal (no italic)', () => {
      const out = parseRich('hello `*not italic*` world');
      const types = out.map((t) => t.type);
      // text, inline-code, text — no emphasis tokens.
      expect(types).toEqual(['text', 'inline-code', 'text']);
      expect(out[1].value).toBe('*not italic*');
    });

    it('asterisks INSIDE a block-code stay literal', () => {
      const src = '```\n*not italic*\n```';
      const out = parseRich(src);
      expect(out.map((t) => t.type)).toEqual(['block-code']);
      expect(out[0].value).toBe('*not italic*');
    });

    it('emphasis BEFORE a chip works; chip body is verbatim', () => {
      const out = parseRich('*hello* `world`');
      const types = out.map((t) => t.type);
      expect(types).toEqual(['italic', 'text', 'inline-code']);
      expect(out[0].value).toBe('hello');
      expect(out[2].value).toBe('world');
    });

    it('emphasis AFTER a chip works', () => {
      const out = parseRich('`hello` *world*');
      const types = out.map((t) => t.type);
      expect(types).toEqual(['inline-code', 'text', 'italic']);
    });

    it('bold BETWEEN two chips', () => {
      const out = parseRich('`a` **bold** `b`');
      const types = out.map((t) => t.type);
      expect(types).toEqual(['inline-code', 'text', 'bold', 'text', 'inline-code']);
    });

    it('strike adjacent to a chip', () => {
      const out = parseRich('~~strike~~ `code`');
      const types = out.map((t) => t.type);
      expect(types).toEqual(['strike', 'text', 'inline-code']);
    });
  });

  describe('absolute source offsets', () => {
    it('emphasis tokens carry absolute start/end into the original source', () => {
      const out = parseRich('xx *yy* zz');
      const it_ = out.find((t) => t.type === 'italic');
      expect(it_.start).toBe(3);
      expect(it_.end).toBe(7);
    });

    it('emphasis offsets stay correct after a code block', () => {
      const src = '`code` and *italic* end';
      // `code` occupies 0..6 (7 chars including ticks). " and " is 6..11.
      // *italic* occupies 11..19.
      const out = parseRich(src);
      const it_ = out.find((t) => t.type === 'italic');
      expect(it_.start).toBe(11);
      expect(it_.end).toBe(19);
    });

    it('emphasis offsets stay correct after a block-code', () => {
      const src = '```\nbody\n```\nthen *italic* end';
      const out = parseRich(src);
      const it_ = out.find((t) => t.type === 'italic');
      expect(it_).toBeTruthy();
      expect(src.slice(it_.start, it_.end)).toBe('*italic*');
    });
  });

  describe('does NOT regress code parsing', () => {
    it('parseRich produces the same code tokens as parse for code-only input', () => {
      const src = 'a `b` c';
      const a = parse(src);
      const b = parseRich(src);
      // parseRich has the same ordering for non-emphasis tokens; text tokens
      // may differ in shape (no relStart/relEnd), but type+value must match.
      expect(b.map((t) => t.type)).toEqual(a.map((t) => t.type));
      expect(b.map((t) => t.value)).toEqual(a.map((t) => t.value));
    });

    it('block-code with closing fence is preserved verbatim', () => {
      const src = '```python\nprint("**hi**")\n```';
      const out = parseRich(src);
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe('block-code');
      expect(out[0].lang).toBe('python');
      expect(out[0].value).toBe('print("**hi**")');
    });
  });
});
