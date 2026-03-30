import { test, expect } from '@playwright/test';

test.describe('Thread Panel Interactions', () => {
  test.setTimeout(60000);

  /** @type {import('playwright').CDPSession} */
  let cdp;

  test.beforeEach(async ({ page }) => {
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

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

    cdp = await page.context().newCDPSession(page);

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await expect(page.locator('[data-testid="message-input"]')).toBeAttached({ timeout: 30000 });
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

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  async function openThreadOnFirstMessage() {
    // Send a message to have something to thread on
    await sendMessage('Thread parent message');
    await delay(300);

    // Right-click the message to open context menu
    const bubble = await ce(`!!document.querySelector('.bubble')`);
    if (!bubble) throw new Error('No message bubble found');

    // Use Playwright right-click for real contextmenu event
    return true;
  }

  // ── Tests ──

  test('Reply action from context menu opens thread panel', async ({ page }) => {
    await sendMessage('Thread parent message');
    await delay(300);

    // Right-click the first bubble to trigger context menu
    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);

    expect(await exists('[data-testid="context-menu"]')).toBe(true);

    // Click Reply
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    expect(await exists('[data-testid="thread-panel"]')).toBe(true);
  });

  test('thread panel shows parent message body', async ({ page }) => {
    await sendMessage('Unique parent text ABC123');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    const parentText = await ce(`document.querySelector('.thread-parent-text')?.textContent`);
    expect(parentText).toContain('Unique parent text ABC123');
  });

  test('thread panel has reply input and send button', async ({ page }) => {
    await sendMessage('Parent for input test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    expect(await exists('[data-testid="thread-reply-input"]')).toBe(true);
    expect(await exists('[data-testid="thread-send"]')).toBe(true);
  });

  test('typing in thread reply input updates value', async ({ page }) => {
    await sendMessage('Parent for typing test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    await ce(`(() => {
      const input = document.querySelector('[data-testid="thread-reply-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Hello from thread');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(200);

    const val = await ce(`document.querySelector('[data-testid="thread-reply-input"]')?.value`);
    expect(val).toBe('Hello from thread');
  });

  test('Enter key in thread reply input sends reply and clears input', async ({ page }) => {
    await sendMessage('Parent for enter-send test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    // Type into the reply input
    await ce(`(() => {
      const input = document.querySelector('[data-testid="thread-reply-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Reply via Enter');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(200);

    // Press Enter
    await ce(`(() => {
      const input = document.querySelector('[data-testid="thread-reply-input"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await delay(500);

    // Input should be cleared after send
    const val = await ce(`document.querySelector('[data-testid="thread-reply-input"]')?.value`);
    expect(val).toBe('');
  });

  test('Shift+Enter in thread reply does NOT send', async ({ page }) => {
    await sendMessage('Parent for shift-enter test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    await ce(`(() => {
      const input = document.querySelector('[data-testid="thread-reply-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Should not send');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(200);

    // Press Shift+Enter
    await ce(`(() => {
      const input = document.querySelector('[data-testid="thread-reply-input"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    })()`);
    await delay(300);

    // Input should still have its value
    const val = await ce(`document.querySelector('[data-testid="thread-reply-input"]')?.value`);
    expect(val).toBe('Should not send');
  });

  test('send button click sends reply and clears input', async ({ page }) => {
    await sendMessage('Parent for button-send test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    await ce(`(() => {
      const input = document.querySelector('[data-testid="thread-reply-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Reply via button');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(200);

    // Click send button
    await clickEl('[data-testid="thread-send"]');
    await delay(500);

    const val = await ce(`document.querySelector('[data-testid="thread-reply-input"]')?.value`);
    expect(val).toBe('');
  });

  test('thread panel close button dismisses panel', async ({ page }) => {
    await sendMessage('Parent for close test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    expect(await exists('[data-testid="thread-panel"]')).toBe(true);

    await clickEl('[data-testid="thread-panel-close"]');
    await delay(400);

    expect(await exists('[data-testid="thread-panel"]')).toBe(false);
  });

  test('Escape closes thread panel', async ({ page }) => {
    await sendMessage('Parent for escape test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    expect(await exists('[data-testid="thread-panel"]')).toBe(true);

    await page.keyboard.press('Escape');
    await delay(400);

    expect(await exists('[data-testid="thread-panel"]')).toBe(false);
  });

  test('empty reply input does not send on Enter', async ({ page }) => {
    await sendMessage('Parent for empty-send test');
    await delay(300);

    await page.locator('.bubble').first().click({ button: 'right' });
    await delay(300);
    await clickEl('[data-testid="ctx-reply"]');
    await delay(400);

    // Ensure input is empty
    const before = await ce(`document.querySelectorAll('.thread-reply').length`);

    // Press Enter on empty input
    await ce(`(() => {
      const input = document.querySelector('[data-testid="thread-reply-input"]');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await delay(300);

    // No new reply should appear
    const after = await ce(`document.querySelectorAll('.thread-reply').length`);
    expect(after).toBe(before);
  });
});
