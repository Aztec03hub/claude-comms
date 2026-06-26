// Component tests for MessageBubble.svelte — @mentions INSIDE inline
// emphasis (bold / italic / strike).
//
// Primary bug (Phil, user-reported): an `@mention` in PLAIN text renders
// as a gold mention pill, but an `@mention` wrapped in `**bold**` or
// `*italic*` rendered with the emphasis styling but WITHOUT the mention
// color/pill — the emphasis pass swallowed the mention. Mentions must
// ALWAYS get their mention styling regardless of surrounding inline
// markdown.
//
// Root cause: parseBody emitted bold/italic/strike tokens whose inner
// `value` was raw text never run through the mention/link splitter. The
// fix runs the same splitter over the emphasis inner value and renders
// the resulting segments INSIDE the emphasis wrapper (so they inherit
// bold/italic styling AND get their own chip/link styling).
//
// Guards:
//   1. bold   `**@alice**`  → `.mention` chip nested in `<strong>`.
//   2. italic `*@bob*`      → `.mention` chip nested in `<em>`.
//   3. plain  `@carol`      → `.mention` chip (regression guard).
//   4. code   `` `@dave` `` → NO `.mention` chip; literal code chip
//      (code spans are literal; mentions inside must NOT be linkified).
//
// Name grammar is `[\w-]` server-side (mention.py NAME_PATTERN), matched
// case-insensitively against live participants — these fixtures use
// simple lowercase names.

import { describe, test, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import MessageBubble from '../src/components/MessageBubble.svelte';

const ALICE_KEY = 'a11ce000';
const BOB_KEY = 'b0b00000';
const CAROL_KEY = 'ca701000';
const DAVE_KEY = 'da7e0000';

const PARTICIPANTS = {
  [ALICE_KEY]: { key: ALICE_KEY, name: 'alice', type: 'claude', connections: {} },
  [BOB_KEY]: { key: BOB_KEY, name: 'bob', type: 'claude', connections: {} },
  [CAROL_KEY]: { key: CAROL_KEY, name: 'carol', type: 'claude', connections: {} },
  [DAVE_KEY]: { key: DAVE_KEY, name: 'dave', type: 'claude', connections: {} },
};

function makeMessage(overrides = {}) {
  return {
    id: 'msg-emph-1',
    ts: '2026-06-25T12:00:00.000Z',
    sender: { key: 'fffffff0', name: 'sender', type: 'human' },
    body: 'hello',
    reply_to: null,
    mentions: null,
    recipients: null,
    conv: 'general',
    reactions: [],
    thread_count: 0,
    read_by: 0,
    ...overrides,
  };
}

function renderBubble(body) {
  const result = render(MessageBubble, {
    props: {
      message: makeMessage({ body }),
      currentUser: { key: 'fffffff0', name: 'sender', type: 'human' },
      participants: PARTICIPANTS,
      consecutive: false,
      onOpenThread: () => {},
      onContextMenu: () => {},
      onShowProfile: () => {},
      onReact: () => {},
      onMore: () => {},
    },
  });
  return result;
}

afterEach(() => {
  cleanup();
});

describe('MessageBubble — @mention inside inline emphasis', () => {
  test('bold @alice renders a mention chip nested inside <strong>', () => {
    const { container } = renderBubble('**@alice**');

    const mention = container.querySelector('.mention');
    expect(mention).not.toBeNull();
    expect(mention.textContent).toBe('@alice');

    // The mention chip lives INSIDE the bold wrapper, so it gets both the
    // mention color and the bold styling.
    const strong = container.querySelector('strong.md-bold');
    expect(strong).not.toBeNull();
    expect(strong.querySelector('.mention')).toBe(mention);
  });

  test('italic @bob renders a mention chip nested inside <em>', () => {
    const { container } = renderBubble('*@bob*');

    const mention = container.querySelector('.mention');
    expect(mention).not.toBeNull();
    expect(mention.textContent).toBe('@bob');

    const em = container.querySelector('em.md-italic');
    expect(em).not.toBeNull();
    expect(em.querySelector('.mention')).toBe(mention);
  });

  test('strike @carol renders a mention chip nested inside the strike span', () => {
    const { container } = renderBubble('~~@carol~~');

    const mention = container.querySelector('.mention');
    expect(mention).not.toBeNull();
    expect(mention.textContent).toBe('@carol');

    const strike = container.querySelector('.md-strike');
    expect(strike).not.toBeNull();
    expect(strike.querySelector('.mention')).toBe(mention);
  });

  test('plain @carol still renders a mention chip (regression guard)', () => {
    const { container } = renderBubble('@carol');

    const mention = container.querySelector('.mention');
    expect(mention).not.toBeNull();
    expect(mention.textContent).toBe('@carol');

    // Not wrapped in any emphasis element.
    expect(container.querySelector('strong.md-bold')).toBeNull();
    expect(container.querySelector('em.md-italic')).toBeNull();
  });

  test('@dave inside inline `code` is NOT linkified as a mention', () => {
    // Code spans are literal — even though `dave` is a real participant,
    // the @name inside backticks must stay literal text in a code chip.
    const { container } = renderBubble('`@dave`');

    expect(container.querySelector('.mention')).toBeNull();
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();

    const codeChip = container.querySelector('.code-chip');
    expect(codeChip).not.toBeNull();
    expect(codeChip.textContent).toBe('@dave');
  });

  test('mixed: "**@alice** and @bob" renders both as mention chips', () => {
    const { container } = renderBubble('**@alice** and @bob');

    const mentions = container.querySelectorAll('.mention');
    expect(mentions.length).toBe(2);
    const texts = [...mentions].map((m) => m.textContent);
    expect(texts).toContain('@alice');
    expect(texts).toContain('@bob');

    // @alice is the one inside bold.
    const strong = container.querySelector('strong.md-bold');
    expect(strong).not.toBeNull();
    expect(strong.querySelector('.mention').textContent).toBe('@alice');
  });
});
