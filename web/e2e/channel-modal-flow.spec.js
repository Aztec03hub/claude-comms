import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups';

// Use a single test with sequential steps to avoid repeated page loads
// which are extremely slow on this WSL2 + Vite dev server environment.
test.setTimeout(300000);

test('Channel creation modal — full flow (11 checks)', async ({ page }) => {
  // Use baseURL from playwright.config.js (port 5175)
  await page.goto('/', { timeout: 60000 });
  await page.locator('[data-testid="sidebar"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(500);

  // Helper: open the modal and wait for it to be visible
  async function openModal() {
    const btn = page.locator('[data-testid="sidebar-create-channel"]');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();
    await expect(page.locator('[data-testid="channel-modal"]')).toBeVisible({ timeout: 10000 });
  }

  // ── 1. Open modal with blur backdrop ──────────────────────────────────
  const createBtn = page.locator('[data-testid="sidebar-create-channel"]');
  await expect(createBtn).toBeVisible();
  await expect(createBtn).toContainText('New Conversation');
  await createBtn.click();

  const modal = page.locator('[data-testid="channel-modal"]');
  await expect(modal).toBeVisible();

  const backdropFilter = await modal.evaluate(el => getComputedStyle(el).backdropFilter);
  expect(backdropFilter).toContain('blur');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-01-opened.png`, fullPage: true });
  console.log('PASS: 1. Modal opens with blur backdrop');

  // ── 2. Modal has all fields ───────────────────────────────────────────
  await expect(page.locator('[data-testid="channel-modal-name-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="channel-modal-name-input"]')).toHaveAttribute('type', 'text');
  await expect(page.locator('[data-testid="channel-modal-description"]')).toBeVisible();
  await expect(page.locator('[data-testid="channel-modal-private-toggle"]')).toBeVisible();
  await expect(page.locator('[data-testid="channel-modal-private-toggle"]')).toHaveAttribute('role', 'switch');
  await expect(page.locator('[data-testid="channel-modal-cancel"]')).toBeVisible();
  await expect(page.locator('[data-testid="channel-modal-cancel"]')).toHaveText('Cancel');
  await expect(page.locator('[data-testid="channel-modal-create"]')).toBeVisible();
  await expect(page.locator('[data-testid="channel-modal-create"]')).toHaveText('Create Channel');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-02-fields.png`, fullPage: true });
  console.log('PASS: 2. Modal has all required fields and buttons');

  // ── 3. Type channel name ──────────────────────────────────────────────
  const nameInput = page.locator('[data-testid="channel-modal-name-input"]');
  await nameInput.click();
  await nameInput.fill('my-test-channel');
  await expect(nameInput).toHaveValue('my-test-channel');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-03-name-typed.png`, fullPage: true });
  console.log('PASS: 3. Name input accepts text');

  // ── 4. Type description ───────────────────────────────────────────────
  const descTextarea = page.locator('[data-testid="channel-modal-description"]');
  await descTextarea.click();
  await descTextarea.fill('This is a test channel for discussions');
  await expect(descTextarea).toHaveValue('This is a test channel for discussions');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-04-description-typed.png`, fullPage: true });
  console.log('PASS: 4. Description textarea accepts text');

  // ── 5. Toggle private switch ──────────────────────────────────────────
  const toggle = page.locator('[data-testid="channel-modal-private-toggle"]');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).not.toHaveClass(/active/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveClass(/active/);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-05-toggle-on.png`, fullPage: true });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).not.toHaveClass(/active/);
  console.log('PASS: 5. Private toggle switches on and off');

  // ── 6. Cancel closes modal ────────────────────────────────────────────
  await page.locator('[data-testid="channel-modal-cancel"]').click();
  await expect(modal).not.toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-06-cancel-closed.png`, fullPage: true });
  console.log('PASS: 6. Cancel button closes modal');

  // ── 7. Backdrop click closes modal ────────────────────────────────────
  await openModal();

  const viewportSize = page.viewportSize();
  await page.mouse.click(viewportSize.width - 5, 5);
  await expect(page.locator('[data-testid="channel-modal"]')).not.toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-07-backdrop-closed.png`, fullPage: true });
  console.log('PASS: 7. Backdrop click closes modal');

  // ── 8. Escape closes modal ────────────────────────────────────────────
  await openModal();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="channel-modal"]')).not.toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-08-escape-closed.png`, fullPage: true });
  console.log('PASS: 8. Escape closes modal');

  // ── 9. Create channel ─────────────────────────────────────────────────
  await openModal();

  const nameInput2 = page.locator('[data-testid="channel-modal-name-input"]');
  await nameInput2.click();
  await nameInput2.fill('test-create-flow');

  const descInput2 = page.locator('[data-testid="channel-modal-description"]');
  await descInput2.click();
  await descInput2.fill('Testing channel creation');

  await page.locator('[data-testid="channel-modal-create"]').click();
  await expect(page.locator('[data-testid="channel-modal"]')).not.toBeVisible();
  await expect(page.locator('[data-testid="channel-item-test-create-flow"]')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-09-channel-created.png`, fullPage: true });
  console.log('PASS: 9. Create channel adds it to sidebar and closes modal');

  // ── 10. New channel is active after creation ──────────────────────────
  await openModal();

  const nameInput3 = page.locator('[data-testid="channel-modal-name-input"]');
  await nameInput3.click();
  await nameInput3.fill('active-test-ch');
  await page.locator('[data-testid="channel-modal-create"]').click();

  await expect(page.locator('[data-testid="channel-modal"]')).not.toBeVisible();

  const newChannel = page.locator('[data-testid="channel-item-active-test-ch"]');
  await expect(newChannel).toBeVisible({ timeout: 5000 });
  await expect(newChannel).toHaveClass(/active/);
  await expect(page.locator('[data-testid="header-channel-name"]')).toHaveText('active-test-ch');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-10-channel-active.png`, fullPage: true });
  console.log('PASS: 10. New channel is selected and active');

  // ── 11. Empty name validation ─────────────────────────────────────────
  const originalChannel = await page.locator('[data-testid="header-channel-name"]').textContent();

  await openModal();

  // Empty name -- click Create -- modal should stay open
  await page.locator('[data-testid="channel-modal-create"]').click();
  await expect(page.locator('[data-testid="channel-modal"]')).toBeVisible();

  // Spaces only
  const nameInput4 = page.locator('[data-testid="channel-modal-name-input"]');
  await nameInput4.click();
  await nameInput4.fill('   ');
  await page.locator('[data-testid="channel-modal-create"]').click();
  await expect(page.locator('[data-testid="channel-modal"]')).toBeVisible();

  // Special chars only (sanitizes to empty)
  await nameInput4.click();
  await nameInput4.fill('!!!');
  await page.locator('[data-testid="channel-modal-create"]').click();
  await expect(page.locator('[data-testid="channel-modal"]')).toBeVisible();

  // Close and verify no channel change
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="channel-modal"]')).not.toBeVisible();
  await expect(page.locator('[data-testid="header-channel-name"]')).toHaveText(originalChannel);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/test-modal-11-empty-validation.png`, fullPage: true });
  console.log('PASS: 11. Empty name validation works');

  console.log('\nAll 11 channel modal checks passed.');
});
