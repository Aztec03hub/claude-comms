import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups';

test.describe('Message sending, display, and input behavior', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/', { timeout: 30000 });
    await page.waitForSelector('[data-testid="message-input"]', { timeout: 30000 });
  });

  // Helper: send a message and wait for the bubble to appear
  async function sendAndVerify(page, text) {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill(text);
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 5000 });
    const bubble = page.locator('.bubble').filter({ hasText: text.slice(0, 30) }).last();
    await expect(bubble).toBeVisible({ timeout: 10000 });
    return bubble;
  }

  // ── Test 1: Type in message input ──
  test('1. typing in message input shows text in the field', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Hello, this is a test message');
    await expect(input).toHaveValue('Hello, this is a test message');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-01-typing.png`, fullPage: true });
  });

  // ── Test 2: Press Enter to send ──
  test('2. pressing Enter sends message — input clears, bubble appears', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    await input.fill('Enter-sent message');
    await input.press('Enter');

    await expect(input).toHaveValue('');
    const bubble = page.locator('.bubble').filter({ hasText: 'Enter-sent message' });
    await expect(bubble).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-02-enter-send.png`, fullPage: true });
  });

  // ── Test 3: Click send button ──
  test('3. clicking send button sends message — input clears, bubble appears', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    const sendBtn = page.locator('[data-testid="send-button"]');

    await input.fill('Button-sent message');
    await sendBtn.click();

    await expect(input).toHaveValue('');
    const bubble = page.locator('.bubble').filter({ hasText: 'Button-sent message' });
    await expect(bubble).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-03-button-send.png`, fullPage: true });
  });

  // ── Test 4: Multiple messages stack correctly with grouping ──
  test('4. multiple messages from same sender group correctly (no repeated avatar/name)', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');

    for (const text of ['First message', 'Second message', 'Third message']) {
      await input.fill(text);
      await input.press('Enter');
      await expect(input).toHaveValue('', { timeout: 5000 });
    }

    await expect(page.locator('.bubble').filter({ hasText: 'First message' }).last()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.bubble').filter({ hasText: 'Second message' }).last()).toBeVisible();
    await expect(page.locator('.bubble').filter({ hasText: 'Third message' }).last()).toBeVisible();

    // Consecutive messages in same-sender group should have class "consecutive"
    const consecutiveRows = page.locator('.msg-row.consecutive');
    const consecutiveCount = await consecutiveRows.count();
    expect(consecutiveCount).toBeGreaterThanOrEqual(2);

    // Consecutive rows use avatar-spacer instead of a real avatar
    for (let i = 0; i < consecutiveCount; i++) {
      const spacer = consecutiveRows.nth(i).locator('.avatar-spacer');
      await expect(spacer).toBeAttached();
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-04-multiple-grouped.png`, fullPage: true });
  });

  // ── Test 5: Long message wraps correctly ──
  test('5. long message wraps correctly in the bubble', async ({ page }) => {
    const longText = 'This is a very long message that should wrap. '.repeat(8);

    const bubble = await sendAndVerify(page, longText);

    // Check word-wrap CSS (may be 'break-word' or 'anywhere' depending on CSS)
    const wordWrap = await bubble.evaluate(el => getComputedStyle(el).wordWrap);
    expect(['break-word', 'anywhere']).toContain(wordWrap);

    // Bubble should be narrower than the chat view
    const bubbleBox = await bubble.boundingBox();
    const chatBox = await page.locator('[data-testid="chat-view"]').boundingBox();
    expect(bubbleBox.width).toBeLessThan(chatBox.width * 0.85);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-05-long-message.png`, fullPage: true });
  });

  // ── Test 6: @mention renders ──
  test('6. message with @mention renders the mention with special styling', async ({ page }) => {
    await sendAndVerify(page, 'Hey @someone check this out');

    const mention = page.locator('.mention').filter({ hasText: '@someone' }).last();
    await expect(mention).toBeVisible({ timeout: 10000 });

    const bg = await mention.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-06-mention.png`, fullPage: true });
  });

  // ── Test 7: Empty input + Enter should NOT send ──
  test('7. empty input + Enter does NOT send a message', async ({ page }) => {
    const input = page.locator('[data-testid="message-input"]');
    const bubblesBefore = await page.locator('.bubble').count();

    // Empty Enter
    await input.focus();
    await input.press('Enter');
    await page.waitForTimeout(300);
    expect(await page.locator('.bubble').count()).toBe(bubblesBefore);

    // Whitespace-only Enter
    await input.fill('   ');
    await input.press('Enter');
    await page.waitForTimeout(300);
    expect(await page.locator('.bubble').count()).toBe(bubblesBefore);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-07-empty-no-send.png`, fullPage: true });
  });

  // ── Test 8: Human message bubble alignment (RIGHT-aligned) ──
  test('8. human messages are RIGHT-aligned', async ({ page }) => {
    await sendAndVerify(page, 'Alignment test message');

    const msgRow = page.locator('.msg-row.human').first();
    await expect(msgRow).toBeVisible({ timeout: 10000 });

    const alignSelf = await msgRow.evaluate(el => getComputedStyle(el).alignSelf);
    expect(alignSelf).toBe('flex-end');

    const flexDir = await msgRow.evaluate(el => getComputedStyle(el).flexDirection);
    expect(flexDir).toBe('row-reverse');

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-08-alignment.png`, fullPage: true });
  });

  // ── Test 9: Timestamp format "Today at HH:MM AM/PM" ──
  test('9. timestamp shows "Today at HH:MM AM/PM" format', async ({ page }) => {
    await sendAndVerify(page, 'Timestamp test');

    const msgTime = page.locator('.msg-time').first();
    await expect(msgTime).toBeVisible({ timeout: 10000 });

    const timeText = await msgTime.textContent();
    const pattern = /^Today at \d{1,2}:\d{2}\s?(AM|PM)$/;
    expect(timeText.trim()).toMatch(pattern);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-09-timestamp.png`, fullPage: true });
  });

  // ── Test 10: Auto-scroll after sending ──
  test('10. auto-scroll to bottom after sending a message', async ({ page }) => {
    test.setTimeout(120000);
    const input = page.locator('[data-testid="message-input"]');

    // Send 8 messages (enough to cause scroll)
    for (let i = 0; i < 8; i++) {
      await input.fill(`Scroll test message ${i + 1}`);
      await input.press('Enter');
      await expect(input).toHaveValue('', { timeout: 5000 });
    }

    // Wait for rendering and scroll
    await page.waitForTimeout(2000);

    // Verify the last sent message is visible in the viewport
    const lastBubble = page.locator('.bubble').filter({ hasText: 'Scroll test message 8' }).last();
    await expect(lastBubble).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-messages-10-autoscroll.png`, fullPage: true });
  });
});
