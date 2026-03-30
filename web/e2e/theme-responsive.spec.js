import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups';

test.setTimeout(45000);

// Block Google Fonts to prevent "waiting for fonts" hangs
test.beforeEach(async ({ page }) => {
  await page.route('**/*.googleapis.com/**', route => route.abort());
  await page.route('**/*.gstatic.com/**', route => route.abort());
});

async function loadApp(page, url = '/') {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="chat-header"]') !== null,
    { timeout: 15000 }
  );
  await page.waitForTimeout(200);
}

// Best-effort screenshot - don't fail the test if it times out
async function safeScreenshot(page, name) {
  try {
    await Promise.race([
      page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 8000))
    ]);
  } catch {
    console.log(`Screenshot ${name} skipped (timeout)`);
  }
}

test.describe('Theme Toggle', () => {
  test('default dark and toggles to light and back', async ({ page }) => {
    await loadApp(page);

    // Verify dark mode
    const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    console.log('Default bg:', bgColor);
    expect(Number(bgColor.match(/rgb\((\d+)/)[1])).toBeLessThan(30);

    await safeScreenshot(page, 'test-responsive-dark-default');

    // Toggle to light
    await page.evaluate(() => document.querySelector('[data-testid="theme-toggle"]').click());
    await page.waitForTimeout(300);

    const lightTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(lightTheme).toBe('light');

    const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    console.log('Light bg:', bgLight);
    expect(Number(bgLight.match(/rgb\((\d+)/)[1])).toBeGreaterThan(200);

    await safeScreenshot(page, 'test-responsive-theme-light');

    // Toggle back to dark
    await page.evaluate(() => document.querySelector('[data-testid="theme-toggle"]').click());
    await page.waitForTimeout(300);

    const darkTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(darkTheme).toBe('dark');

    const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    console.log('Dark again bg:', bgDark);
    expect(Number(bgDark.match(/rgb\((\d+)/)[1])).toBeLessThan(30);

    await safeScreenshot(page, 'test-responsive-theme-dark-again');
  });
});

test.describe('Responsive Layout', () => {
  test('1920x1080 all 3 columns', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await loadApp(page);

    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="member-list"]')).toBeVisible({ timeout: 5000 });

    const sb = await page.locator('[data-testid="sidebar"]').boundingBox();
    const ml = await page.locator('[data-testid="member-list"]').boundingBox();
    const ch = await page.locator('[data-testid="chat-header"]').boundingBox();
    console.log('1920: sidebar=%d members=%d chat=%d', sb?.width, ml?.width, ch?.width);
    expect(sb.width).toBeGreaterThan(200);
    expect(ml.width).toBeGreaterThan(150);
    expect(ch.width).toBeGreaterThan(500);

    await safeScreenshot(page, 'test-responsive-1920x1080');
  });

  test('1024x768 still 3 columns', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await loadApp(page);

    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="member-list"]')).toBeVisible({ timeout: 5000 });

    await safeScreenshot(page, 'test-responsive-1024x768');
  });

  test('768x1024 tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await loadApp(page);

    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });
    expect(await page.locator('[data-testid="member-list"]').isVisible()).toBe(true);
    console.log('768x1024 - Member list visible: true');

    await safeScreenshot(page, 'test-responsive-768x1024');
  });

  test('480x800 mobile', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await loadApp(page);

    expect(await page.locator('[data-testid="member-list"]').isVisible()).toBe(false);
    // At mobile widths the sidebar is rendered off-screen (translateX(-100%)) via mobile wrapper
    // so isVisible() may still be true. Check that it's not in viewport instead.
    const sidebarBox = await page.locator('[data-testid="sidebar"]').boundingBox().catch(() => null);
    const sidebarInViewport = sidebarBox && sidebarBox.x + sidebarBox.width > 0;
    expect(sidebarInViewport).toBeFalsy();

    const bw = await page.evaluate(() => document.body.scrollWidth);
    console.log('480x800 scroll width:', bw);
    expect(bw).toBeLessThanOrEqual(485);

    await safeScreenshot(page, 'test-responsive-480x800');
  });

  test('320x568 no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await loadApp(page);

    expect(await page.locator('[data-testid="member-list"]').isVisible()).toBe(false);
    // Sidebar is off-screen at mobile widths via translateX(-100%)
    const sidebarBox = await page.locator('[data-testid="sidebar"]').boundingBox().catch(() => null);
    const sidebarInViewport = sidebarBox && sidebarBox.x + sidebarBox.width > 0;
    expect(sidebarInViewport).toBeFalsy();

    const bw = await page.evaluate(() => document.body.scrollWidth);
    console.log('320x568 scroll width:', bw);
    expect(bw).toBeLessThanOrEqual(325);

    await safeScreenshot(page, 'test-responsive-320x568');
  });

  test('resize 1440 to 480', async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loadApp(page);

    await expect(page.locator('[data-testid="member-list"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 5000 });

    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(500);

    expect(await page.locator('[data-testid="member-list"]').isVisible()).toBe(false);
    // Sidebar slides off-screen via mobile wrapper transform
    const sidebarBox = await page.locator('[data-testid="sidebar"]').boundingBox().catch(() => null);
    const sidebarInViewport = sidebarBox && sidebarBox.x + sidebarBox.width > 0;
    expect(sidebarInViewport).toBeFalsy();

    await safeScreenshot(page, 'test-responsive-resize-narrow-480');
  });
});
