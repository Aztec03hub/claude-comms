import { test, expect } from '@playwright/test';

test('capture all console output', async ({ page }) => {
  const allLogs = [];
  page.on('console', msg => allLogs.push(`[${msg.type()}] ${msg.text()}`));
  
  await page.goto('http://localhost:6002');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 10000 });
  
  await page.waitForTimeout(3000);
  
  // Send a message
  const input = page.locator('[data-testid="message-input"]');
  await input.fill('Test msg');
  await input.press('Enter');
  
  await page.waitForTimeout(2000);
  
  const storeState = await page.evaluate(() => {
    const s = window.__store;
    return { messages: s.messages.length, active: s.activeMessages.length };
  });
  
  console.log('Store:', JSON.stringify(storeState));
  console.log('ALL LOGS:');
  for (const log of allLogs) {
    console.log('  ', log);
  }
  
  const hasEmpty = await page.locator('.empty-state').isVisible();
  expect(hasEmpty).toBe(false);
});
