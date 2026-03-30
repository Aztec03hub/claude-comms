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
  await page.waitForTimeout(6000);

  // Signal
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Ready. Waiting for MCP...');

  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const cnt = await page.locator('.msg-row').count();
    const chatLogs = logs.filter(l => l.includes('/messages'));
    if (i % 3 === 0) console.log(`[${i+1}s] rows=${cnt} chatLogs=${chatLogs.length}`);
    if (cnt > 0) { console.log('SUCCESS at ' + (i+1) + 's!'); break; }
  }

  // Print ALL console logs (not just filtered)
  console.log('\nAll console logs (' + logs.length + ' total):');
  logs.slice(0, 50).forEach(l => console.log('  ' + l));

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });
  await browser.close();
}
run().catch(console.error);
