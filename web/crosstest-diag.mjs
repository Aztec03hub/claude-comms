/**
 * Quick diagnostic: verify send from UI works after fix
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

  // Try sending from UI
  const input = page.locator('[data-testid="message-input"]');
  await input.click();
  await input.pressSequentially('DIAG-FIX: Testing after fix', { delay: 20 });
  await input.press('Enter');
  await page.waitForTimeout(2000);

  const msgCount = await page.locator('.msg-row').count();
  console.log('msg-row count after send:', msgCount);

  const inputVal = await input.inputValue();
  console.log('Input cleared:', inputVal === '');

  const bodyText = await page.textContent('body');
  console.log('Has DIAG-FIX:', bodyText.includes('DIAG-FIX'));

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });

  // Check for debug MQTT logs
  const mqttLogs = consoleLogs.filter(l => l.includes('claude-comms'));
  console.log('\nMQTT debug logs (first 10):');
  mqttLogs.slice(0, 10).forEach(l => console.log('  ' + l));

  // Errors
  const errors = consoleLogs.filter(l => l.includes('[error]'));
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(l => console.log('  ' + l));
  }

  await browser.close();
}

run().catch(err => console.error(err));
