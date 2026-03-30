import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const MOCKUPS_DIR = '/home/plafayette/claude-comms/mockups';

test.describe('Visual Regression Screenshots', () => {
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://localhost:6005/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await expect(page.locator('[data-testid="message-input"]')).toBeAttached({ timeout: 30000 });
    await delay(1000);
  });

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

  async function cdpScreenshot(name) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(MOCKUPS_DIR, `${name}.png`), Buffer.from(data, 'base64'));
  }

  test('Round 1: Comprehensive screenshots', async ({ page }) => {
    // 1. Empty chat
    await cdpScreenshot('final-state-01-empty-chat');

    // 2. After sending 3 messages
    await sendMessage('Hey everyone, just pushed the new authentication module.');
    await sendMessage('It supports OAuth2 and SAML now.');
    await sendMessage('Let me know if you find any issues during testing!');
    await delay(500);
    await cdpScreenshot('final-state-02-with-messages');

    // 3. Search panel open
    await clickEl('[data-testid="header-search-btn"]');
    await delay(500);
    await cdpScreenshot('final-state-03-search-panel');

    // Close search
    await clickEl('[data-testid="search-panel-close"]');
    await delay(300);

    // 4. Settings panel open
    await clickEl('[data-testid="header-settings-btn"]');
    await delay(500);
    await cdpScreenshot('final-state-04-settings-panel');

    // Close settings
    await clickEl('[data-testid="header-settings-btn"]');
    await delay(300);

    // 5. Emoji picker open
    await clickEl('[data-testid="input-emoji"]');
    await delay(500);
    await cdpScreenshot('final-state-05-emoji-picker');

    // Close emoji picker
    await ce(`document.body.click()`);
    await delay(300);

    // 6. Profile card open (click on sidebar user profile)
    await clickEl('[data-testid="sidebar-user-profile"]');
    await delay(500);
    await cdpScreenshot('final-state-06-profile-card');

    // Close profile card
    await ce(`document.body.click()`);
    await delay(300);

    // 7. Channel modal open
    await clickEl('[data-testid="sidebar-create-channel"]');
    await delay(500);
    await cdpScreenshot('final-state-07-channel-modal');

    // Close modal
    await clickEl('[data-testid="channel-modal-close"]');
    await delay(300);

    // 8. Light theme
    await clickEl('[data-testid="theme-toggle"]');
    await delay(500);
    await cdpScreenshot('final-state-08-light-theme');

    // Switch back to dark
    await clickEl('[data-testid="theme-toggle"]');
    await delay(300);
  });
});
