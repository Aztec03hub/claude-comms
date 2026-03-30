/**
 * Diagnostic: check if Svelte event handling works
 */
import { chromium } from '@playwright/test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCKUPS = join(__dirname, '..', 'mockups');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  // Check if the input exists and works
  const input = page.locator('[data-testid="message-input"]');
  console.log('Input visible:', await input.isVisible());
  console.log('Input placeholder:', await input.getAttribute('placeholder'));

  // Try dispatching events manually via evaluate
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="message-input"]');
    if (!input) { console.log('INPUT NOT FOUND'); return; }

    // Set value and dispatch input event
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSet.call(input, 'EVAL-TEST: sent via evaluate');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('Dispatched input event, value:', input.value);

    // Now dispatch Enter keydown
    setTimeout(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
      input.dispatchEvent(event);
      console.log('Dispatched Enter keydown');
    }, 200);
  });

  await page.waitForTimeout(2000);

  const msgCount = await page.locator('.msg-row').count();
  console.log('msg-row count:', msgCount);

  const inputVal = await input.inputValue();
  console.log('Input value after send:', JSON.stringify(inputVal));

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });

  consoleLogs.forEach(l => console.log('  LOG:', l));

  await browser.close();
}

run().catch(err => console.error(err));
