import { test, expect } from '@playwright/test';

test('comprehensive reactivity debug', async ({ page }) => {
  const allLogs = [];
  page.on('console', msg => allLogs.push(`[${msg.type()}] ${msg.text()}`));
  
  await page.goto('http://localhost:6002');
  await page.waitForSelector('[data-testid="chat-view"]', { timeout: 10000 });
  
  // Wait 2s for history fetch
  await page.waitForTimeout(2000);
  
  // Check DOM state
  const hasEmpty = await page.locator('.empty-state').isVisible();
  console.log('Has empty state after 2s:', hasEmpty);
  
  // Check store via window
  const storeState = await page.evaluate(() => {
    const s = window.__store;
    if (!s) return { error: 'no store on window' };
    return {
      messagesLength: s.messages.length,
      activeMessagesLength: s.activeMessages.length,
      activeChannel: s.activeChannel,
      connected: s.connected,
    };
  });
  console.log('Store state after 2s:', JSON.stringify(storeState));
  
  // Send a message
  const input = page.locator('[data-testid="message-input"]');
  await input.fill('Hello from debug test');
  await input.press('Enter');
  
  // Wait for processing
  await page.waitForTimeout(2000);
  
  const storeState2 = await page.evaluate(() => {
    const s = window.__store;
    return {
      messagesLength: s.messages.length,
      activeMessagesLength: s.activeMessages.length,
    };
  });
  console.log('Store state after send:', JSON.stringify(storeState2));
  
  // Check DOM
  const hasEmpty2 = await page.locator('.empty-state').isVisible();
  const chatViewHTML = await page.evaluate(() => 
    document.querySelector('[data-testid="chat-view"]').innerHTML.substring(0, 200)
  );
  console.log('Has empty state after send:', hasEmpty2);
  console.log('Chat view HTML:', chatViewHTML);
  
  // Dump all console logs
  const relevantLogs = allLogs.filter(l => l.includes('DEBUG') || l.includes('error') || l.includes('Error'));
  console.log('Relevant logs:', JSON.stringify(relevantLogs, null, 2));
  
  expect(hasEmpty2).toBe(false);
});
