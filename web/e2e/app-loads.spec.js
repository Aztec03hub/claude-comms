import { test, expect } from '@playwright/test';

test.describe('App loads correctly', () => {
  test('page loads without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForSelector('.app-layout');

    expect(errors).toEqual([]);
  });

  test('3-column layout is visible (sidebar, center, right panel)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.app-layout');

    const sidebar = page.locator('[data-testid="sidebar"]');
    const center = page.locator('.center');
    const rightPanel = page.locator('[data-testid="member-list"]');

    await expect(sidebar).toBeVisible();
    await expect(center).toBeVisible();
    await expect(rightPanel).toBeVisible();
  });

  test('header shows channel name', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="chat-header"]');

    const headerName = page.locator('[data-testid="header-channel-name"]');
    await expect(headerName).toBeVisible();
    await expect(headerName).toHaveText('general');
  });

  test('input area is visible with placeholder text', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.input-area');

    const input = page.locator('[data-testid="message-input"]');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', /Message #/);
  });

  test('no console errors on load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Ignore MQTT connection errors since broker may not be running
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('mqtt')) {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForSelector('.app-layout');
    // Give the page a moment to settle
    await page.waitForTimeout(500);

    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
