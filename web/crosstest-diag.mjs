/**
 * Diagnostic: trace message routing and deduplication
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

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  // Signal ready
  writeFileSync(join(__dirname, '..', '.crosstest-ready'), 'ready');
  console.log('Signaled ready. Waiting for MCP message...');

  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
  }

  // Collect ALL relevant logs
  console.log('\n=== ALL LOGS ===');
  consoleLogs.forEach(l => {
    if (l.includes('claude-comms') || l.includes('ROUTING') || l.includes('handleChat') || l.includes('Loaded') || l.includes('[error]')) {
      console.log('  ' + l);
    }
  });

  console.log('\nmsg-row count:', await page.locator('.msg-row').count());

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-diag.png') });
  await browser.close();
}

run().catch(err => console.error(err));
