// @ts-check
import { test, expect } from '@playwright/test';

test('history API loads messages into web UI', async ({ page }) => {
  // Listen for console messages about history loading
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(msg.text()));

  await page.goto('/', { waitUntil: 'networkidle' });

  // Wait for history to load (the store logs "[claude-comms] Loaded N historical messages")
  await page.waitForTimeout(4000);

  // Debug: check what's in the DOM
  const bodyText = await page.locator('body').innerText();
  console.log('Page text includes "History API":', bodyText.includes('History API'));
  console.log('Page text includes "EVALTEST":', bodyText.includes('EVALTEST'));
  console.log('Page text includes "No messages":', bodyText.includes('No messages'));

  // Check if the messages are rendered
  const messageElements = await page.locator('.message, [class*="message-row"], [class*="MessageRow"]').count();
  console.log('Message elements found:', messageElements);

  // Take screenshot showing messages loaded from history
  await page.screenshot({
    path: '../.worklogs/history-api-web-ui.png',
    fullPage: false,
  });

  // Verify history-loaded messages appear
  const historyLog = consoleLogs.find(l => l.includes('historical messages'));
  console.log('History log:', historyLog);
  console.log('All console logs:', consoleLogs.filter(l => l.includes('claude-comms')));
  expect(historyLog).toBeTruthy();
});
