import { test, expect } from '@playwright/test';

test.describe('Chat area interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.input-area');
  });

  test('message input accepts text', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Hello world');
    await expect(input).toHaveValue('Hello world');
  });

  test('pressing Enter in input (with text) should attempt to send (input clears)', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Test message to send');
    await expect(input).toHaveValue('Test message to send');

    await input.press('Enter');

    // Input should clear after sending
    await expect(input).toHaveValue('');
  });

  test('send button is clickable', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    const sendBtn = page.locator('[data-testid="send-button"]');

    await expect(sendBtn).toBeVisible();

    // Fill text and click send
    await input.fill('Clicking send button');
    await sendBtn.click();

    // Input should clear
    await expect(input).toHaveValue('');
  });

  test('message bubbles area exists (messages container)', async ({ page }) => {
    const messagesArea = page.locator('[data-testid="chat-view"]');
    await expect(messagesArea).toBeVisible();
  });

  test('sent message appears as a bubble', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Hello from the test');
    await input.press('Enter');

    // Wait for the message to render
    const bubble = page.locator('.bubble').filter({ hasText: 'Hello from the test' });
    await expect(bubble).toBeVisible();
  });

  test('hovering a message shows action bar (Reply, React, More buttons)', async ({ page }) => {
    // Send a message first so we have something to hover
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Hover test message');
    await input.press('Enter');

    // Wait for actual message row (not date separator)
    const msgRow = page.locator('.msg-row:not(.system)');
    await msgRow.first().waitFor({ state: 'visible', timeout: 5000 });

    const firstMsg = msgRow.first();
    const actions = firstMsg.locator('.msg-actions');

    // Actions should be hidden by default (opacity 0)
    await expect(actions).toHaveCSS('opacity', '0');

    // Hover to reveal
    await firstMsg.hover();
    await expect(actions).toHaveCSS('opacity', '1');

    // Should have Reply, React, More buttons
    const buttons = actions.locator('.msg-action-btn');
    expect(await buttons.count()).toBe(3);
  });
});
