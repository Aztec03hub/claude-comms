import { test, expect } from '@playwright/test';

test.describe('Settings Panel', () => {
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

  async function clickEl(sel) {
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(300);
  }

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  // ── Tests ──

  test('header settings button opens settings panel', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');
    const visible = await exists('[data-testid="settings-panel"]');
    expect(visible).toBe(true);
  });

  test('settings panel close button dismisses panel', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');
    expect(await exists('[data-testid="settings-panel"]')).toBe(true);

    await clickEl('[data-testid="settings-panel-close"]');
    await delay(400);
    expect(await exists('[data-testid="settings-panel"]')).toBe(false);
  });

  test('Escape key closes settings panel', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');
    expect(await exists('[data-testid="settings-panel"]')).toBe(true);

    await page.keyboard.press('Escape');
    await delay(400);
    expect(await exists('[data-testid="settings-panel"]')).toBe(false);
  });

  test('settings button toggles panel open and closed', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');
    expect(await exists('[data-testid="settings-panel"]')).toBe(true);

    await clickEl('[data-testid="header-settings-btn"]');
    await delay(400);
    expect(await exists('[data-testid="settings-panel"]')).toBe(false);
  });

  test('settings panel displays Profile section with display name input', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');
    expect(await exists('[data-testid="settings-panel"]')).toBe(true);

    // Check that display name input exists and has a value
    const hasNameInput = await ce(`!!document.querySelector('#settings-display-name')`);
    expect(hasNameInput).toBe(true);

    const nameValue = await ce(`document.querySelector('#settings-display-name')?.value`);
    expect(nameValue).toBeTruthy();
  });

  test('editing display name updates value and persists to localStorage', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');

    // Clear and type a new name
    await ce(`(() => {
      const input = document.querySelector('#settings-display-name');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'TestUser42');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(300);

    const updatedValue = await ce(`document.querySelector('#settings-display-name')?.value`);
    expect(updatedValue).toBe('TestUser42');

    // Verify localStorage persistence
    const storedName = await ce(`localStorage.getItem('claude-comms-user-name')`);
    expect(storedName).toBe('TestUser42');
  });

  test('display name enforces max length of 50 characters', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');

    const longName = 'A'.repeat(60);
    await ce(`(() => {
      const input = document.querySelector('#settings-display-name');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(longName)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(300);

    const finalValue = await ce(`document.querySelector('#settings-display-name')?.value`);
    expect(finalValue.length).toBeLessThanOrEqual(50);
  });

  test('settings panel shows Notifications toggles', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');

    // Check for in-app toasts toggle (role="switch")
    const switchCount = await ce(`document.querySelectorAll('[data-testid="settings-panel"] [role="switch"]').length`);
    expect(switchCount).toBeGreaterThanOrEqual(2);
  });

  test('in-app toasts toggle changes state on click', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');

    // Find the in-app toasts toggle (second switch, labeled "Toggle in-app toasts")
    const initialState = await ce(`document.querySelector('[aria-label="Toggle in-app toasts"]')?.getAttribute('aria-checked')`);

    await clickEl('[aria-label="Toggle in-app toasts"]');
    await delay(200);

    const newState = await ce(`document.querySelector('[aria-label="Toggle in-app toasts"]')?.getAttribute('aria-checked')`);
    expect(newState).not.toBe(initialState);
  });

  test('dark mode toggle in settings matches header theme toggle', async ({ page }) => {
    await clickEl('[data-testid="header-settings-btn"]');

    // Get initial dark mode state
    const initialDarkState = await ce(`document.querySelector('[aria-label="Toggle dark mode"]')?.getAttribute('aria-checked')`);
    expect(initialDarkState).toBe('true'); // Default is dark

    // Toggle it off
    await clickEl('[aria-label="Toggle dark mode"]');
    await delay(300);

    // Verify theme attribute changed on document
    const themeAttr = await ce(`document.documentElement.getAttribute('data-theme')`);
    expect(themeAttr).toBe('light');
  });
});
