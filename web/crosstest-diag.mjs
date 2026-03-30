/**
 * Diagnostic: use page.evaluate to dispatch a properly-constructed event
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';
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

  // Type text using native setter + input event (works with Svelte 5 bindings)
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="message-input"]');
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, 'EVALTEST: Hello from evaluate');
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);

  // Check if Svelte 5 picked up the value
  const val1 = await page.locator('[data-testid="message-input"]').inputValue();
  console.log('After input event, value:', val1);

  // Now simulate Enter with a proper KeyboardEvent
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="message-input"]');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    });
    input.dispatchEvent(event);
  });
  await page.waitForTimeout(1000);

  const val2 = await page.locator('[data-testid="message-input"]').inputValue();
  console.log('After Enter, value:', val2);
  console.log('Input cleared:', val2 === '');

  const msgCount = await page.locator('.msg-row').count();
  console.log('msg-row count:', msgCount);

  // If still no message, try clicking send button with a real click
  if (msgCount === 0) {
    console.log('\nTrying send button click via evaluate...');

    // Re-set the value since it was cleared
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="message-input"]');
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, 'EVALTEST2: Click send');
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);

    // Click send button
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="send-button"]');
      btn.click();
    });
    await page.waitForTimeout(1000);

    const val3 = await page.locator('[data-testid="message-input"]').inputValue();
    console.log('After button click, value:', val3);
    console.log('msg-row count:', await page.locator('.msg-row').count());
  }

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });

  // Check for MQTT message publish
  const published = consoleLogs.filter(l => l.includes('conv/general/messages'));
  console.log('\nMQTT messages published:', published.length);
  published.forEach(l => console.log('  ' + l));

  // Check errors
  consoleLogs.filter(l => l.includes('[error]') && !l.includes('CORS') && !l.includes('9920')).forEach(l => console.log('ERR:', l));

  await browser.close();
}

run().catch(err => console.error(err));
