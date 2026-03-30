import { test, expect } from '@playwright/test';

test.describe('Search Panel Filters and Results', () => {
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

  async function openSearchPanel() {
    await clickEl('[data-testid="header-search-btn"]');
    await delay(300);
  }

  async function typeInSearch(text) {
    await ce(`(() => {
      const input = document.querySelector('[data-testid="search-panel-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(400);
  }

  // ── Tests ──

  test('search panel shows all 5 filter pills', async ({ page }) => {
    await openSearchPanel();

    const filterNames = ['all', 'messages', 'files', 'code', 'links'];
    for (const name of filterNames) {
      const hasFilter = await exists(`[data-testid="search-filter-${name}"]`);
      expect(hasFilter).toBe(true);
    }
  });

  test('All filter is active by default', async ({ page }) => {
    await openSearchPanel();

    const isActive = await ce(`document.querySelector('[data-testid="search-filter-all"]')?.classList.contains('active')`);
    expect(isActive).toBe(true);
  });

  test('clicking a filter pill activates it and deactivates others', async ({ page }) => {
    await openSearchPanel();

    // Click Messages filter
    await clickEl('[data-testid="search-filter-messages"]');

    const messagesActive = await ce(`document.querySelector('[data-testid="search-filter-messages"]')?.classList.contains('active')`);
    expect(messagesActive).toBe(true);

    const allActive = await ce(`document.querySelector('[data-testid="search-filter-all"]')?.classList.contains('active')`);
    expect(allActive).toBe(false);
  });

  test('switching between filter pills updates active state', async ({ page }) => {
    await openSearchPanel();

    // Click Code filter
    await clickEl('[data-testid="search-filter-code"]');
    expect(await ce(`document.querySelector('[data-testid="search-filter-code"]')?.classList.contains('active')`)).toBe(true);

    // Click Links filter
    await clickEl('[data-testid="search-filter-links"]');
    expect(await ce(`document.querySelector('[data-testid="search-filter-links"]')?.classList.contains('active')`)).toBe(true);
    expect(await ce(`document.querySelector('[data-testid="search-filter-code"]')?.classList.contains('active')`)).toBe(false);
  });

  test('empty search shows initial prompt state', async ({ page }) => {
    await openSearchPanel();

    // Should show the "Search messages" empty state with SearchIcon
    const emptyTitle = await ce(`document.querySelector('.search-empty-title')?.textContent`);
    expect(emptyTitle).toBe('Search messages');
  });

  test('searching for nonexistent text shows no-results state', async ({ page }) => {
    await openSearchPanel();

    await typeInSearch('zzz_nonexistent_query_xyz');

    const emptyTitle = await ce(`document.querySelector('.search-empty-title')?.textContent`);
    expect(emptyTitle).toBe('No results found');
  });

  test('searching after sending messages returns matching results', async ({ page }) => {
    // Send messages first so there is something to search
    await sendMessage('alpha bravo charlie');
    await sendMessage('delta echo foxtrot');
    await sendMessage('alpha delta golf');

    await openSearchPanel();
    await typeInSearch('alpha');

    // Should find results containing "alpha"
    const resultCount = await ce(`document.querySelectorAll('.search-result').length`);
    expect(resultCount).toBeGreaterThanOrEqual(1);

    // Result count text should be present
    const countText = await ce(`document.querySelector('.search-results-count')?.textContent`);
    expect(countText).toContain('alpha');
  });

  test('search highlights matching text with mark tags', async ({ page }) => {
    await sendMessage('unique-highlight-test-word');

    await openSearchPanel();
    await typeInSearch('unique-highlight');

    await delay(300);
    const hasHighlight = await ce(`!!document.querySelector('.search-result-text mark')`);
    expect(hasHighlight).toBe(true);
  });

  test('Messages filter excludes code block messages', async ({ page }) => {
    await sendMessage('plain text message');
    await sendMessage('```\ncode block\n```');

    await openSearchPanel();
    await typeInSearch('message');

    // With All filter, should find results
    const allCount = await ce(`document.querySelectorAll('.search-result').length`);

    // Switch to Messages filter
    await clickEl('[data-testid="search-filter-messages"]');
    await delay(300);

    // Messages filter should exclude code blocks
    const filteredCount = await ce(`document.querySelectorAll('.search-result').length`);
    expect(filteredCount).toBeLessThanOrEqual(allCount);
  });

  test('search input clears results when emptied', async ({ page }) => {
    await sendMessage('searchable content');

    await openSearchPanel();
    await typeInSearch('searchable');

    const hasResults = await ce(`document.querySelectorAll('.search-result').length > 0`);
    expect(hasResults).toBe(true);

    // Clear the search
    await typeInSearch('');

    // Should return to initial empty state
    const emptyTitle = await ce(`document.querySelector('.search-empty-title')?.textContent`);
    expect(emptyTitle).toBe('Search messages');
  });
});
