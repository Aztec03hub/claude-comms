/**
 * Diagnostic: Add logging directly to the mqtt store's message handler
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
  await page.waitForTimeout(3000);

  // Inspect the store directly
  const storeInfo = await page.evaluate(() => {
    // Svelte 5 stores aren't easily accessible from outside
    // But we can check the DOM for the connection status
    const status = document.querySelector('[data-testid="connection-status"]');
    const emptyState = document.querySelector('.empty-state');
    return {
      statusText: status?.textContent || 'no status element',
      hasEmptyState: !!emptyState,
    };
  });
  console.log('Store info:', JSON.stringify(storeInfo));

  // Signal ready
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Signaled ready. Sending a message from the UI first...');

  // Try sending a message from the UI to see if LOCAL messages work
  const input = page.locator('[data-testid="message-input"]');
  await input.click();
  await input.fill('LOCAL-TEST: Message from browser');
  await page.locator('[data-testid="send-button"]').click();
  await page.waitForTimeout(1000);

  const localCheck = await page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-id]');
    return {
      messageCount: msgs.length,
      texts: Array.from(msgs).map(el => el.textContent?.substring(0, 80)),
    };
  });
  console.log('After local send:', JSON.stringify(localCheck));

  // Now wait for MCP messages
  console.log('Waiting 20s for MCP messages...');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);

    const state = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-id]');
      return {
        messageCount: msgs.length,
        bodyHasCrosstest: document.body.textContent.includes('CROSSTEST'),
        texts: Array.from(msgs).map(el => el.textContent?.substring(0, 100)),
      };
    });

    if (i % 3 === 0) {
      console.log(`[${i+1}s]`, JSON.stringify(state));
    }

    if (state.bodyHasCrosstest) {
      console.log('MCP message found!');
      break;
    }
  }

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });

  // Print filtered console logs
  const mqttLogs = consoleLogs.filter(l =>
    l.includes('MQTT') || l.includes('mqtt') || l.includes('message') ||
    l.includes('error') || l.includes('Error') || l.includes('parse') ||
    l.includes('handle')
  );
  console.log('\nRelevant logs:');
  mqttLogs.forEach(l => console.log('  ' + l));

  await browser.close();
}

run().catch(err => console.error(err));
