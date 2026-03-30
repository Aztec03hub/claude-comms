import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

test.describe('Keyboard shortcuts and accessibility', () => {

  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="message-input"]')).toBeVisible({ timeout: 30000 });
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
    // Open search via Ctrl+K
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });
    // Press Escape to close it
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible({ timeout: 5000 });
  });

  // ── Test 3: Escape priority — modal > context menu > emoji picker > profile card > pinned > search > thread ──
  test('Escape closes panels in priority order', async ({ page }) => {
    // Open pinned panel first (via click)
    await page.click('[data-testid="header-pin-btn"]');
    await expect(page.locator('[data-testid="pinned-panel"]')).toBeVisible({ timeout: 5000 });

    // Open search panel second (via Ctrl+K)
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    // Both panels are open. Pinned has higher Escape priority than search.
    // First Escape should close pinned (higher priority)
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="pinned-panel"]')).not.toBeVisible({ timeout: 5000 });
    // Search should still be open
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible();

    // Second Escape closes search
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible({ timeout: 5000 });
  });

  // ── Test 4: Enter in message input sends message ──
  test('Enter in message input sends message', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.click();
    await input.fill('Hello from keyboard test');
    await page.keyboard.press('Enter');
    // Input should be cleared after send
    await expect(input).toHaveValue('', { timeout: 5000 });
  });

  // ── Test 5: Shift+Enter does NOT send ──
  test('Shift+Enter does not send message', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.click();
    await input.fill('Should not be sent');
    await page.keyboard.press('Shift+Enter');
    // Input should still have the text (message was NOT sent)
    await expect(input).toHaveValue('Should not be sent', { timeout: 3000 });
  });

  // ── Test 6: Tab navigation moves through interactive elements ──
  test('Tab navigation moves focus through interactive elements', async ({ page }) => {
    // Start by clicking in the body to reset focus
    await page.click('body');

    // Press Tab multiple times and verify focus moves
    const focusedTags = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      const tag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase() || 'none');
      const testid = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') || '');
      focusedTags.push({ tag, testid });
    }

    // Verify at least some of the focused elements are interactive (buttons, inputs, links)
    const interactiveTags = focusedTags.filter(f => ['button', 'input', 'a', 'select', 'textarea'].includes(f.tag));
    expect(interactiveTags.length).toBeGreaterThan(0);

    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-tab-nav.png' });
  });

  // ── Test 7: Focus visible — focused elements have visible focus ring ──
  test('Focused elements have visible focus ring', async ({ page }) => {
    // Focus the search button via Tab
    const searchBtn = page.locator('[data-testid="header-search-btn"]');
    await searchBtn.focus();

    // Check that the focused element has a box-shadow (our focus-ring style)
    const hasFocusStyle = await searchBtn.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      const boxShadow = computed.boxShadow;
      return boxShadow && boxShadow !== 'none';
    });

    expect(hasFocusStyle).toBe(true);
    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-focus-ring.png' });
  });

  // ── Test 8: Enter on focused button activates it ──
  test('Enter on focused button activates it', async ({ page }) => {
    // Focus the search button and press Enter
    const searchBtn = page.locator('[data-testid="header-search-btn"]');
    await searchBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });
  });

  // ── Test 9: Ctrl+K while typing should open search (not type 'k') ──
  test('Ctrl+K while typing opens search without inserting k', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.click();
    await input.fill('hello');

    // Press Ctrl+K — should open search panel, not insert 'k'
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });
    // Input value should still be 'hello' (no 'k' appended)
    await expect(input).toHaveValue('hello');

    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-ctrlk-typing.png' });
  });

  // ── Test 10: After Escape closes panel, focus returns to a sensible element ──
  test('After Escape closes panel, focus returns to message input', async ({ page }) => {
    // Open search
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    // Press Escape
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible({ timeout: 5000 });

    // Wait for focus to be restored (setTimeout in App.svelte)
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'message-input',
      { timeout: 3000 }
    );

    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-keyboard-focus-return.png' });
  });

});
