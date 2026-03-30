/**
 * Diagnostic: send MCP message, open page, check if it arrives
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

  // Wait for MQTT connection
  await page.waitForTimeout(4000);

  // Signal ready
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Signaled ready. Will wait 15s for MCP messages...');

  // Wait for messages
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);

    // Check all text in message elements
    const allText = await page.evaluate(() => {
      const msgs = document.querySelectorAll('.msg-body, .message-body, .message-content, .bubble-body');
      return Array.from(msgs).map(el => el.textContent).join(' | ');
    });

    if (allText.length > 0) {
      console.log(`[${i+1}s] Messages found: ${allText.substring(0, 200)}`);
    }

    // Also check the entire body for our marker
    const bodyText = await page.textContent('body');
    if (bodyText.includes('CROSSTEST-DIAG')) {
      console.log(`[${i+1}s] FOUND CROSSTEST-DIAG in body!`);
      break;
    }

    // Debug: count message elements by various selectors
    const counts = await page.evaluate(() => {
      return {
        'msg-body': document.querySelectorAll('.msg-body').length,
        'message-body': document.querySelectorAll('.message-body').length,
        'message-bubble': document.querySelectorAll('.message-bubble').length,
        'msg-group': document.querySelectorAll('.msg-group').length,
        'data-testid-msg': document.querySelectorAll('[data-testid="message-bubble"]').length,
      };
    });
    console.log(`[${i+1}s] Element counts:`, JSON.stringify(counts));
  }

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png'), fullPage: false });

  // Print all console logs
  consoleLogs.forEach(l => console.log('  LOG: ' + l));

  await browser.close();
}

run().catch(err => console.error(err));
