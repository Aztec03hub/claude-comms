import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCKUPS = join(__dirname, '..', 'mockups');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

  // Wait much longer for retained message flood to clear
  console.log('Waiting 15s for retained messages to clear...');
  await page.waitForTimeout(15000);

  // NOW signal ready (after retained flood is done)
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Signaled ready. Waiting for MCP message...');

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const cnt = await page.locator('.msg-row').count();
    if (i % 5 === 0) {
      const chatMsgs = logs.filter(l => l.includes('conv/general/messages'));
      console.log(`[${i+1}s] msg-rows: ${cnt}, MQTT chat msgs: ${chatMsgs.length}`);
    }
    if (cnt > 0) {
      console.log(`Messages appeared at ${i+1}s!`);
      break;
    }
  }

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });

  // Print chat message logs
  const chatMsgs = logs.filter(l => l.includes('conv/general/messages'));
  console.log('\nChat message logs:', chatMsgs.length);
  chatMsgs.forEach(l => console.log('  ' + l));

  await browser.close();
}
run().catch(console.error);
