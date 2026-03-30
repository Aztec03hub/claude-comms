import { test, expect } from '@playwright/test';

test('debug right-click context menu', async ({ page }) => {
  test.setTimeout(60000);

  await page.goto('/');
  await page.waitForSelector('.input-area', { timeout: 30000 });

  // Send a message
  const input = page.locator('[data-testid="message-input"]');
  await input.fill('Debug context menu test');
  await input.press('Enter');

  const bubble = page.locator('.bubble').filter({ hasText: 'Debug context menu test' });
  await expect(bubble).toBeVisible({ timeout: 5000 });

  const firstMsg = page.locator('.msg-row').first();
  await expect(firstMsg).toBeVisible();

  // Check what Svelte event delegation looks like
  const hasHandler = await firstMsg.evaluate((el) => {
    // Check direct handler
    const directHandler = el.oncontextmenu;
    // Check if Svelte 5 uses event delegation on the root
    const rootHasHandler = document.documentElement.oncontextmenu || document.body.oncontextmenu;
    // Check for __svelte_meta or event listeners
    const hasListeners = el.getAttributeNames().filter(a => a.startsWith('on'));

    return {
      directHandler: !!directHandler,
      rootHandler: !!rootHasHandler,
      attrs: el.getAttributeNames(),
      html: el.outerHTML.slice(0, 500),
      hasListeners
    };
  });
  console.log('Event handler info:', JSON.stringify(hasHandler, null, 2));

  // Try using Playwright's click locator directly on bubble
  console.log('Trying click on bubble instead of msg-row...');
  const bubbleEl = page.locator('.bubble').first();
  await bubbleEl.click({ button: 'right' });
  await page.waitForTimeout(500);
  let menuVisible = await page.locator('[data-testid="context-menu"]').isVisible();
  console.log('Menu visible after bubble right-click:', menuVisible);

  if (!menuVisible) {
    // Try clicking directly on the msg-row with force
    console.log('Trying msg-row click with force...');
    await firstMsg.click({ button: 'right', force: true });
    await page.waitForTimeout(500);
    menuVisible = await page.locator('[data-testid="context-menu"]').isVisible();
    console.log('Menu visible after force right-click:', menuVisible);
  }

  // Investigate: does Svelte 5 delegate contextmenu to the document?
  if (!menuVisible) {
    console.log('Checking Svelte 5 event delegation...');
    const delegationInfo = await page.evaluate(() => {
      // Svelte 5 delegates events to the document root
      const events = getEventListeners ? getEventListeners(document) : null;
      return {
        documentContextmenu: events ? !!events.contextmenu : 'getEventListeners not available',
      };
    }).catch(() => 'evaluate failed');
    console.log('Delegation info:', delegationInfo);
  }

  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-debug.png', fullPage: true });

  // Don't fail - just report
  console.log('Final menu state:', menuVisible ? 'VISIBLE' : 'NOT VISIBLE');
});
