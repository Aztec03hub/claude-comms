import { test, expect } from '@playwright/test';

test.describe('Member list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="member-list"]');
  });

  test('member list sidebar is visible', async ({ page }) => {
    const memberList = page.locator('[data-testid="member-list"]');
    await expect(memberList).toBeVisible();

    // Should have a header
    const header = page.locator('.members-header');
    await expect(header).toBeVisible();
  });

  test('members header shows count', async ({ page }) => {
    const header = page.locator('.members-header');
    await expect(header).toContainText('Members');
  });

  test('Online and Offline section headers may exist', async ({ page }) => {
    // These sections only appear when there are online/offline participants
    // Since the broker may not be running, just verify the sidebar structure
    const onlineSection = page.locator('[data-testid="members-online-section"]');
    const offlineSection = page.locator('[data-testid="members-offline-section"]');
    const onlineCount = await onlineSection.count();
    const offlineCount = await offlineSection.count();

    // The member-list container should exist regardless
    const memberSidebar = page.locator('[data-testid="member-list"]');
    await expect(memberSidebar).toBeVisible();

    if (onlineCount > 0) {
      const text = await onlineSection.textContent();
      expect(text).toMatch(/Online/);
    }
    if (offlineCount > 0) {
      const text = await offlineSection.textContent();
      expect(text).toMatch(/Offline/);
    }
  });

  test('clicking a member opens profile card (if members exist)', async ({ page }) => {
    // Members with data-testid="member-{key}" (not member-list or members-*)
    const members = page.locator('.member');
    const count = await members.count();

    if (count > 0) {
      await members.first().click();

      const profileCard = page.locator('[data-testid="profile-card"]');
      await expect(profileCard).toBeVisible();
    } else {
      // No members present (no broker connected), skip gracefully
      const memberSidebar = page.locator('[data-testid="member-list"]');
      await expect(memberSidebar).toBeVisible();
    }
  });

  test('profile card has name, role, action buttons', async ({ page }) => {
    // Open profile via user profile avatar in sidebar (always available)
    const userAvatar = page.locator('.user-avatar-wrap');
    await userAvatar.click();

    const profileCard = page.locator('[data-testid="profile-card"]');
    await expect(profileCard).toBeVisible();

    // Name
    const name = page.locator('[data-testid="profile-card-name"]');
    await expect(name).toBeVisible();
    await expect(name).not.toHaveText('');

    // Role
    const role = page.locator('.profile-card-role');
    await expect(role).toBeVisible();

    // Action buttons
    const buttons = page.locator('.profile-card-btn');
    expect(await buttons.count()).toBe(2);
    await expect(buttons.nth(0)).toContainText('Message');
    await expect(buttons.nth(1)).toContainText('View Profile');
  });

  test('clicking outside profile card closes it', async ({ page }) => {
    // Open profile card
    const userAvatar = page.locator('.user-avatar-wrap');
    await userAvatar.click();

    const profileCard = page.locator('[data-testid="profile-card"]');
    await expect(profileCard).toBeVisible();

    // Click backdrop (the profile-backdrop element covers the full screen)
    const backdrop = page.locator('[data-testid="profile-card-close"]');
    // Click far from the card to hit the backdrop
    await backdrop.click({ position: { x: 600, y: 300 } });

    await expect(page.locator('[data-testid="profile-card"]')).not.toBeVisible();
  });
});
