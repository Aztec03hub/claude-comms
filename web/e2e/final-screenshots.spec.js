import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const OUT = '/home/plafayette/claude-comms/mockups';
const delay = ms => new Promise(r => setTimeout(r, ms));

test.describe('Final Screenshots', () => {
  test.setTimeout(300000);

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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-testid="message-input"]', { timeout: 30000 });
    await delay(1000);
  });

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

  async function cdpScreenshot(name) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }

  // 1. Fresh load with empty state
  test('01 - main empty state', async ({ page }) => {
    await cdpScreenshot('final-01-main');
  });

  // 2. After sending 4 varied messages
  test('02 - varied messages', async ({ page }) => {
    await sendMessage('Hello everyone!');
    await sendMessage('Hey @Claude, can you check the latest deployment status? The build pipeline seems to be taking longer than usual today.');
    await sendMessage('```javascript\nconst greeting = "Hello World";\nconsole.log(greeting);\n```');
    await sendMessage('Great work team! \u{1F389}\u{1F680}\u{1F525} Ship it!');
    await delay(500);
    await cdpScreenshot('final-02-messages');
  });

  // 3. Multiple consecutive messages showing grouping
  test('03 - grouped messages', async ({ page }) => {
    await sendMessage('First message in the group');
    await sendMessage('Second message right after');
    await sendMessage('Third consecutive message');
    await sendMessage('Fourth in the sequence');
    await sendMessage('And a fifth to really show the grouping');
    await delay(300);
    await cdpScreenshot('final-03-grouped');
  });

  // 4. Search panel open
  test('04 - search panel', async ({ page }) => {
    await sendMessage('Testing search functionality');
    await sendMessage('Another message to search through');
    await clickEl('[data-testid="header-search-btn"]');
    await delay(500);
    await cdpScreenshot('final-04-search');
  });

  // 5. Settings panel open
  test('05 - settings panel', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');
    await delay(500);
    await cdpScreenshot('final-05-settings');
  });

  // 6. Emoji picker open
  test('06 - emoji picker', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');
    await delay(500);
    await cdpScreenshot('final-06-emoji');
  });

  // 7. Right-click context menu
  test('07 - context menu', async ({ page }) => {
    await sendMessage('Right-click this message for context menu');
    await delay(300);
    // Use Playwright's native right-click for context menu
    const bubble = page.locator('.bubble').first();
    await bubble.click({ button: 'right', timeout: 5000 });
    await delay(500);
    await cdpScreenshot('final-07-context');
  });

  // 8. Channel creation modal
  test('08 - channel modal', async ({ page }) => {
    await clickEl('[data-testid="sidebar-create-channel"]');
    await delay(500);
    // Type some content into the modal fields
    await ce(`(() => {
      const nameInput = document.querySelector('[data-testid="channel-modal-name-input"]');
      if (nameInput) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(nameInput, 'project-alpha');
        nameInput.dispatchEvent(new Event('input', {bubbles:true}));
      }
      const desc = document.querySelector('[data-testid="channel-modal-description"]');
      if (desc) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        s.call(desc, 'Discussion channel for Project Alpha development and planning');
        desc.dispatchEvent(new Event('input', {bubbles:true}));
      }
    })()`);
    await delay(300);
    await cdpScreenshot('final-08-modal');
  });

  // 9. Thread panel with reply
  test('09 - thread panel', async ({ page }) => {
    await sendMessage('This message starts a thread discussion');
    await delay(300);
    // Hover to show action bar, then click reply
    const bubble = page.locator('.bubble').first();
    await bubble.hover({ timeout: 5000 });
    await delay(300);
    await clickEl('[data-testid="action-reply"]');
    await delay(500);
    // Type a reply in the thread
    await ce(`(() => {
      const i = document.querySelector('[data-testid="thread-reply-input"]');
      if (i) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(i, 'Great point! I agree with this approach.');
        i.dispatchEvent(new Event('input', {bubbles:true}));
        i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      }
    })()`);
    await delay(500);
    await cdpScreenshot('final-09-thread');
  });

  // 10. Light theme
  test('10 - light theme', async ({ page }) => {
    await sendMessage('Light theme showcase');
    await sendMessage('The app looks great in both themes!');
    await clickEl('[data-testid="theme-toggle"]');
    await delay(500);
    await cdpScreenshot('final-10-light');
  });

  // 11. Mobile viewport (480px)
  test('11 - mobile', async ({ page }) => {
    await sendMessage('Mobile responsive view');
    await sendMessage('Looks great on small screens too!');
    await page.setViewportSize({ width: 480, height: 900 });
    await delay(500);
    await cdpScreenshot('final-11-mobile');
  });

  // 12. Messages with reactions
  test('12 - reactions', async ({ page }) => {
    await sendMessage('This message gets reactions!');
    await sendMessage('Another message with different reactions');
    await delay(300);

    // Add reaction to first message via hover -> React button -> emoji picker
    const firstBubble = page.locator('.bubble').first();
    await firstBubble.hover({ timeout: 5000 });
    await delay(300);
    await clickEl('[data-testid="action-react"]');
    await delay(500);
    // Click first emoji
    await clickEl('[data-testid="emoji-item"]');
    await delay(500);

    // Add reaction to second message
    const secondBubble = page.locator('.bubble').nth(1);
    await secondBubble.hover({ timeout: 5000 });
    await delay(300);
    await clickEl('[data-testid="action-react"]');
    await delay(500);
    await ce(`(() => {
      const emojis = document.querySelectorAll('[data-testid="emoji-item"]');
      if (emojis.length > 5) emojis[5].click();
      else if (emojis.length > 0) emojis[0].click();
    })()`);
    await delay(500);

    await cdpScreenshot('final-12-reactions');
  });
});
