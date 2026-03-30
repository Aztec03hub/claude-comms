import { test, expect } from '@playwright/test';

/**
 * Emoji Picker & Reaction System tests.
 *
 * Uses CDP Runtime.evaluate + WebSocket mock to avoid event loop blocking
 * caused by MQTT reconnection cycles in the mqtt.js library.
 */
test.describe('Emoji Picker & Reaction System', () => {

  test.setTimeout(30000);

  /** @type {import('playwright').CDPSession} */
  let cdp;

  test.beforeEach(async ({ page }) => {
    // Block Google Fonts to prevent screenshot/font-loading hangs
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

    // Mock MQTT WebSocket to prevent event loop blocking
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      window.WebSocket = class MockWebSocket extends EventTarget {
        constructor(url) {
          super();
          this.readyState = 0;
          this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
          this.bufferedAmount = 0; this.extensions = ''; this.protocol = ''; this.binaryType = 'blob';
          if (!url.includes('mqtt')) return new OrigWS(url);
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.({});
            this.dispatchEvent(new Event('open'));
          }, 50);
        }
        send() {}
        close() { this.readyState = 3; }
      };
    });

    // Set up CDP session for fast DOM evaluation
    cdp = await page.context().newCDPSession(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await delay(1500);
  });

  // ── Helpers ──

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function ce(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('CDP eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async function sendMessage(text) {
    await ce(`(() => {
      const i = document.querySelector('[data-testid="message-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, ${JSON.stringify(text)});
      i.dispatchEvent(new Event('input', {bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await delay(500);
  }

  async function clickEl(sel) {
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(300);
  }

  async function countEl(sel) {
    return ce(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  }

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  async function elHasClass(sel, cls) {
    return ce(`document.querySelector(${JSON.stringify(sel)})?.classList?.contains(${JSON.stringify(cls)}) ?? false`);
  }

  async function screenshot(page, name) {
    try {
      await page.screenshot({ path: `/home/plafayette/claude-comms/mockups/${name}.png`, timeout: 5000 });
    } catch { /* font loading may hang — skip */ }
  }

  // ── Tests ──

  test('1. Send 2 messages to create bubbles', async ({ page }) => {
    await sendMessage('Hello from test message one');
    await sendMessage('Second test message for reactions');

    const count = await countEl('.bubble');
    expect(count).toBe(2);

    await screenshot(page, 'test-emoji-01-messages');
  });

  test('2. Hover message shows action bar', async ({ page }) => {
    await sendMessage('Hover test message');

    const msgRowCount = await countEl('.msg-row:not(.system)');
    expect(msgRowCount).toBeGreaterThanOrEqual(1);

    // Use Playwright hover for CSS :hover to work
    const msgRow = page.locator('.msg-row:not(.system)').first();
    await msgRow.hover({ force: true, timeout: 5000 });
    await delay(500);

    // Check actions bar opacity changed to 1
    const opacity = await ce(`(() => {
      const row = document.querySelector('.msg-row:not(.system)');
      const actions = row?.querySelector('.msg-actions');
      return actions ? getComputedStyle(actions).opacity : 'not found';
    })()`);
    expect(opacity).toBe('1');

    // 3 action buttons: Reply, React, More
    const btnCount = await ce(`
      document.querySelector('.msg-row:not(.system)')?.querySelectorAll('.msg-action-btn')?.length || 0
    `);
    expect(btnCount).toBe(3);

    await screenshot(page, 'test-emoji-02-action-bar');
  });

  test('3. Click React button opens emoji picker', async ({ page }) => {
    await sendMessage('React button test');

    await clickEl('[data-testid="action-react"]');

    const pickerOpen = await exists('[data-testid="emoji-picker"]');
    expect(pickerOpen).toBe(true);

    await screenshot(page, 'test-emoji-03-picker-from-react');
  });

  test('4. Emoji picker has content: search, categories, grid', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');

    // Picker present
    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    // Search input
    expect(await exists('[data-testid="emoji-search"]')).toBe(true);

    // 8 category tabs
    expect(await countEl('[data-testid^="emoji-category-"]')).toBe(8);

    // 16 frequent emojis
    expect(await countEl('[data-testid="emoji-item"]')).toBe(16);

    // Footer with preview
    expect(await exists('.emoji-preview-icon')).toBe(true);
    expect(await exists('.emoji-preview-name')).toBe(true);

    await screenshot(page, 'test-emoji-04-picker-content');
  });

  test('5. Click emoji adds reaction and closes picker', async ({ page }) => {
    await sendMessage('Reaction target message');

    // Open picker via React button
    await clickEl('[data-testid="action-react"]');
    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    // Click first emoji (thumbs up)
    await clickEl('[data-testid="emoji-item"]');

    // Picker should close
    expect(await exists('[data-testid="emoji-picker"]')).toBe(false);

    // Reaction should appear
    const reactionCount = await countEl('.reaction .emoji');
    expect(reactionCount).toBe(1);

    // Check it's the right emoji
    const reactionEmoji = await ce('document.querySelector(".reaction .emoji")?.textContent');
    expect(reactionEmoji).toBeTruthy();

    await screenshot(page, 'test-emoji-05-reaction-added');
  });

  test('6. Input area emoji button opens picker', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');

    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    await screenshot(page, 'test-emoji-06-input-emoji-btn');
  });

  test('7. Click outside picker closes it', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');
    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    // Click directly on the backdrop element (not on a child).
    // The handler checks e.target === e.currentTarget, which is true
    // when clicking the backdrop itself (not the picker inside it).
    // Use Playwright's real click at a corner of the viewport where only the backdrop exists.
    await page.mouse.click(5, 5);
    await delay(300);

    expect(await exists('[data-testid="emoji-picker"]')).toBe(false);

    await screenshot(page, 'test-emoji-07-click-outside');
  });

  test('8. Escape closes picker', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');
    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    // The EmojiPicker listens on svelte:window onkeydown for Escape
    await ce('window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))');
    await delay(300);

    expect(await exists('[data-testid="emoji-picker"]')).toBe(false);

    await screenshot(page, 'test-emoji-08-escape-close');
  });

  test('9. Emoji search does not crash', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');
    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    // Type into search field
    await ce(`(() => {
      const search = document.querySelector('[data-testid="emoji-search"]');
      if (!search) return;
      search.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, 'fire');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(300);

    // Picker should still be open (no crash)
    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    // Search value should be set
    const searchVal = await ce('document.querySelector("[data-testid=\\"emoji-search\\"]")?.value');
    expect(searchVal).toBe('fire');

    await screenshot(page, 'test-emoji-09-search');
  });

  test('10. Category tabs change active state', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');
    expect(await exists('[data-testid="emoji-picker"]')).toBe(true);

    // Default: "frequent" tab is active
    expect(await elHasClass('[data-testid="emoji-category-frequent"]', 'active')).toBe(true);
    expect(await elHasClass('[data-testid="emoji-category-smileys"]', 'active')).toBe(false);

    // Click smileys tab
    await clickEl('[data-testid="emoji-category-smileys"]');
    expect(await elHasClass('[data-testid="emoji-category-smileys"]', 'active')).toBe(true);
    expect(await elHasClass('[data-testid="emoji-category-frequent"]', 'active')).toBe(false);

    // Click nature tab
    await clickEl('[data-testid="emoji-category-nature"]');
    expect(await elHasClass('[data-testid="emoji-category-nature"]', 'active')).toBe(true);
    expect(await elHasClass('[data-testid="emoji-category-smileys"]', 'active')).toBe(false);

    await screenshot(page, 'test-emoji-10-category-tabs');
  });
});
