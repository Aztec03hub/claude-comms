import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = '/home/plafayette/claude-comms/mockups';
const BASE = 'http://localhost:6001';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Block Google Fonts (Issue E)
  await page.route('**/fonts.googleapis.com/**', route => route.abort());
  await page.route('**/fonts.gstatic.com/**', route => route.abort());

  // Mock MQTT WebSocket (Issue A)
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

  // Set up CDP for fast DOM interaction
  const cdp = await page.context().newCDPSession(page);

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
    console.log(`  [OK] ${name}.png`);
  }

  // Navigate
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('[data-testid="message-input"]').waitFor({ state: 'attached', timeout: 30000 });
  await delay(1000);

  // 1. Main page fresh load
  console.log('1. Main page...');
  await cdpScreenshot('morning-01-main');

  // 2. Send 3 varied messages
  console.log('2. Sending messages...');
  await sendMessage('Hey everyone!');
  await sendMessage('This is a longer message to test how the chat handles multiple lines of text and wrapping behavior in the message bubbles. It should look clean and readable even at this length.');
  await sendMessage('Has anyone seen @Phil today? We need to review the deployment plan.');
  await delay(500);
  await cdpScreenshot('morning-02-messages');

  // 3. Search panel
  console.log('3. Search panel...');
  await clickEl('[data-testid="header-search-btn"]');
  await delay(500);
  await cdpScreenshot('morning-03-search');
  await clickEl('[data-testid="search-panel-close"]');
  await delay(300);

  // 4. Settings panel
  console.log('4. Settings panel...');
  await clickEl('[data-testid="header-settings-btn"]');
  await delay(500);
  await cdpScreenshot('morning-04-settings');
  // Close settings - click somewhere else or press escape
  await ce(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await delay(300);

  // 5. Emoji picker
  console.log('5. Emoji picker...');
  await clickEl('[data-testid="input-emoji"]');
  await delay(500);
  await cdpScreenshot('morning-05-emoji');
  await ce(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await delay(300);

  // 6. Context menu (right-click on message)
  console.log('6. Context menu...');
  const bubbleEl = page.locator('.bubble').first();
  try {
    await bubbleEl.click({ button: 'right', timeout: 5000 });
    await delay(500);
    await cdpScreenshot('morning-06-context');
    // Close context menu
    await ce(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await delay(300);
  } catch (e) {
    console.log('  [WARN] Context menu: ' + e.message);
    await cdpScreenshot('morning-06-context');
  }

  // 7. Channel creation modal
  console.log('7. Channel modal...');
  await clickEl('[data-testid="sidebar-create-channel"]');
  await delay(500);
  await cdpScreenshot('morning-07-modal');
  await clickEl('[data-testid="channel-modal-cancel"]');
  await delay(300);

  // 8. Profile card
  console.log('8. Profile card...');
  // Click on a member in the sidebar user profile area or a message sender
  await clickEl('[data-testid="sidebar-user-profile"]');
  await delay(500);
  await cdpScreenshot('morning-08-profile');
  // Close profile
  await ce(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await delay(300);

  // 9. Thread panel with reply
  console.log('9. Thread panel...');
  // Hover on a message to get action bar, then click reply
  const firstBubble = page.locator('.bubble').first();
  try {
    await firstBubble.hover({ timeout: 5000 });
    await delay(300);
    await clickEl('[data-testid="action-reply"]');
    await delay(500);
    // Type a reply in thread
    await ce(`(() => {
      const i = document.querySelector('[data-testid="thread-reply-input"]');
      if (i) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(i, 'Great point! I agree.');
        i.dispatchEvent(new Event('input', {bubbles:true}));
        i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      }
    })()`);
    await delay(500);
    await cdpScreenshot('morning-09-thread');
    await clickEl('[data-testid="thread-panel-close"]');
    await delay(300);
  } catch (e) {
    console.log('  [WARN] Thread: ' + e.message);
    await cdpScreenshot('morning-09-thread');
  }

  // 10. Light theme
  console.log('10. Light theme...');
  await clickEl('[data-testid="theme-toggle"]');
  await delay(500);
  await cdpScreenshot('morning-10-light');
  // Switch back to dark
  await clickEl('[data-testid="theme-toggle"]');
  await delay(300);

  // 11. Mobile viewport (480px)
  console.log('11. Mobile viewport...');
  await page.setViewportSize({ width: 480, height: 900 });
  await delay(500);
  await cdpScreenshot('morning-11-mobile');
  // Reset viewport
  await page.setViewportSize({ width: 1440, height: 900 });
  await delay(300);

  // 12. Messages with emoji reactions
  console.log('12. Emoji reactions...');
  // Hover first message, click React, pick an emoji
  try {
    await page.locator('.bubble').first().hover({ timeout: 5000 });
    await delay(300);
    await clickEl('[data-testid="action-react"]');
    await delay(500);
    // Click first emoji in picker
    await clickEl('[data-testid="emoji-item"]');
    await delay(500);

    // Add reaction to second message too
    const secondBubble = page.locator('.bubble').nth(1);
    await secondBubble.hover({ timeout: 5000 });
    await delay(300);
    await clickEl('[data-testid="action-react"]');
    await delay(500);
    // Click a different emoji - try second one
    await ce(`document.querySelectorAll('[data-testid="emoji-item"]')[3]?.click()`);
    await delay(500);

    await cdpScreenshot('morning-12-reactions');
  } catch (e) {
    console.log('  [WARN] Reactions: ' + e.message);
    await cdpScreenshot('morning-12-reactions');
  }

  console.log('\nAll screenshots complete!');
  await browser.close();
})();
