<!--
  @component RichText
  @description Renders a source string with backtick highlighting (inline
    chips and triple-tick code blocks). Used in two surfaces:

    - variant="message" — final rendered output (MessageBubble); backticks
      are visually folded under the chip / block.
    - variant="overlay" — composer mirror layer behind a transparent textarea
      (highlight-within-textarea pattern). Backticks are rendered inline at
      low opacity so character widths match the underlying textarea exactly,
      keeping caret math sane.

    The component does NOT handle mentions or links — those concerns live in
    MessageBubble's own pipeline, which calls the parser first and then
    further splits `text` tokens.

  @prop {string} source - The source string to render.
  @prop {'message'|'overlay'} variant - Render mode (default 'message').
-->
<script>
  import { parse, parseRich } from '../lib/rich-text-parser.js';

  let { source = '', variant = 'message' } = $props();
  // Composer overlay must not reflow / restyle text — emphasis would change
  // glyph metrics (bold widens, italic shears) and break textarea↔overlay
  // caret alignment. So overlay sticks with bare `parse()` (code tokens
  // only); message variant uses `parseRich()` which adds bold/italic/strike.
  let tokens = $derived(variant === 'overlay' ? parse(source) : parseRich(source));
</script>

{#each tokens as t, i (i)}
  {#if t.type === 'text'}
    <!-- preserve whitespace including newlines via white-space: pre-wrap on parent -->
    <span class="rt-text">{t.value}</span>
  {:else if t.type === 'bold'}
    <strong class="md-bold">{t.value}</strong>
  {:else if t.type === 'italic'}
    <em class="md-italic">{t.value}</em>
  {:else if t.type === 'strike'}
    <span class="md-strike">{t.value}</span>
  {:else if t.type === 'inline-code'}
    {#if variant === 'overlay'}
      <span class="rt-tick rt-tick-open">`</span><span class="rt-chip rt-chip-overlay">{t.value}</span><span class="rt-tick rt-tick-close">`</span>
    {:else}
      <span class="rt-chip">{t.value}</span>
    {/if}
  {:else if t.type === 'block-code' || t.type === 'unclosed-block'}
    {#if variant === 'overlay'}
      <!-- in overlay we render the raw with low-opacity ticks so widths match -->
      <span class="rt-block-overlay" data-lang={t.lang ?? ''}>{t.raw}</span>
    {:else}
      <pre class="rt-block" data-lang={t.lang ?? ''}><code>{t.value}</code>{#if t.lang}<span class="rt-block-lang">{t.lang}</span>{/if}</pre>
    {/if}
  {/if}
{/each}

<style>
  /* ── Inline chip (rendered message variant) ──────────────────────── */
  .rt-chip {
    /* Use monospace ONLY in the rendered-message variant. Overlay keeps
       inherited font for caret-position parity (see plan §10.5). */
    font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
    font-size: 0.92em;
    background: var(--code-chip-bg);
    color: var(--code-chip-fg);
    border: 1px solid var(--code-chip-border);
    border-radius: 6px;
    padding: 1px 6px;
    /* Tighten vertical to keep line-height stable in flowing text. */
    line-height: 1;
    /* Match neighbour leading by adding a small vertical compensation. */
    display: inline-block;
    transform: translateY(0.5px);
  }

  /* ── Inline chip (overlay variant) ──────────────────────────────────
     Overlay variant must NOT change font/size/line-height so the chip's
     character width exactly matches the underlying textarea characters.
     We only adjust color/background. */
  .rt-chip-overlay {
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    background: var(--code-chip-bg);
    color: var(--code-chip-fg);
    border-radius: 4px;
    padding: 0;
    box-shadow: 0 0 0 1px var(--code-chip-border) inset;
  }

  /* The opening/closing ticks shown in overlay variant only. Low-opacity
     so users see them (caret math) but they recede visually. */
  .rt-tick {
    color: var(--code-chip-fg);
    opacity: 0.45;
  }

  /* ── Block code (rendered message variant) ───────────────────────── */
  .rt-block {
    position: relative;
    background: var(--code-block-bg);
    color: var(--code-block-fg);
    border: 1px solid var(--code-block-border);
    border-radius: 8px;
    padding: 10px 12px;
    margin: 8px 0;
    font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
    font-size: 12.5px;
    line-height: 1.55;
    overflow-x: auto;
    white-space: pre;
    tab-size: 2;
  }

  .rt-block code {
    background: none;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    padding: 0;
  }

  .rt-block-lang {
    position: absolute;
    top: 4px;
    right: 8px;
    font-size: 10px;
    color: var(--code-block-lang-fg);
    text-transform: lowercase;
    font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
    letter-spacing: 0.04em;
    pointer-events: none;
    user-select: none;
  }

  /* ── Block code (overlay variant) ────────────────────────────────── */
  .rt-block-overlay {
    /* Just tint the background; widths must match textarea. */
    background: var(--code-block-bg);
    color: var(--code-block-fg);
    border-radius: 4px;
    /* whitespace handled by parent overlay's pre-wrap */
  }

  /* Plain text spans: nothing special — let parent's white-space handle. */
  .rt-text {
    /* placeholder to give the span a class; parent decides wrap rules. */
  }

  /* ── Inline emphasis (rendered message variant only) ─────────────────
     Markdown-style bold / italic / strike. Inherit color + size from the
     bubble so contrast tracks the theme. NEVER applied in the overlay
     variant — see <script> note about glyph-metrics caret alignment. */
  .md-bold {
    font-weight: 700;
  }

  .md-italic {
    font-style: italic;
  }

  .md-strike {
    text-decoration: line-through;
    text-decoration-thickness: 1.5px;
    text-decoration-color: currentColor;
  }
</style>
