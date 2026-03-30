import { test, expect } from '@playwright/test';

test.describe('Sidebar interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]');
  });

  test('channel list is visible', async ({ page }) => {
    const channelList = page.locator('.channel-list');
    await expect(channelList.first()).toBeVisible();

    // Should have at least one channel item
    const items = page.locator('[data-testid^="channel-item-"]');
    expect(await items.count()).toBeGreaterThan(0);
  });

  test('clicking a channel highlights it (has active class)', async ({ page }) => {
    // Click the second channel in the conversations list
    const channels = page.locator('[data-testid="sidebar-conversations-section"] ~ .channel-list [data-testid^="channel-item-"]');
    const count = await channels.count();
    expect(count).toBeGreaterThan(1);

    // Find a channel that is not currently active
    const secondChannel = channels.nth(1);
    await secondChannel.click();

    await expect(secondChannel).toHaveClass(/active/);
  });

  test('clicking a channel updates the header channel name', async ({ page }) => {
    const headerName = page.locator('[data-testid="header-channel-name"]');
    const initialName = await headerName.textContent();

    // Find and click a different channel
    const channels = page.locator('.channel-list [data-testid^="channel-item-"]');
    const count = await channels.count();

    // Click through channels to find one with a different name
    for (let i = 0; i < count; i++) {
      const chName = await channels.nth(i).locator('.ch-name').textContent();
      if (chName !== initialName) {
        await channels.nth(i).click();
        await expect(headerName).toHaveText(chName);
        break;
      }
    }
  });

  test('Starred section can be collapsed/expanded', async ({ page }) => {
    // Check if starred section exists (depends on store having starred channels)
    const starredLabel = page.locator('[data-testid="sidebar-starred-section"]');
    const starredExists = await starredLabel.count() > 0;

    if (starredExists) {
      const arrow = page.locator('[data-testid="sidebar-starred-toggle"]');

      // Click to collapse
      await arrow.click();
      await expect(starredLabel).toHaveClass(/collapsed/);

      // Click to expand
      await arrow.click();
      await expect(starredLabel).not.toHaveClass(/collapsed/);
    } else {
      // If no starred channels, just verify the conversations section exists
      const convoLabel = page.locator('[data-testid="sidebar-conversations-section"]');
      await expect(convoLabel).toBeVisible();
    }
  });

  test('Conversations section can be collapsed/expanded', async ({ page }) => {
    const convoLabel = page.locator('[data-testid="sidebar-conversations-section"]');
    await expect(convoLabel).toBeVisible();

    const arrow = page.locator('[data-testid="sidebar-conversations-toggle"]');

    // Click to collapse
    await arrow.click();
    await expect(convoLabel).toHaveClass(/collapsed/);

    // Channels should be hidden
    // Click to expand
    await arrow.click();
    await expect(convoLabel).not.toHaveClass(/collapsed/);
  });

  test('"New Conversation" button is visible and clickable', async ({ page }) => {
    const newBtn = page.locator('[data-testid="sidebar-create-channel"]');
    await expect(newBtn).toBeVisible();
    await expect(newBtn).toContainText('New Conversation');

    // Click should open the channel modal
    await newBtn.click();
    const modal = page.locator('[data-testid="channel-modal"]');
    await expect(modal).toBeVisible();
  });

  test('search input is focusable', async ({ page }) => {
    const searchInput = page.locator('[data-testid="sidebar-search"]');
    await expect(searchInput).toBeVisible();

    await searchInput.focus();
    await expect(searchInput).toBeFocused();

    // Type something
    await searchInput.fill('test search');
    await expect(searchInput).toHaveValue('test search');
  });

  test('user profile area shows at bottom', async ({ page }) => {
    const userProfile = page.locator('[data-testid="sidebar-user-profile"]');
    await expect(userProfile).toBeVisible();

    // Should show user name
    const userName = page.locator('[data-testid="sidebar-user-profile"] .uname');
    await expect(userName).toBeVisible();
    await expect(userName).not.toHaveText('');

    // Should show online status
    const userStatus = page.locator('[data-testid="sidebar-user-profile"] .ustatus');
    await expect(userStatus).toHaveText('Online');
  });
});
