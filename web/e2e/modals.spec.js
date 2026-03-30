import { test, expect } from '@playwright/test';

test.describe('Modal interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar"]');
  });

  test('"New Conversation" button opens the channel creation modal', async ({ page }) => {
    await page.locator('[data-testid="sidebar-create-channel"]').click();

    const modal = page.locator('[data-testid="channel-modal"]');
    await expect(modal).toBeVisible();

    const modalTitle = page.locator('.modal-title');
    await expect(modalTitle).toHaveText('Create Conversation');
  });

  test('modal has name input, description textarea, toggle switch', async ({ page }) => {
    await page.locator('[data-testid="sidebar-create-channel"]').click();

    // Name input
    const nameInput = page.locator('[data-testid="channel-modal-name-input"]');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveAttribute('placeholder', /project-phoenix/);

    // Description textarea
    const textarea = page.locator('[data-testid="channel-modal-description"]');
    await expect(textarea).toBeVisible();

    // Toggle switch
    const toggle = page.locator('[data-testid="channel-modal-private-toggle"]');
    await expect(toggle).toBeVisible();
  });

  test('cancel button closes modal', async ({ page }) => {
    await page.locator('[data-testid="sidebar-create-channel"]').click();
    const modal = page.locator('[data-testid="channel-modal"]');
    await expect(modal).toBeVisible();

    const cancelBtn = page.locator('[data-testid="channel-modal-cancel"]');
    await cancelBtn.click();

    await expect(modal).not.toBeVisible();
  });

  test('clicking overlay backdrop closes modal', async ({ page }) => {
    await page.locator('[data-testid="sidebar-create-channel"]').click();
    const modal = page.locator('[data-testid="channel-modal"]');
    await expect(modal).toBeVisible();

    // Click the overlay (not the inner modal)
    await modal.click({ position: { x: 10, y: 10 } });

    await expect(modal).not.toBeVisible();
  });

  test('escape closes modal', async ({ page }) => {
    await page.locator('[data-testid="sidebar-create-channel"]').click();
    const modal = page.locator('[data-testid="channel-modal"]');
    await expect(modal).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(modal).not.toBeVisible();
  });

  test('create button exists and is clickable', async ({ page }) => {
    await page.locator('[data-testid="sidebar-create-channel"]').click();

    const createBtn = page.locator('[data-testid="channel-modal-create"]');
    await expect(createBtn).toBeVisible();
    await expect(createBtn).toHaveText('Create Channel');

    // Fill in name and click create
    await page.locator('[data-testid="channel-modal-name-input"]').fill('test-channel');
    await createBtn.click();

    // Modal should close after creating
    const modal = page.locator('[data-testid="channel-modal"]');
    await expect(modal).not.toBeVisible();

    // New channel should appear in header (or in sidebar)
    // The channel was created and should be active
    const headerName = page.locator('[data-testid="header-channel-name"]');
    // Check that channel was created in sidebar
    const newChannel = page.locator('[data-testid="channel-item-test-channel"]');
    await expect(newChannel).toBeVisible();
    // Click it to ensure it's active
    await newChannel.click();
    await expect(headerName).toHaveText('test-channel');
  });

  test('toggle switch toggles on click', async ({ page }) => {
    await page.locator('[data-testid="sidebar-create-channel"]').click();

    const toggle = page.locator('[data-testid="channel-modal-private-toggle"]');
    await expect(toggle).not.toHaveClass(/active/);

    await toggle.click();
    await expect(toggle).toHaveClass(/active/);

    await toggle.click();
    await expect(toggle).not.toHaveClass(/active/);
  });
});
