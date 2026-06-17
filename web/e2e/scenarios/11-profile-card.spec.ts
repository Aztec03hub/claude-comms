// 11-profile-card.spec.ts - profile-card open/close flow.
//
// Ports the unique profile-card coverage from the deleted legacy
// overnight-members-theme.spec.js (R1-R2). Clicking a member row in the
// member list opens the ProfileCard with the member's name; backdrop
// click and Escape both dismiss it. Escape is handled by App.svelte's
// global keydown handler in panel-priority order (App.svelte ~:491).
//
// Uses PHIL (the default e2e identity) as the target so the row is always
// present + online; the card mechanics are identity-agnostic.

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { canonicalSeed, PHIL } from '../fixtures/seedData';

// Slot 10 = first free slot after scenarios 01-10 (0-9). MQTT ports are
// fixed (1883/9001); workers:1 keeps them conflict-free.
test.use({ slot: 10, seedSpec: canonicalSeed() });

async function openOwnProfile(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
  await appPage.waitForSelector('[data-testid="member-list"]');
  const row = appPage.locator(`[data-testid="member-${PHIL.key}"]`);
  await expect(row).toBeVisible();
  await row.click();
  const card = appPage.locator('[data-testid="profile-card"]');
  await expect(card).toBeVisible();
  return card;
}

test.describe('Scenario 11: profile card', () => {
  test('clicking a member opens the profile card with their name', async ({ appPage, consoleErrors }) => {
    await openOwnProfile(appPage);
    await expect(appPage.locator('[data-testid="profile-card-name"]')).toHaveText(PHIL.name);
    assertNoConsoleErrors(consoleErrors);
  });

  test('clicking the backdrop dismisses the card', async ({ appPage, consoleErrors }) => {
    await openOwnProfile(appPage);
    // Click the backdrop corner (away from the centered card) to fire onClose.
    await appPage.locator('[data-testid="profile-card-close"]').click({ position: { x: 5, y: 5 } });
    await expect(appPage.locator('[data-testid="profile-card"]')).not.toBeVisible();
    assertNoConsoleErrors(consoleErrors);
  });

  test('Escape dismisses the card (App-global handler)', async ({ appPage, consoleErrors }) => {
    await openOwnProfile(appPage);
    await appPage.keyboard.press('Escape');
    await expect(appPage.locator('[data-testid="profile-card"]')).not.toBeVisible();
    assertNoConsoleErrors(consoleErrors);
  });
});
