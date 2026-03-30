import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups';

// Generous timeouts for dev server + MQTT connections
test.setTimeout(90000);

// Helper: navigate and wait for the app shell to render
async function loadApp(page, url = '/') {
  // Retry navigation if needed - dev server can be slow with HMR
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="chat-header"]') !== null,
        { timeout: 15000 }
      );
      await page.waitForTimeout(300);
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log(`Load attempt ${attempt + 1} failed, retrying...`);
      await page.waitForTimeout(2000);
    }
  }
}

test.describe('Theme Toggle', () => {
  test('default theme is dark mode', async ({ page }) => {
    await loadApp(page);

    const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    console.log('Body background color:', bgColor);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-dark-default.png`, fullPage: true });

    const match = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(match).toBeTruthy();
    const [, r, g, b] = match.map(Number);
    expect(r).toBeLessThan(30);
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });

  test('theme toggle switches to light mode', async ({ page }) => {
    await loadApp(page);

    const toggle = page.locator('[data-testid="theme-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-theme-dark.png`, fullPage: true });

    // Click to switch to light mode
    await toggle.click();
    await page.waitForTimeout(500);

    const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(themeAttr).toBe('light');

    const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    console.log('Light mode bg:', bgLight);
    const matchLight = bgLight.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(matchLight).toBeTruthy();
    expect(Number(matchLight[1])).toBeGreaterThan(200);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-theme-light.png`, fullPage: true });
  });

  test('theme toggle switches back to dark mode', async ({ page }) => {
    await loadApp(page);

    // Use evaluate to click - avoids stale references from HMR reloads
    await page.evaluate(() => {
      document.querySelector('[data-testid="theme-toggle"]').click();
    });
    await page.waitForTimeout(500);

    // Verify we're in light mode
    const lightTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(lightTheme).toBe('light');

    // Click again to go back to dark
    await page.evaluate(() => {
      document.querySelector('[data-testid="theme-toggle"]').click();
    });
    await page.waitForTimeout(500);

    const darkAgain = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(darkAgain).toBe('dark');

    const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    console.log('Dark again bg:', bgDark);
    const matchDark = bgDark.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(matchDark).toBeTruthy();
    expect(Number(matchDark[1])).toBeLessThan(30);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-theme-dark-again.png`, fullPage: true });
  });
});

test.describe('Responsive Layout', () => {
  test('1920x1080 - all 3 columns visible', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await loadApp(page);

    const sidebar = page.locator('[data-testid="sidebar"]');
    const memberList = page.locator('[data-testid="member-list"]');

    await expect(sidebar).toBeVisible({ timeout: 10000 });
    await expect(memberList).toBeVisible({ timeout: 10000 });

    const sidebarBox = await sidebar.boundingBox();
    const memberBox = await memberList.boundingBox();
    const headerBox = await page.locator('[data-testid="chat-header"]').boundingBox();

    console.log('1920: sidebar=%d, members=%d, chat=%d', sidebarBox?.width, memberBox?.width, headerBox?.width);

    expect(sidebarBox.width).toBeGreaterThan(200);
    expect(memberBox.width).toBeGreaterThan(150);
    expect(headerBox.width).toBeGreaterThan(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-1920x1080.png`, fullPage: true });
  });

  test('1024x768 - still 3 columns', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await loadApp(page);

    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="member-list"]')).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-1024x768.png`, fullPage: true });
  });

  test('768x1024 tablet - member list still visible', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await loadApp(page);

    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 10000 });
    const memberVisible = await page.locator('[data-testid="member-list"]').isVisible();
    console.log('768x1024 - Member list visible:', memberVisible);
    expect(memberVisible).toBe(true);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-768x1024.png`, fullPage: true });
  });

  test('480x800 mobile - sidebar and member list hidden', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await loadApp(page);

    expect(await page.locator('[data-testid="member-list"]').isVisible()).toBe(false);
    expect(await page.locator('[data-testid="sidebar"]').isVisible()).toBe(false);

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    console.log('480x800 - Body scroll width:', bodyWidth);
    expect(bodyWidth).toBeLessThanOrEqual(485);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-480x800.png`, fullPage: true });
  });

  test('320x568 small mobile - no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await loadApp(page);

    expect(await page.locator('[data-testid="member-list"]').isVisible()).toBe(false);
    expect(await page.locator('[data-testid="sidebar"]').isVisible()).toBe(false);

    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    console.log('320x568 - Body scroll width:', bodyScrollWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(325);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-320x568.png`, fullPage: true });
  });

  test('resize 1440 to 480 transition', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loadApp(page);

    await expect(page.locator('[data-testid="member-list"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-resize-wide-1440.png`, fullPage: true });

    // Resize to narrow
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(600);

    expect(await page.locator('[data-testid="member-list"]').isVisible()).toBe(false);
    expect(await page.locator('[data-testid="sidebar"]').isVisible()).toBe(false);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/test-responsive-resize-narrow-480.png`, fullPage: true });
  });
});
