import { chromium } from '@playwright/test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCKUPS = join(__dirname, '..', 'mockups');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  // Use Playwright's built-in type() which simulates real keyboard input
  const input = page.locator('[data-testid="message-input"]');
  await input.click();
  // Use type() not fill() -- type dispatches individual key events
  await page.keyboard.type('PW-TYPE-TEST: Using Playwright keyboard.type', { delay: 5 });
  await page.waitForTimeout(500);

  // Check input value
  console.log('Input value:', await input.inputValue());

  // Use Playwright's keyboard.press for Enter
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  console.log('After Enter:');
  console.log('  Input value:', await input.inputValue());
  console.log('  msg-row count:', await page.locator('.msg-row').count());
  console.log('  empty-state:', await page.locator('.empty-state').count());

  // If that didn't work, try clicking the send button
  if (await page.locator('.msg-row').count() === 0) {
    console.log('\nTrying send button click...');
    await input.click();
    await page.keyboard.type('PW-CLICK-TEST: Using button click', { delay: 5 });
    await page.waitForTimeout(300);
    await page.locator('[data-testid="send-button"]').click();
    await page.waitForTimeout(2000);

    console.log('After button click:');
    console.log('  Input value:', await input.inputValue());
    console.log('  msg-row count:', await page.locator('.msg-row').count());
  }

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });
  await browser.close();
}
run().catch(console.error);
