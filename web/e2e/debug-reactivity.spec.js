import { test, expect } from '@playwright/test';

test('debug: send message and check reactivity', async ({ page }) => {
  const consoleLogs = [];
  page.on('console', msg => {
    if (msg.text().includes('[DEBUG')) {
      consoleLogs.push(msg.text());
    }
  });

  await page.goto('http://localhost:6001');

  // Wait for the app to load
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 10000 });

  // Check initial state
  const emptyState = await page.locator('.empty-state').isVisible().catch(() => false);
  console.log('Empty state visible:', emptyState);

  // Type and send a message
  const input = page.locator('[data-testid="message-input"]');
  await input.waitFor({ timeout: 5000 });
  await input.fill('Hello reactivity test');
  await input.press('Enter');

  // Wait a moment for reactivity
  await page.waitForTimeout(1000);

  // Check if empty state is still showing
  const stillEmpty = await page.locator('.empty-state').isVisible().catch(() => false);

  // Check for message bubbles
  const messageCount = await page.locator('[data-testid="chat-view"] .message-bubble, [data-testid="chat-view"] [class*="message"]').count();

  console.log('Still empty after send:', stillEmpty);
  console.log('Message elements found:', messageCount);
  console.log('Debug logs:', JSON.stringify(consoleLogs, null, 2));

  // The test: after sending, "No messages yet" should be gone
  expect(stillEmpty).toBe(false);
});
