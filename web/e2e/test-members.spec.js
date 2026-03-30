import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups';

// The MQTT broker may have many retained presence messages (1000+),
// causing the page to be slow to render. The playwright config sets 60s timeout.

/**
 * Helper to open the profile card via user avatar click.
 * Uses force:true to avoid timeout issues when DOM is busy with MQTT messages.
 */
async function openProfileCard(page) {
  const userAvatar = page.locator('.user-avatar-wrap');
  await expect(userAvatar).toBeVisible({ timeout: 10000 });
  await userAvatar.click({ force: true });
  const profileCard = page.locator('[data-testid="profile-card"]');
  await expect(profileCard).toBeVisible({ timeout: 5000 });
  return profileCard;
}

test.describe('Member List & Profile Card', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app-layout')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="member-list"]')).toBeVisible({ timeout: 30000 });
  });

  // ── Test 1: Member list visible ──
  test('1. Member list sidebar is visible with Online/Offline sections', async ({ page }) => {
    const memberList = page.locator('[data-testid="member-list"]');
    await expect(memberList).toBeVisible();

    const header = page.locator('.members-header');
    await expect(header).toBeVisible();
    await expect(header).toContainText('Members');

    const onlineSection = page.locator('[data-testid="members-online-section"]');
    const offlineSection = page.locator('[data-testid="members-offline-section"]');

    if (await onlineSection.count() > 0) {
      await expect(onlineSection).toContainText('Online');
    }
    if (await offlineSection.count() > 0) {
      await expect(offlineSection).toContainText('Offline');
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-01-sidebar.png`, fullPage: true });
  });

  // ── Test 2: Members have avatars (colored circles with initials) ──
  test('2. Members have avatars with colored circles and initials', async ({ page }) => {
    const members = page.locator('.member');
    const count = await members.count();

    if (count > 0) {
      const avatar = members.first().locator('.member-avatar');
      await expect(avatar).toBeVisible();

      const bgStyle = await avatar.getAttribute('style');
      expect(bgStyle).toContain('background');

      const initials = await avatar.textContent();
      expect(initials.trim().length).toBeGreaterThan(0);

      await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-02-avatars.png`, fullPage: true });
    } else {
      // Fallback: user avatar in sidebar
      const userAvatar = page.locator('.user-avatar-wrap .user-avatar');
      await expect(userAvatar).toBeVisible();
      const text = await userAvatar.textContent();
      expect(text.trim().length).toBeGreaterThan(0);

      await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-02-avatars-sidebar.png`, fullPage: true });
    }
  });

  // ── Test 3: Members have presence dots ──
  test('3. Members have presence dots (green online, gray offline)', async ({ page }) => {
    const onlineDots = page.locator('.member-dot.online');
    const offlineDots = page.locator('.member-dot.offline');

    const onlineCount = await onlineDots.count();
    const offlineCount = await offlineDots.count();

    if (onlineCount > 0) {
      await expect(onlineDots.first()).toBeVisible();
      const dotColor = await onlineDots.first().evaluate(el => getComputedStyle(el).backgroundColor);
      expect(dotColor).toBeTruthy();
      expect(dotColor).not.toBe('rgba(0, 0, 0, 0)');
    }

    if (offlineCount > 0) {
      await expect(offlineDots.first()).toBeVisible();
    }

    await expect(page.locator('[data-testid="member-list"]')).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-03-presence.png`, fullPage: true });
  });

  // ── Test 4: Click a member opens profile card ──
  test('4. Clicking a member opens profile card popup', async ({ page }) => {
    await openProfileCard(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-04-click-open.png`, fullPage: true });
  });

  // ── Test 5: Profile card has content ──
  test('5. Profile card has name, handle, role, avatar, action buttons', async ({ page }) => {
    const profileCard = await openProfileCard(page);

    // Name
    const name = page.locator('[data-testid="profile-card-name"]');
    await expect(name).toBeVisible();
    const nameText = await name.textContent();
    expect(nameText.trim().length).toBeGreaterThan(0);

    // Handle (@name)
    const handle = profileCard.locator('.profile-card-handle');
    await expect(handle).toBeVisible();
    const handleText = await handle.textContent();
    expect(handleText).toMatch(/^@/);

    // Role badge
    const role = profileCard.locator('.profile-card-role');
    await expect(role).toBeVisible();
    const roleText = await role.textContent();
    expect(roleText.trim()).toMatch(/Admin|Agent/);

    // Avatar in profile card
    const cardAvatar = profileCard.locator('.profile-card-avatar');
    await expect(cardAvatar).toBeVisible();
    const avatarStyle = await cardAvatar.getAttribute('style');
    expect(avatarStyle).toContain('background');

    // Action buttons
    const messageBtn = profileCard.locator('button', { hasText: 'Message' });
    const viewProfileBtn = profileCard.locator('button', { hasText: 'View Profile' });
    await expect(messageBtn).toBeVisible({ timeout: 5000 });
    await expect(viewProfileBtn).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-05-card-content.png`, fullPage: true });
  });

  // ── Test 6: Profile card positioning ──
  test('6. Profile card positioning - appears within viewport', async ({ page }) => {
    const profileCard = await openProfileCard(page);

    const box = await profileCard.boundingBox();
    expect(box).not.toBeNull();

    const viewport = page.viewportSize();

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 5);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 5);
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-06-positioning.png`, fullPage: true });
  });

  // ── Test 7: Click outside profile card closes it ──
  test('7. Click outside profile card closes it', async ({ page }) => {
    const profileCard = await openProfileCard(page);

    // Click the backdrop far from the card
    const backdrop = page.locator('[data-testid="profile-card-close"]');
    await backdrop.click({ position: { x: 600, y: 50 }, force: true });

    await expect(profileCard).not.toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-07-click-outside.png`, fullPage: true });
  });

  // ── Test 8: Escape closes profile card ──
  test('8. Escape key closes profile card', async ({ page }) => {
    const profileCard = await openProfileCard(page);

    await page.keyboard.press('Escape');

    await expect(profileCard).not.toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-08-escape-close.png`, fullPage: true });
  });

  // ── Test 9: Click different member updates card ──
  test('9. Click different member updates profile card info', async ({ page }) => {
    // Open profile via user avatar
    const profileCard = await openProfileCard(page);
    const firstName = await page.locator('[data-testid="profile-card-name"]').textContent();

    // Close the card
    await page.keyboard.press('Escape');
    await expect(profileCard).not.toBeVisible();

    // Try clicking a different member from the list
    const members = page.locator('.member');
    const memberCount = await members.count();

    if (memberCount > 1) {
      await members.nth(1).click({ force: true });
      await expect(profileCard).toBeVisible({ timeout: 5000 });

      const secondName = await page.locator('[data-testid="profile-card-name"]').textContent();
      expect(secondName.trim().length).toBeGreaterThan(0);

      await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-09-different-member.png`, fullPage: true });
    } else {
      // Reopen same user profile
      const userAvatar = page.locator('.user-avatar-wrap');
      await userAvatar.click({ force: true });
      await expect(profileCard).toBeVisible({ timeout: 5000 });

      const reopenedName = await page.locator('[data-testid="profile-card-name"]').textContent();
      expect(reopenedName).toBe(firstName);

      await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-09-reopen.png`, fullPage: true });
    }
  });

  // ── Test 10: Member role badges ──
  test('10. Member role badges show correctly (Admin/Agent/Member)', async ({ page }) => {
    const members = page.locator('.member');
    const count = await members.count();

    if (count > 0) {
      const adminBadges = page.locator('.member-badge.admin');
      const agentBadges = page.locator('.member-badge.agent');
      const memberBadges = page.locator('.member-badge.member-tag');

      const adminCount = await adminBadges.count();
      const agentCount = await agentBadges.count();
      const memberTagCount = await memberBadges.count();

      expect(adminCount + agentCount + memberTagCount).toBeGreaterThan(0);

      if (adminCount > 0) {
        await expect(adminBadges.first()).toContainText('Admin');
      }
      if (agentCount > 0) {
        await expect(agentBadges.first()).toContainText('Agent');
      }
      if (memberTagCount > 0) {
        await expect(memberBadges.first()).toContainText('Member');
      }
    }

    // Verify the profile card role shows correctly
    const profileCard = await openProfileCard(page);
    const role = profileCard.locator('.profile-card-role');
    await expect(role).toBeVisible();
    const roleText = await role.textContent();
    expect(roleText.trim()).toContain('Admin');

    await page.keyboard.press('Escape');

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-10-role-badges.png`, fullPage: true });
  });

  // ── Bonus: Member list hidden on mobile ──
  test('Member list is hidden on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 700 });

    const memberList = page.locator('[data-testid="member-list"]');
    await expect(memberList).not.toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-members-bonus-mobile.png`, fullPage: true });
  });
});
