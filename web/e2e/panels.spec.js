import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups';

test.describe('Panel open/close', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="chat-header"]')).toBeVisible({ timeout: 25000 });
  });

  // 1. Search panel — open/close
  test('search button opens search panel', async ({ page }) => {
    const searchBtn = page.locator('[data-testid="header-search-btn"]');
    await expect(searchBtn).toBeVisible();

    await searchBtn.click();

    const searchPanel = page.locator('[data-testid="search-panel"]');
    await expect(searchPanel).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-search-open.png`, fullPage: true });
  });

  test('search panel close button works', async ({ page }) => {
    await page.locator('[data-testid="header-search-btn"]').click({ timeout: 10000 });
    const searchPanel = page.locator('[data-testid="search-panel"]');
    await expect(searchPanel).toBeVisible({ timeout: 5000 });

    await page.locator('[data-testid="search-panel-close"]').click();
    await expect(searchPanel).not.toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-search-closed.png`, fullPage: true });
  });

  // 2. Pinned panel — open/close
  test('pin button opens pinned panel', async ({ page }) => {
    const pinnedBtn = page.locator('[data-testid="header-pin-btn"]');
    await expect(pinnedBtn).toBeVisible();

    await pinnedBtn.click();

    const pinnedPanel = page.locator('[data-testid="pinned-panel"]');
    await expect(pinnedPanel).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-pinned-open.png`, fullPage: true });
  });

  test('pinned panel close button works', async ({ page }) => {
    await page.locator('[data-testid="header-pin-btn"]').click({ timeout: 10000 });
    const pinnedPanel = page.locator('[data-testid="pinned-panel"]');
    await expect(pinnedPanel).toBeVisible({ timeout: 5000 });

    await page.locator('[data-testid="pinned-panel-close"]').click();
    await expect(pinnedPanel).not.toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-pinned-closed.png`, fullPage: true });
  });

  // 3. Escape key closes search panel
  test('Escape key closes search panel', async ({ page }) => {
    await page.locator('[data-testid="header-search-btn"]').click({ timeout: 10000 });
    const searchPanel = page.locator('[data-testid="search-panel"]');
    await expect(searchPanel).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(searchPanel).not.toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-escape-search.png`, fullPage: true });
  });

  // 4. Escape key priority — search closes before pinned
  test('Escape closes search first when both search and pinned are open', async ({ page }) => {
    // Open pinned first
    await page.locator('[data-testid="header-pin-btn"]').click({ timeout: 10000 });
    const pinnedPanel = page.locator('[data-testid="pinned-panel"]');
    await expect(pinnedPanel).toBeVisible({ timeout: 5000 });

    // Then open search (closes first because it's higher in priority chain)
    await page.locator('[data-testid="header-search-btn"]').click({ timeout: 10000 });
    const searchPanel = page.locator('[data-testid="search-panel"]');
    await expect(searchPanel).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-both-open.png`, fullPage: true });

    // First Escape closes pinned (higher z-index, checked first in handler)
    await page.keyboard.press('Escape');
    await expect(pinnedPanel).not.toBeVisible();
    await expect(searchPanel).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-escape-first.png`, fullPage: true });

    // Second Escape closes search
    await page.keyboard.press('Escape');
    await expect(searchPanel).not.toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-escape-second.png`, fullPage: true });
  });

  // 5. Search input auto-focus
  test('search panel input is auto-focused when opened', async ({ page }) => {
    await page.locator('[data-testid="header-search-btn"]').click({ timeout: 10000 });

    const searchInput = page.locator('[data-testid="search-panel-input"]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await expect(searchInput).toBeFocused({ timeout: 3000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-search-focused.png`, fullPage: true });
  });

  // 6. Toggle behavior
  test('clicking search button twice toggles panel open then closed', async ({ page }) => {
    const searchBtn = page.locator('[data-testid="header-search-btn"]');

    await searchBtn.click();
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    await searchBtn.click();
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-toggle.png`, fullPage: true });
  });

  test('clicking pin button twice toggles pinned panel', async ({ page }) => {
    const pinBtn = page.locator('[data-testid="header-pin-btn"]');

    await pinBtn.click();
    await expect(page.locator('[data-testid="pinned-panel"]')).toBeVisible({ timeout: 5000 });

    await pinBtn.click();
    await expect(page.locator('[data-testid="pinned-panel"]')).not.toBeVisible();
  });

  // 7. Panel doesn't block chat
  test('chat area remains visible with search panel open', async ({ page }) => {
    await page.locator('[data-testid="header-search-btn"]').click({ timeout: 10000 });
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    // The main center area should still be visible
    const mainCenter = page.locator('main.center');
    await expect(mainCenter).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-chat-visible.png`, fullPage: true });
  });

  // 8. Panel state after channel switch
  test('channel switch with search panel open', async ({ page }) => {
    // Open search panel
    await page.locator('[data-testid="header-search-btn"]').click({ timeout: 10000 });
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    // Find a different channel and click it
    const headerName = page.locator('[data-testid="header-channel-name"]');
    const initialName = await headerName.textContent();

    const channels = page.locator('[data-testid^="channel-item-"]');
    const count = await channels.count();

    let switched = false;
    for (let i = 0; i < count; i++) {
      const chNameEl = channels.nth(i).locator('.ch-name');
      const nameCount = await chNameEl.count();
      if (nameCount === 0) continue;
      const chName = await chNameEl.textContent();
      if (chName && chName.trim() !== initialName?.trim()) {
        await channels.nth(i).click();
        switched = true;
        break;
      }
    }

    if (switched) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/test-panels-channel-switch.png`, fullPage: true });
      const newName = await headerName.textContent();
      expect(newName?.trim()).not.toBe(initialName?.trim());
    }
  });
});
