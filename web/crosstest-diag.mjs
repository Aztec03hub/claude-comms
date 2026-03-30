import { chromium } from '@playwright/test';
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

  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    const cnt = await page.locator('.msg-row').count();
    const debugLog = logs.filter(l => l.includes('DEBUG'));
    console.log(`[${i+1}s] msg-rows: ${cnt}, debug logs: ${debugLog.length}`);
    if (debugLog.length > 0) {
      debugLog.forEach(l => console.log('  ' + l));
    }
    if (cnt > 0) {
      console.log('SUCCESS!');
      break;
    }
  }

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });
  await browser.close();
}
run().catch(console.error);
