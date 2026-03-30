import { test, expect } from '@playwright/test';

test.describe('JS error monitoring', () => {
  test('navigate through major interactions without uncaught errors', async ({ page }) => {
    const errors = [];
    const warnings = [];

    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('WebSocket') || text.includes('mqtt') || text.includes('MQTT') || text.includes('ws://')) {
        return;
      }
      if (msg.type() === 'error') {
        errors.push(text);
      }
      if (msg.type() === 'warning') {
        warnings.push(text);
      }
    });

    // 1. Load the app
    await page.goto('/');
    await page.waitForSelector('.app-layout');

    // 2. Click through channels
    const channels = page.locator('.channel-list [data-testid^="channel-item-"]');
    const channelCount = await channels.count();
    for (let i = 0; i < Math.min(channelCount, 4); i++) {
      await channels.nth(i).click();
      await page.waitForTimeout(100);
    }

    // 3. Open and close search panel
    await page.locator('[data-testid="header-search-btn"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="search-panel-close"]').click();
    await page.waitForTimeout(100);

    // 4. Open and close pinned panel
    await page.locator('[data-testid="header-pin-btn"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="pinned-panel-close"]').click();
    await page.waitForTimeout(100);

    // 5. Open and close channel creation modal
    await page.locator('[data-testid="sidebar-create-channel"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="channel-modal-cancel"]').click();
    await page.waitForTimeout(100);

    // 6. Type in message input
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Test message');
    await input.press('Enter');
    await page.waitForTimeout(200);

    // 7. Open profile card from user avatar
    await page.locator('.user-avatar-wrap').click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // 8. Collapse/expand sidebar sections
    const arrow = page.locator('[data-testid="sidebar-conversations-toggle"]');
    await arrow.click();
    await page.waitForTimeout(100);
    await arrow.click();
    await page.waitForTimeout(100);

    if (warnings.length > 0) {
      console.log('Console warnings collected:', warnings);
    }

    expect(errors).toEqual([]);
  });

  test('sending multiple messages rapidly does not cause errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForSelector('.input-area');

    const input = page.locator('[data-testid="message-input"]');

    for (let i = 0; i < 5; i++) {
      await input.fill(`Rapid message ${i + 1}`);
      await input.press('Enter');
    }

    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });

  test('switching channels rapidly does not cause errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]');

    const channels = page.locator('.channel-list [data-testid^="channel-item-"]');
    const count = await channels.count();

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < Math.min(count, 4); i++) {
        await channels.nth(i).click();
      }
    }

    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });
});
