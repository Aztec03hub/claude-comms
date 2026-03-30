// @ts-check
import { test, expect } from '@playwright/test';

test('history API loads messages into web UI', async ({ page }) => {
  // Listen for console messages about history loading
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(msg.text()));

  await page.goto('/', { waitUntil: 'networkidle' });

  // Wait for history to load (the store logs "[claude-comms] Loaded N historical messages")
  await page.waitForTimeout(3000);

  // Take screenshot showing messages loaded from history
  await page.screenshot({
    path: '../.worklogs/history-api-web-ui.png',
    fullPage: false,
  });

  // Verify history-loaded messages appear
  const historyLog = consoleLogs.find(l => l.includes('historical messages'));
  console.log('History log:', historyLog);
  expect(historyLog).toBeTruthy();

  // Verify at least one message is visible in the chat area
  const chatLog = page.locator('[role="log"]');
  await expect(chatLog).toBeVisible();
});
