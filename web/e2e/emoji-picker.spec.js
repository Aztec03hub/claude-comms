import { test, expect } from '@playwright/test';

test.describe('Emoji Picker & Reaction System', () => {

  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    // Block Google Fonts to prevent screenshot/rendering hangs
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Wait for message input to appear
    await page.locator('[data-testid="message-input"]').waitFor({ state: 'attached', timeout: 20000 });
    await page.waitForTimeout(2000);
  });

  // Use evaluate-based helpers to avoid Playwright actionability timeouts
  // caused by MQTT reconnection flooding the event loop
  async function clickEl(page, selector) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, selector);
    await page.waitForTimeout(200);
  }

  async function typeInInput(page, text) {
    await page.evaluate((t) => {
      const input = document.querySelector('[data-testid="message-input"]');
      if (!input) return;
      input.focus();
      // Set native value to trigger Svelte's bind:value
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeInputValueSetter.call(input, t);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.waitForTimeout(100);
  }

  async function sendMessage(page, text) {
    await typeInInput(page, text);
    // Send via Enter keydown
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="message-input"]');
      if (!input) return;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await page.waitForTimeout(800);
  }

  async function screenshot(page, name) {
    try {
      await page.screenshot({ path: `/home/plafayette/claude-comms/mockups/${name}.png`, timeout: 5000 });
    } catch {
      // Font loading may hang — skip screenshot if it times out
    }
  }

  async function countElements(page, selector) {
    return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
  }

  async function isAttached(page, selector) {
    return page.evaluate((sel) => !!document.querySelector(sel), selector);
  }

  async function hasClass(page, selector, cls) {
    return page.evaluate(([sel, c]) => {
      const el = document.querySelector(sel);
      return el ? el.classList.contains(c) : false;
    }, [selector, cls]);
  }

  async function hoverEl(page, selector) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    }, selector);
    await page.waitForTimeout(300);
  }

  test('1. Send 2 messages to create bubbles', async ({ page }) => {
    await sendMessage(page, 'Hello from test message one');
    await sendMessage(page, 'Second test message for reactions');

    const count = await countElements(page, '.bubble');
    expect(count).toBe(2);

    await screenshot(page, 'test-emoji-01-messages');
  });

  test('2. Hover message shows action bar', async ({ page }) => {
    await sendMessage(page, 'Hover test message');

    // Verify message row exists (not date separator)
    const msgRowCount = await countElements(page, '.msg-row:not(.system)');
    expect(msgRowCount).toBeGreaterThanOrEqual(1);

    // Hover the message row - CSS :hover reveals action bar
    // We need to use Playwright's real hover for CSS :hover to work
    const msgRow = page.locator('.msg-row:not(.system)').first();
    await msgRow.hover({ force: true, timeout: 10000 });
    await page.waitForTimeout(500);

    // Check actions bar is visible
    const opacity = await page.evaluate(() => {
      const row = document.querySelector('.msg-row:not(.system)');
      const actions = row?.querySelector('.msg-actions');
      return actions ? getComputedStyle(actions).opacity : 'not found';
    });
    expect(opacity).toBe('1');

    // Check 3 action buttons
    const btnCount = await page.evaluate(() => {
      const row = document.querySelector('.msg-row:not(.system)');
      return row?.querySelectorAll('.msg-action-btn')?.length || 0;
    });
    expect(btnCount).toBe(3);

    await screenshot(page, 'test-emoji-02-action-bar');
  });

  test('3. Click React button opens emoji picker', async ({ page }) => {
    await sendMessage(page, 'React button test');

    // Click the react button
    await clickEl(page, '[data-testid="action-react"]');
    await page.waitForTimeout(500);

    const pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(true);

    await screenshot(page, 'test-emoji-03-picker-from-react');
  });

  test('4. Emoji picker has content: search, categories, grid', async ({ page }) => {
    await clickEl(page, '[data-testid="input-emoji"]');
    await page.waitForTimeout(500);

    const pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(true);

    // Search input
    const searchExists = await isAttached(page, '[data-testid="emoji-search"]');
    expect(searchExists).toBe(true);

    // Category tabs (8 defined)
    const catCount = await countElements(page, '[data-testid^="emoji-category-"]');
    expect(catCount).toBe(8);

    // Emoji grid items (16 frequent emojis)
    const itemCount = await countElements(page, '[data-testid="emoji-item"]');
    expect(itemCount).toBe(16);

    await screenshot(page, 'test-emoji-04-picker-content');
  });

  test('5. Click emoji adds reaction and closes picker', async ({ page }) => {
    await sendMessage(page, 'Reaction target message');

    // Open picker via react button
    await clickEl(page, '[data-testid="action-react"]');
    await page.waitForTimeout(500);

    // Click first emoji
    await clickEl(page, '[data-testid="emoji-item"]');
    await page.waitForTimeout(500);

    // Picker should close
    const pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(false);

    // Reaction should appear on the message
    const reactionExists = await isAttached(page, '.reaction .emoji');
    expect(reactionExists).toBe(true);

    await screenshot(page, 'test-emoji-05-reaction-added');
  });

  test('6. Input area emoji button opens picker', async ({ page }) => {
    await clickEl(page, '[data-testid="input-emoji"]');
    await page.waitForTimeout(500);

    const pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(true);

    await screenshot(page, 'test-emoji-06-input-emoji-btn');
  });

  test('7. Click outside picker closes it', async ({ page }) => {
    await clickEl(page, '[data-testid="input-emoji"]');
    await page.waitForTimeout(500);

    let pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(true);

    // Click backdrop (the emoji-backdrop div)
    await page.evaluate(() => {
      const backdrop = document.querySelector('.emoji-backdrop');
      if (backdrop) {
        // Need to click the backdrop itself, not a child — handleBackdropClick checks e.target === e.currentTarget
        const event = new MouseEvent('click', { bubbles: false });
        Object.defineProperty(event, 'target', { value: backdrop });
        Object.defineProperty(event, 'currentTarget', { value: backdrop });
        backdrop.dispatchEvent(event);
      }
    });
    await page.waitForTimeout(500);

    pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(false);

    await screenshot(page, 'test-emoji-07-click-outside');
  });

  test('8. Escape closes picker', async ({ page }) => {
    await clickEl(page, '[data-testid="input-emoji"]');
    await page.waitForTimeout(500);

    let pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(true);

    // Dispatch Escape key event
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForTimeout(500);

    pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(false);

    await screenshot(page, 'test-emoji-08-escape-close');
  });

  test('9. Emoji search does not crash', async ({ page }) => {
    await clickEl(page, '[data-testid="input-emoji"]');
    await page.waitForTimeout(500);

    // Type into search via evaluate
    await page.evaluate(() => {
      const search = document.querySelector('[data-testid="emoji-search"]');
      if (!search) return;
      search.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(search, 'fire');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(500);

    // Picker should still be visible
    const pickerExists = await isAttached(page, '[data-testid="emoji-picker"]');
    expect(pickerExists).toBe(true);

    await screenshot(page, 'test-emoji-09-search');
  });

  test('10. Category tabs change active state', async ({ page }) => {
    await clickEl(page, '[data-testid="input-emoji"]');
    await page.waitForTimeout(500);

    // Default: frequent should be active
    let frequentActive = await hasClass(page, '[data-testid="emoji-category-frequent"]', 'active');
    expect(frequentActive).toBe(true);

    // Click smileys
    await clickEl(page, '[data-testid="emoji-category-smileys"]');
    await page.waitForTimeout(300);

    let smileysActive = await hasClass(page, '[data-testid="emoji-category-smileys"]', 'active');
    frequentActive = await hasClass(page, '[data-testid="emoji-category-frequent"]', 'active');
    expect(smileysActive).toBe(true);
    expect(frequentActive).toBe(false);

    // Click nature
    await clickEl(page, '[data-testid="emoji-category-nature"]');
    await page.waitForTimeout(300);

    let natureActive = await hasClass(page, '[data-testid="emoji-category-nature"]', 'active');
    smileysActive = await hasClass(page, '[data-testid="emoji-category-smileys"]', 'active');
    expect(natureActive).toBe(true);
    expect(smileysActive).toBe(false);

    await screenshot(page, 'test-emoji-10-category-tabs');
  });
});
