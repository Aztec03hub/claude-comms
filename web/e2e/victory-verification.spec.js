/**
 * Victory verification test — confirms Svelte 5 reactivity fix works:
 * 1. Send 3 messages and verify they render as bubbles
 * 2. Switch channels and verify messages are channel-specific
 * 3. Send a message with @mention and verify highlighting
 * 4. Take a final victory screenshot at 1440x900
 */
import { test, expect } from '@playwright/test';

test.describe('Reactivity Fix Verification', () => {
  test('messages render as bubbles, channels isolate, mentions highlight', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto('/', { waitUntil: 'networkidle', timeout: 15000 });

    // Wait for the app layout to load
    await page.waitForSelector('[data-testid="message-input"]', { timeout: 10000 });

    // Step 1: Send 3 messages and verify they render
    const messages = [
      'Reactivity fix verified - message 1',
      'Svelte 5 $state works correctly - message 2',
      'All bubbles rendering properly - message 3',
    ];

    for (const msg of messages) {
      const input = page.locator('[data-testid="message-input"]');
      await input.fill(msg);
      await input.press('Enter');
      // Wait for the message to appear as a bubble
      await page.waitForTimeout(300);
    }

    // Verify all 3 messages are visible as bubble elements
    for (const msg of messages) {
      const bubble = page.locator('.bubble').filter({ hasText: msg }).last();
      await expect(bubble).toBeVisible({ timeout: 5000 });
    }

    // Count bubbles — should have at least 3
    const bubbleCount = await page.locator('.bubble').count();
    expect(bubbleCount).toBeGreaterThanOrEqual(3);

    // Step 2: Switch channels — verify messages are channel-specific
    // Click on a different channel in the sidebar
    const randomChannel = page.locator('[data-testid="channel-item-random"]');
    if (await randomChannel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await randomChannel.click();
    } else {
      // Try clicking by text
      await page.locator('.channel-item').filter({ hasText: 'random' }).click();
    }
    await page.waitForTimeout(500);

    // Verify the header shows "random"
    const headerName = page.locator('[data-testid="header-channel-name"]');
    await expect(headerName).toHaveText('random', { timeout: 3000 });

    // The 3 messages from general should NOT be visible here
    for (const msg of messages) {
      const bubble = page.locator('.bubble').filter({ hasText: msg });
      await expect(bubble).toHaveCount(0);
    }

    // Send a message in random to confirm it works here too
    const randomMsg = 'Channel isolation works - random channel';
    const input2 = page.locator('[data-testid="message-input"]');
    await input2.fill(randomMsg);
    await input2.press('Enter');
    await page.waitForTimeout(300);

    const randomBubble = page.locator('.bubble').filter({ hasText: randomMsg });
    await expect(randomBubble).toBeVisible({ timeout: 5000 });

    // Switch back to general — messages should still be there
    const generalChannel = page.locator('.channel-item').filter({ hasText: 'general' });
    await generalChannel.click();
    await page.waitForTimeout(500);

    await expect(headerName).toHaveText('general', { timeout: 3000 });

    // Verify original messages are back
    for (const msg of messages) {
      const bubble = page.locator('.bubble').filter({ hasText: msg });
      await expect(bubble).toBeVisible({ timeout: 5000 });
    }

    // Step 3: Send a message with @mention and verify highlighting
    const mentionMsg = 'Hey @Phil check this out!';
    const input3 = page.locator('[data-testid="message-input"]');
    await input3.fill(mentionMsg);
    await input3.press('Enter');
    await page.waitForTimeout(500);

    // Verify the @Phil mention is rendered with the .mention class
    const mentionSpan = page.locator('.mention').filter({ hasText: '@Phil' });
    await expect(mentionSpan).toBeVisible({ timeout: 5000 });

    // Step 4: Take victory screenshot
    await page.waitForTimeout(500);
    await page.screenshot({
      path: 'e2e/victory-reactivity-fixed.png',
      fullPage: false,
    });

    await context.close();
  });
});
