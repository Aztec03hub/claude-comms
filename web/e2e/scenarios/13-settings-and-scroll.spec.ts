// 13-settings-and-scroll.spec.ts — ports the last unique legacy-e2e bits.
//
//   - settings: display-name change persists to localStorage and the 50-char
//     max length is enforced (from the deleted settings-panel.spec.js).
//   - scroll-to-bottom: the button appears when the chat view is scrolled up
//     and returns the view to the bottom (from the deleted round8-edge-cases).
//
// The chat view (data-testid="chat-view") is itself the scroll container; we
// seed #general with enough messages to overflow the viewport.

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { canonicalSeed, PHIL, SeedSpec } from '../fixtures/seedData';

const base = canonicalSeed();
const bulk = Array.from({ length: 60 }, (_, i) => ({
  conv: 'general',
  sender: PHIL,
  body: `scroll line ${i + 1}`,
}));
const seed: SeedSpec = { ...base, messages: [...base.messages, ...bulk] };

test.use({ slot: 12, seedSpec: seed });

async function openGeneral(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
}

async function openSettings(appPage: import('@playwright/test').Page) {
  await openGeneral(appPage);
  await appPage.locator('[data-testid="chat-header-settings-btn"]').click();
  await expect(appPage.locator('[data-testid="settings-panel"]')).toBeVisible();
}

test.describe('Scenario 13: settings persistence + scroll-to-bottom', () => {
  test('display-name change persists to localStorage', async ({ appPage, consoleErrors }) => {
    await openSettings(appPage);
    await appPage.locator('#settings-display-name').fill('phil-renamed');
    // The rename is debounced and the "saved" badge is transient -- SettingsPanel
    // calls setStatus('saved', ..., SAVED_FADE_MS), which fades the status back to
    // 'idle' after 1.5s. Racing that fading badge is flaky on slow CI (the debounce
    // delay can push the save past the window we sample). This test's real intent
    // is "persists to localStorage", so assert that deterministic end-state: poll
    // localStorage until the persisted display name lands (it is written right
    // before the 'saved' badge in commitNameChange -> persistLocally).
    await expect
      .poll(
        () => appPage.evaluate(() => localStorage.getItem('claude-comms-user-name')),
        { timeout: 10000 },
      )
      .toBe('phil-renamed');
    assertNoConsoleErrors(consoleErrors);
  });

  test('display-name input enforces the 50-char max length', async ({ appPage, consoleErrors }) => {
    await openSettings(appPage);
    const input = appPage.locator('#settings-display-name');
    await input.fill('x'.repeat(60));
    await expect(input).toHaveValue('x'.repeat(50));
    assertNoConsoleErrors(consoleErrors);
  });

  test('scroll-to-bottom appears when scrolled up and returns to bottom', async ({ appPage, consoleErrors }) => {
    await openGeneral(appPage);
    const chat = appPage.locator('[data-testid="chat-view"]');
    const btn = appPage.locator('[data-testid="scroll-to-bottom"]');

    // The view auto-scrolls to the bottom on load, so the button starts hidden.
    await expect(btn).toHaveCount(0);

    // Scroll to the top: the onscroll handler flips isAtBottom -> shows the btn.
    await chat.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(btn).toBeVisible();

    // Clicking returns to the bottom and the button hides again.
    await btn.click();
    await expect(btn).toHaveCount(0);
    assertNoConsoleErrors(consoleErrors);
  });
});
