import { test, expect } from '@playwright/test';

test.describe('Keyboard shortcuts and accessibility', () => {

  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The app may take a while to render -- wait for message input
    await expect(page.locator('[data-testid="message-input"]')).toBeAttached({ timeout: 30000 });
  });

  // ── Test 1: Ctrl+K opens search panel ──
  test('Ctrl+K opens search panel', async ({ page }) => {
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-ctrlk.png' });
  });

  // ── Test 2: Escape closes the topmost panel ──
  test('Escape closes topmost open panel', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible({ timeout: 5000 });
  });

  // ── Test 3: Escape priority ──
  test('Escape closes panels in priority order', async ({ page }) => {
    // Open pinned panel first
    await page.locator('[data-testid="header-pin-btn"]').click();
    await expect(page.locator('[data-testid="pinned-panel"]')).toBeVisible({ timeout: 5000 });

    // Open search panel second
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    // Both open. First Escape: pinned has higher priority, should close first
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="pinned-panel"]')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible();

    // Second Escape: closes search
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible({ timeout: 5000 });
  });

  // ── Test 4: Enter sends message ──
  test('Enter in message input sends message', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.focus();
    await input.fill('Hello from keyboard test');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('', { timeout: 5000 });
  });

  // ── Test 5: Shift+Enter does NOT send ──
  test('Shift+Enter does not send message', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.focus();
    await input.fill('Should not be sent');
    await page.keyboard.press('Shift+Enter');
    await expect(input).toHaveValue('Should not be sent', { timeout: 3000 });
  });

  // ── Test 6: Tab navigation ──
  test('Tab navigation moves focus through interactive elements', async ({ page }) => {
    await page.locator('body').focus();

    const focusedTags = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const tag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase() || 'none');
      focusedTags.push(tag);
    }

    const interactive = focusedTags.filter(t => ['button', 'input', 'a', 'select', 'textarea'].includes(t));
    expect(interactive.length).toBeGreaterThan(0);
    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-tab-nav.png' });
  });

  // ── Test 7: Focus visible ──
  test('Focused elements have visible focus ring', async ({ page }) => {
    const searchBtn = page.locator('[data-testid="header-search-btn"]');
    await searchBtn.focus();

    const hasFocusStyle = await searchBtn.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return computed.boxShadow && computed.boxShadow !== 'none';
    });
    expect(hasFocusStyle).toBe(true);
    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-focus-ring.png' });
  });

  // ── Test 8: Enter on focused button ──
  test('Enter on focused button activates it', async ({ page }) => {
    const searchBtn = page.locator('[data-testid="header-search-btn"]');
    await searchBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });
  });

  // ── Test 9: Ctrl+K while typing ──
  test('Ctrl+K while typing opens search without inserting k', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.click();
    await input.fill('hello');
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });
    await expect(input).toHaveValue('hello');
    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-ctrlk-typing.png' });
  });

  // ── Test 10: Focus returns after Escape ──
  test('After Escape closes panel, focus returns to message input', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible({ timeout: 5000 });

    // Wait for focus restoration (setTimeout in handler)
    await expect(page.locator('[data-testid="message-input"]')).toBeFocused({ timeout: 3000 });
    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-focus-return.png' });
  });

});
