import { test, expect } from '@playwright/test';

test.describe('Right-click context menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.app-layout');
  });

  // Helper: send a message and wait for it to render as a message bubble
  async function ensureMessage(page) {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Test message for context menu');
    await input.press('Enter');

    // Wait for an actual message row (not date separator) to appear
    const msgRow = page.locator('.msg-row:not(.system)');
    await msgRow.first().waitFor({ state: 'visible', timeout: 5000 });
  }

  test('right-clicking a message shows context menu', async ({ page }) => {
    await ensureMessage(page);

    const firstMsg = page.locator('.msg-row:not(.system)').first();
    await firstMsg.click({ button: 'right' });

    const contextMenu = page.locator('[data-testid="context-menu"]');
    await expect(contextMenu).toBeVisible();
  });

  test('context menu has Reply, Pin, Copy, React, Delete options', async ({ page }) => {
    await ensureMessage(page);

    const firstMsg = page.locator('.msg-row:not(.system)').first();
    await firstMsg.click({ button: 'right' });

    const contextMenu = page.locator('[data-testid="context-menu"]');
    await expect(contextMenu).toBeVisible();

    await expect(page.locator('[data-testid="ctx-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctx-pin"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctx-copy"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctx-react"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctx-delete"]')).toBeVisible();
  });

  test('clicking a context menu item closes the menu', async ({ page }) => {
    await ensureMessage(page);

    const firstMsg = page.locator('.msg-row:not(.system)').first();
    await firstMsg.click({ button: 'right' });

    const contextMenu = page.locator('[data-testid="context-menu"]');
    await expect(contextMenu).toBeVisible();

    await page.locator('[data-testid="ctx-copy"]').click();

    await expect(page.locator('.ctx-backdrop')).not.toBeVisible();
  });

  test('clicking outside closes the context menu', async ({ page }) => {
    await ensureMessage(page);

    const firstMsg = page.locator('.msg-row:not(.system)').first();
    await firstMsg.click({ button: 'right' });

    const backdrop = page.locator('.ctx-backdrop');
    await expect(backdrop).toBeVisible();

    await backdrop.click({ position: { x: 5, y: 5 } });

    await expect(backdrop).not.toBeVisible();
  });

  test('escape closes the context menu', async ({ page }) => {
    await ensureMessage(page);

    const firstMsg = page.locator('.msg-row:not(.system)').first();
    await firstMsg.click({ button: 'right' });

    await expect(page.locator('[data-testid="context-menu"]')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.locator('.ctx-backdrop')).not.toBeVisible();
  });
});
