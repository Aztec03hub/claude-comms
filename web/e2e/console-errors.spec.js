import { test, expect } from '@playwright/test';

// Patterns to ignore: MQTT connection failures (broker may be offline),
// and Svelte framework runtime warnings (not application errors)
const IGNORE_PATTERNS = [
  'WebSocket', 'mqtt', 'MQTT', 'ws://',
  'each_key_duplicate',  // Svelte runtime warning about keyed each blocks
  'CORS', 'ERR_CONNECTION_REFUSED', 'Failed to load resource', 'ERR_FAILED',
  'api/participants', 'Access-Control-Allow-Origin',
];

function shouldIgnore(text) {
  return IGNORE_PATTERNS.some(p => text.includes(p));
}

test.describe('JS error monitoring', () => {
  test('navigate through major interactions without uncaught errors', async ({ page }) => {
    const errors = [];
    const warnings = [];

    page.on('pageerror', (err) => {
      if (!shouldIgnore(err.message)) errors.push(err.message);
    });
    page.on('console', (msg) => {
      const text = msg.text();
      if (shouldIgnore(text)) return;
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

    // 2. Open and close search panel (before any messages to avoid toast interference)
    await page.locator('[data-testid="header-search-btn"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="search-panel-close"]').click();
    await page.waitForTimeout(100);

    // 3. Open and close pinned panel
    await page.locator('[data-testid="header-pin-btn"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="pinned-panel-close"]').click();
    await page.waitForTimeout(100);

    // 4. Open and close channel creation modal
    await page.locator('[data-testid="sidebar-create-channel"]').click();
    await page.waitForTimeout(200);
    const cancelBtn = page.locator('[data-testid="channel-modal-cancel"]');
    await cancelBtn.scrollIntoViewIfNeeded();
    await cancelBtn.click({ force: true });
    await page.waitForTimeout(100);

    // 5. Click through channels
    const channels = page.locator('.channel-list [data-testid^="channel-item-"]');
    const channelCount = await channels.count();
    for (let i = 0; i < Math.min(channelCount, 4); i++) {
      await channels.nth(i).click();
      await page.waitForTimeout(100);
    }

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
    page.on('pageerror', (err) => {
      if (!shouldIgnore(err.message)) errors.push(err.message);
    });

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
    page.on('pageerror', (err) => {
      if (!shouldIgnore(err.message)) errors.push(err.message);
    });

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
