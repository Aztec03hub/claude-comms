import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCKUPS = join(__dirname, '..', 'mockups');

async function run() {
  const browser = await chromium.launch({ headless: true });
  // Clear browser cache
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    bypassCSP: true,
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  // Use cache buster
  console.log('Loading page with cache bust...');
  await page.goto('http://localhost:5173/?t=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  // Check what version of the store is loaded
  const hasSpreadFix = await page.evaluate(async () => {
    const res = await fetch('/src/lib/mqtt-store.svelte.js');
    const text = await res.text();
    return text.includes('spread assignment');
  });
  console.log('Store has spread fix:', hasSpreadFix);

  // Signal ready
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Signaled ready...');

  // Wait for messages
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    const cnt = await page.locator('.msg-row').count();
    if (i % 3 === 0) console.log(`[${i+1}s] msg-rows: ${cnt}`);
    if (cnt > 0) {
      console.log(`Messages appeared at ${i+1}s!`);
      break;
    }
  }

  // Check MQTT message debug logs
  const chatMsgs = logs.filter(l => l.includes('conv/general/messages'));
  console.log(`\nMQTT chat messages received: ${chatMsgs.length}`);
  chatMsgs.forEach(l => console.log('  ' + l));

  // Check for handleChatMessage logs
  const handleLogs = logs.filter(l => l.includes('handleChatMessage') || l.includes('pushed'));
  console.log(`handleChatMessage logs: ${handleLogs.length}`);
  handleLogs.forEach(l => console.log('  ' + l));

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });
  await browser.close();
}
run().catch(console.error);
