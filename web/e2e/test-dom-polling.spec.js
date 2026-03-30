import { test, expect } from '@playwright/test';

test('check if DOM updates over time', async ({ page }) => {
  await page.goto('http://localhost:6002');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 10000 });
  
  // Check DOM at 0.5s intervals for 5 seconds
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const s = window.__store;
      const cv = document.querySelector('[data-testid="chat-view"]');
      const hasEmpty = !!cv?.querySelector('.empty-state');
      const childCount = cv?.children?.length || 0;
      return {
        storeMessages: s?.messages?.length || 0,
        hasEmpty,
        childCount,
        cvText: cv?.textContent?.substring(0, 80),
      };
    });
    console.log(`t=${(i+1)*0.5}s:`, JSON.stringify(state));
  }
  
  // Send a message
  const input = page.locator('[data-testid="message-input"]');
  await input.fill('DOM update test');
  await input.press('Enter');
  
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const s = window.__store;
      const cv = document.querySelector('[data-testid="chat-view"]');
      const hasEmpty = !!cv?.querySelector('.empty-state');
      return {
        storeMessages: s?.messages?.length || 0,
        hasEmpty,
        childCount: cv?.children?.length || 0,
      };
    });
    console.log(`after send t=${(i+1)*0.5}s:`, JSON.stringify(state));
  }
  
  const finalEmpty = await page.locator('.empty-state').isVisible();
  expect(finalEmpty).toBe(false);
});
