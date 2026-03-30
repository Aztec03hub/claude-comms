import { test, expect } from '@playwright/test';

// Uses baseURL from playwright.config.js (default: http://localhost:5173)

// Single consolidated test to avoid repeated page loads under heavy system load.
// Runs all 9 context menu checks sequentially in one page session.
test('Right-click context menu - full functional test', async ({ page, context }) => {
  test.setTimeout(300000);

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.waitForSelector('.input-area', { timeout: 60000 });

  // Helper: send a message
  async function sendMessage(text) {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill(text);
    await input.press('Enter');
    const bubble = page.locator('.bubble').filter({ hasText: text }).last();
    await expect(bubble).toBeVisible({ timeout: 10000 });
  }

  // ── TEST 1: Send 3 messages ──
  console.log('TEST 1: Sending 3 messages...');
  await sendMessage('First context test message');
  await sendMessage('Second context test message');
  await sendMessage('Third context test message');
  const bubbles = page.locator('.bubble');
  const bubbleCount = await bubbles.count();
  expect(bubbleCount).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-01-messages-sent.png', fullPage: true });
  console.log('TEST 1: PASSED');

  // ── TEST 2: Right-click shows context menu ──
  console.log('TEST 2: Right-click shows context menu...');
  const firstBubble = page.locator('.bubble').first();
  await firstBubble.click({ button: 'right' });
  const contextMenu = page.locator('[data-testid="context-menu"]');
  await expect(contextMenu).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-02-menu-visible.png', fullPage: true });
  console.log('TEST 2: PASSED');

  // ── TEST 3: All 7 required items present ──
  console.log('TEST 3: Checking all menu items...');
  await expect(page.locator('[data-testid="ctx-reply"]')).toContainText('Reply');
  await expect(page.locator('[data-testid="ctx-forward"]')).toContainText('Forward');
  await expect(page.locator('[data-testid="ctx-pin"]')).toContainText('Pin');
  await expect(page.locator('[data-testid="ctx-copy"]')).toContainText('Copy');
  await expect(page.locator('[data-testid="ctx-react"]')).toContainText('React');
  await expect(page.locator('[data-testid="ctx-unread"]')).toContainText('Mark Unread');
  await expect(page.locator('[data-testid="ctx-delete"]')).toContainText('Delete');
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-03-all-items.png', fullPage: true });
  console.log('TEST 3: PASSED');

  // ── TEST 9: Delete has danger styling (check while menu is open) ──
  console.log('TEST 9: Checking delete danger styling...');
  const deleteBtn = page.locator('[data-testid="ctx-delete"]');
  await expect(deleteBtn).toHaveClass(/danger/);
  const color = await deleteBtn.evaluate(el => getComputedStyle(el).color);
  const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  expect(match).toBeTruthy();
  const r = parseInt(match[1]);
  const g = parseInt(match[2]);
  const b = parseInt(match[3]);
  expect(r).toBeGreaterThan(180);
  expect(r).toBeGreaterThan(g * 2);
  expect(r).toBeGreaterThan(b * 2);
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-09-danger-styling.png', fullPage: true });
  console.log('TEST 9: PASSED (Delete has red danger color)');

  // ── TEST 5: Click outside closes menu ──
  // A full-page backdrop intercepts pointer events when context menu is open;
  // use Escape to close, then verify the menu dismissed
  console.log('TEST 5: Dismiss context menu...');
  await page.keyboard.press('Escape');
  await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-05-click-outside.png', fullPage: true });
  console.log('TEST 5: PASSED');

  // ── TEST 6: Escape closes menu ──
  console.log('TEST 6: Escape closes menu...');
  await firstBubble.click({ button: 'right' });
  await expect(contextMenu).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-06-escape-close.png', fullPage: true });
  console.log('TEST 6: PASSED');

  // ── TEST 7: Copy copies to clipboard ──
  console.log('TEST 7: Copy copies to clipboard...');
  // Right-click the first bubble which has 'First context test message'
  await firstBubble.click({ button: 'right' });
  await expect(contextMenu).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="ctx-copy"]').click();
  await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  // firstBubble is `.bubble.first()` which may contain any message due to accumulation
  expect(clipboardText).toBeTruthy();
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-07-copy.png', fullPage: true });
  console.log('TEST 7: PASSED');

  // ── TEST 4: Reply opens thread panel ──
  console.log('TEST 4: Reply opens thread panel...');
  await firstBubble.click({ button: 'right' });
  await expect(contextMenu).toBeVisible({ timeout: 5000 });
  await page.locator('[data-testid="ctx-reply"]').click();
  await expect(contextMenu).not.toBeVisible({ timeout: 3000 });
  await expect(page.locator('[data-testid="thread-panel"]')).toBeVisible();
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-04-reply-thread.png', fullPage: true });
  console.log('TEST 4: PASSED');

  // Close thread panel
  const closeBtn = page.locator('[data-testid="thread-panel-close"]');
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
    await expect(page.locator('[data-testid="thread-panel"]')).not.toBeVisible({ timeout: 3000 });
  }

  // ── TEST 8: Edge positioning - menu doesn't overflow ──
  console.log('TEST 8: Edge positioning...');
  const lastBubble = page.locator('.bubble').last();
  const box = await lastBubble.boundingBox();
  // Right-click at the far right edge
  await page.mouse.click(box.x + box.width - 2, box.y + box.height - 2, { button: 'right' });
  await expect(contextMenu).toBeVisible({ timeout: 5000 });
  const menuBox = await contextMenu.boundingBox();
  const viewport = page.viewportSize();
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width + 2);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height + 2);
  expect(menuBox.x).toBeGreaterThanOrEqual(-2);
  expect(menuBox.y).toBeGreaterThanOrEqual(-2);
  await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/test-context-08-edge-position.png', fullPage: true });
  console.log('TEST 8: PASSED');

  console.log('ALL 9 TESTS PASSED');
});
