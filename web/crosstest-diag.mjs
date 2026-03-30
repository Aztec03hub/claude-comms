/**
 * Diagnostic: expose store to window and inspect directly
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

  console.log('Loading page...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Expose store by patching it — inject into App.svelte via module scope
  // We can't easily access Svelte 5 component internals from outside.
  // Instead, let's modify the mqtt-store to log message events.

  // Try sending from UI
  const input = page.locator('[data-testid="message-input"]');
  await input.click();
  await input.fill('DIAG-LOCAL: test');
  await page.locator('[data-testid="send-button"]').click();
  await page.waitForTimeout(1500);

  // Check what happened
  const html = await page.locator('[data-testid="chat-view"]').innerHTML();
  console.log('ChatView innerHTML length:', html.length);
  console.log('Contains empty-state:', html.includes('empty-state'));
  console.log('Contains msg-row:', html.includes('msg-row'));
  console.log('First 500 chars:', html.substring(0, 500));

  // If empty-state still shows, the messages array in the store is empty
  // Let's verify by checking the full page for any msg-row elements
  const msgRowCount = await page.locator('.msg-row').count();
  console.log('msg-row count:', msgRowCount);

  // Check if the message was actually sent (look at the UI state)
  const inputVal = await input.inputValue();
  console.log('Input value after send:', JSON.stringify(inputVal));

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });

  // Check for errors
  consoleLogs.filter(l => l.includes('error') || l.includes('Error')).forEach(l => console.log('ERR: ' + l));

  await browser.close();
}

run().catch(err => console.error(err));
