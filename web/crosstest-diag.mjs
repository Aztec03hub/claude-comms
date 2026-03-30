/**
 * Diagnostic: check if messages exist in store but DOM hasn't updated
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

  // Expose store on window before page loads
  await page.addInitScript(() => {
    // Monkey-patch to expose the store
    window.__exposeStore = (store) => {
      window.__store = store;
      console.log('[DIAG] Store exposed on window.__store');
    };
  });

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  // We can't easily access the store from the outside unless we modify App.svelte.
  // Let's temporarily add a window exposure.

  // Instead, let's add a console.log to the store's handleChatMessage to trace
  // Let's modify the store file to add debug logging

  // Actually, let's check if messages are being received but the channel filter is wrong.
  // The activeMessages derived filters: m.channel === this.activeChannel
  // activeChannel is 'general'.
  // But messages might have channel = undefined or something else.

  // Let's send a message via MCP and check the raw MQTT topic/payload
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Signaled ready. Waiting for MCP message...');

  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    // Check console for message receipt
    const received = consoleLogs.filter(l => l.includes('conv/general/messages'));
    if (received.length > 0 && i > 3) {
      console.log(`[${i+1}s] Messages received via MQTT: ${received.length}`);
      break;
    }
  }

  // Now check all console logs
  const allLogs = consoleLogs.filter(l => l.includes('claude-comms'));
  console.log('\nAll claude-comms logs:');
  allLogs.slice(0, 20).forEach(l => console.log('  ' + l));

  // Check DOM
  console.log('\nmsg-row count:', await page.locator('.msg-row').count());
  console.log('empty-state:', await page.locator('.empty-state').count());

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });
  await browser.close();
}

run().catch(err => console.error(err));
