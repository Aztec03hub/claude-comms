/**
 * Test with production build on port 4173
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

  console.log('Loading production build...');
  await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  // Signal
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Signaled ready, waiting 20s for messages...');

  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const msgCount = await page.locator('.msg-row').count();
    if (i % 5 === 0) {
      console.log(`[${i+1}s] msg-rows: ${msgCount}`);
    }
    if (msgCount > 0) {
      console.log(`Messages appeared at ${i+1}s! Count: ${msgCount}`);
      break;
    }
  }

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });

  // Check relevant logs
  const relevant = consoleLogs.filter(l =>
    l.includes('claude-comms') || l.includes('[error]')
  );
  console.log('\nRelevant logs:');
  relevant.slice(0, 30).forEach(l => console.log('  ' + l));

  await browser.close();
}

run().catch(err => console.error(err));
