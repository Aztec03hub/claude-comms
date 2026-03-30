import { test, expect } from '@playwright/test';
import fs from 'fs';

test.describe('Round 8: Edge Cases', () => {
  test.setTimeout(120000);

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

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  async function cdpScreenshot(name) {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`/home/plafayette/claude-comms/mockups/${name}.png`, Buffer.from(data, 'base64'));
    } catch { /* skip */ }
  }

  // --- Very long message wraps correctly ---
  test('long message (500+ chars) wraps correctly', async ({ page }) => {
    // Test with a realistic long message with words
    const words = 'The quick brown fox jumps over the lazy dog. ';
    const longText = words.repeat(12); // ~540 chars
    await sendMessage(longText);
    await delay(300);

    const bubbleInfo = await ce(`(() => {
      const b = document.querySelector('.bubble');
      if (!b) return null;
      const rect = b.getBoundingClientRect();
      const chatView = document.querySelector('[data-testid="chat-view"]');
      const chatRect = chatView?.getBoundingClientRect();
      const msgRow = b.closest('.msg-row');
      const msgRect = msgRow?.getBoundingClientRect();
      return {
        bubbleWidth: rect.width,
        msgRowWidth: msgRect?.width || 0,
        chatWidth: chatRect?.width || 0,
        text: b.textContent?.length || 0,
        overflows: rect.right > (chatRect?.right || window.innerWidth),
        multiLine: rect.height > 60
      };
    })()`);

    expect(bubbleInfo).not.toBeNull();
    expect(bubbleInfo.text).toBeGreaterThanOrEqual(500);
    // Bubble should not overflow the chat view
    expect(bubbleInfo.overflows).toBe(false);
    // Bubble should wrap to multiple lines
    expect(bubbleInfo.multiLine).toBe(true);

    await cdpScreenshot('overnight-r8-01-long-message');
  });

  // --- Very long continuous string wraps ---
  test('long continuous string (no spaces) wraps', async ({ page }) => {
    const longUrl = 'https://example.com/' + 'a'.repeat(500);
    await sendMessage(longUrl);
    await delay(300);

    const bubbleInfo = await ce(`(() => {
      const bubbles = document.querySelectorAll('.bubble');
      const b = bubbles[bubbles.length - 1]; // last bubble
      if (!b) return null;
      const rect = b.getBoundingClientRect();
      const chatView = document.querySelector('[data-testid="chat-view"]');
      const chatRect = chatView?.getBoundingClientRect();
      return {
        bubbleWidth: rect.width,
        chatWidth: chatRect?.width || 0,
        overflows: rect.right > (chatRect?.right || window.innerWidth) + 1,
        multiLine: rect.height > 40
      };
    })()`);

    expect(bubbleInfo).not.toBeNull();
    // After the fix, continuous strings should wrap too
    expect(bubbleInfo.overflows).toBe(false);

    await cdpScreenshot('overnight-r8-01b-long-url');
  });

  // --- Message with @mentions highlighted ---
  test('message with multiple @mentions — all highlighted', async ({ page }) => {
    await sendMessage('Hey @alice and @bob please review @charlie work');
    await delay(300);

    const mentionCount = await ce(`document.querySelectorAll('.mention').length`);
    expect(mentionCount).toBe(3);

    // Check mentions have distinct styling
    const mentionStyles = await ce(`(() => {
      const mentions = document.querySelectorAll('.mention');
      return [...mentions].map(m => ({
        text: m.textContent,
        bg: getComputedStyle(m).backgroundColor,
        color: getComputedStyle(m).color
      }));
    })()`);

    expect(mentionStyles.length).toBe(3);
    expect(mentionStyles[0].text).toBe('@alice');
    expect(mentionStyles[1].text).toBe('@bob');
    expect(mentionStyles[2].text).toBe('@charlie');

    await cdpScreenshot('overnight-r8-02-mentions');
  });

  // --- Send 20+ messages, auto-scroll ---
  test('20+ messages: auto-scroll to bottom', async ({ page }) => {
    for (let i = 1; i <= 22; i++) {
      await sendMessage(`Message number ${i}`);
      await delay(150);
    }
    await delay(500);

    const scrollInfo = await ce(`(() => {
      const el = document.querySelector('[data-testid="chat-view"]');
      if (!el) return null;
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        isAtBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 60
      };
    })()`);

    expect(scrollInfo).not.toBeNull();
    // Should auto-scroll to bottom
    expect(scrollInfo.isAtBottom).toBe(true);
    // Content should overflow (scrollHeight > clientHeight)
    expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight);

    await cdpScreenshot('overnight-r8-03-autoscroll');
  });

  // --- Scroll up shows scroll-to-bottom button ---
  test('scroll up reveals scroll-to-bottom button', async ({ page }) => {
    // Send enough messages to cause scrolling
    for (let i = 1; i <= 25; i++) {
      await sendMessage(`Scroll test message ${i}`);
      await delay(100);
    }
    await delay(500);

    // Initially scroll-to-bottom should be hidden (we're at bottom)
    expect(await exists('[data-testid="scroll-to-bottom"]')).toBe(false);

    // Scroll up
    await ce(`(() => {
      const el = document.querySelector('[data-testid="chat-view"]');
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    })()`);
    await delay(500);

    // Scroll-to-bottom button should appear
    expect(await exists('[data-testid="scroll-to-bottom"]')).toBe(true);
    await cdpScreenshot('overnight-r8-04-scroll-btn');

    // Click scroll-to-bottom
    await clickEl('[data-testid="scroll-to-bottom"]');
    await delay(800); // smooth scroll takes time

    // Should be at bottom again
    const isAtBottom = await ce(`(() => {
      const el = document.querySelector('[data-testid="chat-view"]');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    })()`);
    expect(isAtBottom).toBe(true);

    // Button should be gone
    await delay(300);
    expect(await exists('[data-testid="scroll-to-bottom"]')).toBe(false);
    await cdpScreenshot('overnight-r8-05-scrolled-back');
  });

  // --- Rapid channel switching — no stale messages ---
  test('rapid channel switching — no stale messages', async ({ page }) => {
    // Send messages in first channel
    await sendMessage('Message in general');
    await delay(200);

    const generalBubbles = await ce(`document.querySelectorAll('.bubble').length`);
    expect(generalBubbles).toBeGreaterThanOrEqual(1);

    // Get list of channels
    const channels = await ce(`[...document.querySelectorAll('[data-testid^="channel-item-"]')].map(e => e.dataset.testid)`);

    // Rapidly switch channels
    for (const ch of (channels || []).slice(0, 4)) {
      await ce(`document.querySelector('[data-testid="${ch}"]')?.click()`);
      await delay(100); // very fast switching
    }
    await delay(500);

    // Now switch to last channel
    const lastChannel = channels?.[channels.length - 1];
    if (lastChannel) {
      await ce(`document.querySelector('[data-testid="${lastChannel}"]')?.click()`);
      await delay(500);

      // Header should match the last clicked channel
      const headerName = await ce(`document.querySelector('[data-testid="header-channel-name"]')?.textContent`);
      const expectedName = lastChannel.replace('channel-item-', '');
      expect(headerName).toBe(expectedName);
    }

    // Switch back to general
    await clickEl('[data-testid="channel-item-general"]');
    await delay(500);

    // Original messages should still be there (count may grow due to other tests or accumulated messages)
    const generalBubblesAfter = await ce(`document.querySelectorAll('.bubble').length`);
    expect(generalBubblesAfter).toBeGreaterThanOrEqual(generalBubbles);
    await cdpScreenshot('overnight-r8-06-rapid-switch');
  });

  // --- Message with inline code renders ---
  test('message with markdown-like content renders correctly', async ({ page }) => {
    // The app uses parseMentions but not full markdown - test what it actually supports
    await sendMessage('Here is a `code snippet` and more text');
    await delay(300);

    // The bubble should contain the text
    const bubbleText = await ce(`document.querySelector('.bubble')?.textContent`);
    expect(bubbleText).toContain('code snippet');

    // Send a message with code block syntax
    await sendMessage('Check this: ```const x = 1;```');
    await delay(300);

    const bubbleCount = await ce(`document.querySelectorAll('.bubble').length`);
    expect(bubbleCount).toBeGreaterThanOrEqual(2);
    await cdpScreenshot('overnight-r8-07-code-content');
  });

  // --- Empty messages cannot be sent ---
  test('empty and whitespace-only messages rejected', async ({ page }) => {
    const beforeCount = await ce(`document.querySelectorAll('.bubble').length`);

    // Try empty
    await ce(`(() => {
      const i = document.querySelector('[data-testid="message-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, '');
      i.dispatchEvent(new Event('input', {bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await delay(300);

    // Try whitespace
    await ce(`(() => {
      const i = document.querySelector('[data-testid="message-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, '   ');
      i.dispatchEvent(new Event('input', {bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await delay(300);

    const afterCount = await ce(`document.querySelectorAll('.bubble').length`);
    expect(afterCount).toBe(beforeCount);
  });
});
