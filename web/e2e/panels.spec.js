import { test, expect } from '@playwright/test';

test.describe('Panel open/close', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="chat-header"]');
  });

  test('search button in header opens search panel', async ({ page }) => {
    const searchBtn = page.locator('[data-testid="header-search-btn"]');
    await expect(searchBtn).toBeVisible();

    await searchBtn.click();

    const searchPanel = page.locator('[data-testid="search-panel"]');
    await expect(searchPanel).toBeVisible();
  });

  test('search panel close button works', async ({ page }) => {
    // Open search panel
    await page.locator('[data-testid="header-search-btn"]').click();
    const searchPanel = page.locator('[data-testid="search-panel"]');
    await expect(searchPanel).toBeVisible();

    // Close it
    const closeBtn = page.locator('[data-testid="search-panel-close"]');
    await closeBtn.click();

    await expect(searchPanel).not.toBeVisible();
  });

  test('pinned messages button opens pinned panel', async ({ page }) => {
    const pinnedBtn = page.locator('[data-testid="header-pin-btn"]');
    await expect(pinnedBtn).toBeVisible();

    await pinnedBtn.click();

    const pinnedPanel = page.locator('[data-testid="pinned-panel"]');
    await expect(pinnedPanel).toBeVisible();
  });

  test('pinned panel close button works', async ({ page }) => {
    // Open pinned panel
    await page.locator('[data-testid="header-pin-btn"]').click();
    const pinnedPanel = page.locator('[data-testid="pinned-panel"]');
    await expect(pinnedPanel).toBeVisible();

    // Close it
    const closeBtn = page.locator('[data-testid="pinned-panel-close"]');
    await closeBtn.click();

    await expect(pinnedPanel).not.toBeVisible();
  });

  test('clicking search button again closes search panel (toggle)', async ({ page }) => {
    const searchBtn = page.locator('[data-testid="header-search-btn"]');

    // Open
    await searchBtn.click();
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible();

    // Toggle closed
    await searchBtn.click();
    await expect(page.locator('[data-testid="search-panel"]')).not.toBeVisible();
  });

  test('clicking a channel while a panel is open still works', async ({ page }) => {
    // Open search panel
    await page.locator('[data-testid="header-search-btn"]').click();
    await expect(page.locator('[data-testid="search-panel"]')).toBeVisible();

    // Click a channel in the sidebar
    const headerName = page.locator('[data-testid="header-channel-name"]');
    const initialName = await headerName.textContent();

    const channels = page.locator('.channel-list [data-testid^="channel-item-"]');
    const count = await channels.count();

    for (let i = 0; i < count; i++) {
      const chName = await channels.nth(i).locator('.ch-name').textContent();
      if (chName !== initialName) {
        await channels.nth(i).click();
        await expect(headerName).toHaveText(chName);
        break;
      }
    }
  });
});
