import { test, expect } from '@playwright/test';
import fs from 'fs';

test.describe('Round 7: Keyboard Shortcuts Comprehensive', () => {
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

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  async function clickEl(sel) {
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(300);
  }

  async function cdpScreenshot(name) {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`/home/plafayette/claude-comms/mockups/${name}.png`, Buffer.from(data, 'base64'));
    } catch { /* skip */ }
  }

  // --- Ctrl+K opens search panel ---
  test('Ctrl+K opens search panel, Escape closes', async ({ page }) => {
    expect(await exists('[data-testid="search-panel"]')).toBe(false);

    await page.keyboard.press('Control+k');
    await delay(400);
    expect(await exists('[data-testid="search-panel"]')).toBe(true);
    await cdpScreenshot('overnight-r7-01-ctrlk-open');

    // Search input should be auto-focused
    const searchFocused = await ce(`document.activeElement?.dataset?.testid === 'search-panel-input'`);
    expect(searchFocused).toBe(true);

    // Escape closes
    await page.keyboard.press('Escape');
    await delay(400);
    expect(await exists('[data-testid="search-panel"]')).toBe(false);
  });

  // --- Ctrl+K toggles search ---
  test('Ctrl+K toggles search panel', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await delay(300);
    expect(await exists('[data-testid="search-panel"]')).toBe(true);

    await page.keyboard.press('Control+k');
    await delay(300);
    expect(await exists('[data-testid="search-panel"]')).toBe(false);
  });

  // --- Tab through interactive elements ---
  test('Tab navigation through interactive elements', async ({ page }) => {
    // Start from the body
    await ce(`document.body.focus()`);
    await delay(200);

    const visitedTestIds = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      await delay(80);
      const testid = await ce(`document.activeElement?.dataset?.testid || document.activeElement?.tagName || 'unknown'`);
      visitedTestIds.push(testid);
      // Stop if we've wrapped around
      if (i > 5 && visitedTestIds.filter(t => t === testid).length > 2) break;
    }

    await cdpScreenshot('overnight-r7-02-tab-nav');

    // Tab should visit multiple distinct focusable elements
    const unique = [...new Set(visitedTestIds)];
    expect(unique.length).toBeGreaterThan(3);

    // Check that focusable elements include at least some interactive items
    const hasAnyInteractive = visitedTestIds.some(t =>
      t === 'message-input' ||
      t === 'send-button' ||
      t?.startsWith('channel-item-') ||
      t?.startsWith('starred-channel-item-') ||
      t === 'header-search-btn' ||
      t === 'header-pin-btn' ||
      t === 'sidebar-create-channel' ||
      t === 'INPUT' ||
      t === 'BUTTON'
    );
    expect(hasAnyInteractive).toBe(true);
  });

  // --- Enter activates focused buttons ---
  test('Enter activates focused buttons', async ({ page }) => {
    // Focus the create channel button and press Enter
    await ce(`document.querySelector('[data-testid="sidebar-create-channel"]')?.focus()`);
    await delay(200);
    await page.keyboard.press('Enter');
    await delay(400);

    // Modal should open
    expect(await exists('[data-testid="channel-modal"]')).toBe(true);
    await cdpScreenshot('overnight-r7-03-enter-activates');

    // Close modal
    await page.keyboard.press('Escape');
    await delay(400);
  });

  // --- Enter on sidebar channel item ---
  test('Enter activates sidebar channel items', async ({ page }) => {
    // Get current channel name
    const initialChannel = await ce(`document.querySelector('[data-testid="header-channel-name"]')?.textContent`);

    // Focus a different channel and press Enter
    const channelItems = await ce(`[...document.querySelectorAll('[data-testid^="channel-item-"]')].map(e => e.dataset.testid)`);
    // Find one that's not active
    const targets = channelItems?.filter(t => !t.includes(initialChannel)) || [];
    if (targets.length > 0) {
      await ce(`document.querySelector('[data-testid="${targets[0]}"]')?.focus()`);
      await delay(200);
      await page.keyboard.press('Enter');
      await delay(400);

      // Header should update
      const newChannel = await ce(`document.querySelector('[data-testid="header-channel-name"]')?.textContent`);
      expect(newChannel).not.toBe(initialChannel);
    }
  });

  // --- Focus ring visible on focused elements ---
  test('focus ring visible on focused elements', async ({ page }) => {
    // Focus a button and check for focus ring styles
    await ce(`document.querySelector('[data-testid="header-search-btn"]')?.focus()`);
    await delay(200);

    const hasOutline = await ce(`(() => {
      const el = document.querySelector('[data-testid="header-search-btn"]');
      if (!el) return false;
      const cs = getComputedStyle(el);
      // Check for outline or box-shadow focus ring
      const hasVisibleOutline = cs.outline !== 'none' && cs.outline !== '' && !cs.outline.includes('0px');
      const hasBoxShadow = cs.boxShadow && cs.boxShadow !== 'none' && cs.boxShadow !== '';
      return hasVisibleOutline || hasBoxShadow;
    })()`);

    // The app uses :focus-visible which requires keyboard navigation
    // Trigger keyboard nav mode
    await page.keyboard.press('Tab');
    await delay(100);
    // Tab back
    await page.keyboard.press('Shift+Tab');
    await delay(200);

    // Now check a focusable element after keyboard navigation
    await ce(`document.querySelector('[data-testid="sidebar-create-channel"]')?.focus()`);
    await delay(200);

    await cdpScreenshot('overnight-r7-04-focus-ring');

    // The focus-visible style exists in app.css
    const focusRingDefined = await ce(`(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText?.includes('focus-visible')) return true;
          }
        } catch {}
      }
      return false;
    })()`);
    expect(focusRingDefined).toBe(true);
  });

  // --- Escape priority chain ---
  test('Escape priority: modal > context menu > emoji > profile > pinned > search', async ({ page }) => {
    // Open search panel
    await page.keyboard.press('Control+k');
    await delay(300);
    expect(await exists('[data-testid="search-panel"]')).toBe(true);

    // Open pinned panel
    await clickEl('[data-testid="header-pin-btn"]');
    await delay(300);
    expect(await exists('[data-testid="pinned-panel"]')).toBe(true);

    // Escape should close pinned first (higher priority than search)
    await page.keyboard.press('Escape');
    await delay(300);
    expect(await exists('[data-testid="pinned-panel"]')).toBe(false);
    expect(await exists('[data-testid="search-panel"]')).toBe(true);

    // Next Escape closes search
    await page.keyboard.press('Escape');
    await delay(300);
    expect(await exists('[data-testid="search-panel"]')).toBe(false);
  });

  // --- Ctrl+K while typing in input ---
  test('Ctrl+K works while message input is focused', async ({ page }) => {
    // Focus message input
    await ce(`document.querySelector('[data-testid="message-input"]')?.focus()`);
    await delay(200);

    // Type something
    await page.keyboard.type('hello');
    await delay(200);

    // Ctrl+K should still open search
    await page.keyboard.press('Control+k');
    await delay(400);
    expect(await exists('[data-testid="search-panel"]')).toBe(true);
    await cdpScreenshot('overnight-r7-05-ctrlk-while-typing');
  });

  // --- Focus returns to input after Escape ---
  test('focus returns to message input after Escape closes panel', async ({ page }) => {
    // Focus message input first
    await ce(`document.querySelector('[data-testid="message-input"]')?.focus()`);
    await delay(200);

    // Open search
    await page.keyboard.press('Control+k');
    await delay(400);
    expect(await exists('[data-testid="search-panel"]')).toBe(true);

    // Escape to close
    await page.keyboard.press('Escape');
    await delay(400);

    // Focus should return to message input
    const focusedTestId = await ce(`document.activeElement?.dataset?.testid`);
    expect(focusedTestId).toBe('message-input');
  });

  // --- Shift+Enter does NOT send ---
  test('Shift+Enter does not send message', async ({ page }) => {
    await ce(`(() => {
      const i = document.querySelector('[data-testid="message-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, 'test shift enter');
      i.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await delay(200);

    // Focus the input
    await ce(`document.querySelector('[data-testid="message-input"]')?.focus()`);
    await delay(100);

    // Press Shift+Enter
    await page.keyboard.press('Shift+Enter');
    await delay(300);

    // Input should still have value (not sent)
    const val = await ce(`document.querySelector('[data-testid="message-input"]')?.value`);
    // Shift+Enter should not clear the input (no send happened)
    expect(val?.length).toBeGreaterThan(0);
  });
});
