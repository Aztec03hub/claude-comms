/**
 * Cross-platform integration test: MCP <-> Web UI via MQTT
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOCKUPS = join(__dirname, '..', 'mockups');
const BASE_URL = 'http://localhost:5173';
const SIGNAL_FILE = join(__dirname, '..', '.crosstest-ready');
const RESULT_FILE = join(__dirname, '..', '.crosstest-webmsg');

async function run() {
  try { unlinkSync(SIGNAL_FILE); } catch {}
  try { unlinkSync(RESULT_FILE); } catch {}

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

  console.log('[PW] Navigating to web UI...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  // Signal ready for MCP sends
  writeFileSync(SIGNAL_FILE, 'ready');
  console.log('[PW] Signaled ready. Waiting for MCP messages...');

  // Wait for messages (up to 30s)
  let hasGreeting = false, hasMention = false, hasCode = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const msgCount = await page.locator('.msg-row').count();
    if (msgCount > 0) {
      const text = await page.textContent('body');
      hasGreeting = text.includes('CROSSTEST-LIVE');
      hasMention = text.includes('@phil-human');
      hasCode = text.includes('verify_cross_platform');
      if (hasGreeting && hasMention && hasCode) {
        console.log(`[PW] All 3 MCP messages detected after ${i+1}s! (${msgCount} msg-rows)`);
        break;
      }
      if (i % 5 === 0) console.log(`[PW] ${i+1}s: ${msgCount} msgs, greeting=${hasGreeting} mention=${hasMention} code=${hasCode}`);
    } else if (i % 5 === 0) {
      console.log(`[PW] ${i+1}s: 0 msg-rows...`);
    }
  }

  await page.waitForTimeout(1000);

  // Screenshot 1: MCP messages
  await page.screenshot({ path: join(MOCKUPS, 'crosstest-01-mcp-messages.png'), fullPage: false });

  // Check mention highlighting
  const mentionEls = await page.locator('.mention').all();
  const mentionHighlighted = mentionEls.length > 0;

  // Check code blocks
  const codeEls = await page.locator('.code-block, pre code, .code-content').all();
  const codeRendered = codeEls.length > 0;

  // Check sender names
  const senderCount = await page.locator('.sender-name').count();

  // Check timestamps
  const timeCount = await page.locator('.msg-time').count();

  // Screenshot 2: chat area
  const chatArea = page.locator('[data-testid="chat-view"]');
  if (await chatArea.isVisible()) {
    await chatArea.screenshot({ path: join(MOCKUPS, 'crosstest-02-chat-area.png') });
  }

  // Mention highlight screenshot
  if (mentionEls.length > 0) {
    try {
      await mentionEls[0].screenshot({ path: join(MOCKUPS, 'crosstest-04-mention-highlight.png') });
    } catch {}
  }

  // Send message FROM web UI
  console.log('[PW] Sending message from web UI...');
  const WEB_MSG = 'CROSSTEST-WEBMSG: Hello from browser at ' + new Date().toISOString();

  const input = page.locator('[data-testid="message-input"]');
  await input.click();
  await input.pressSequentially(WEB_MSG, { delay: 10 });
  await page.waitForTimeout(300);
  await input.press('Enter');
  await page.waitForTimeout(2000);

  // Screenshot 3: after web send
  await page.screenshot({ path: join(MOCKUPS, 'crosstest-03-after-web-send.png'), fullPage: false });

  const afterText = await page.textContent('body');
  const webMsgSent = afterText.includes('CROSSTEST-WEBMSG');
  writeFileSync(RESULT_FILE, WEB_MSG);

  const results = {
    mcpToWeb: { greeting: hasGreeting, mention: hasMention, codeBlock: hasCode },
    webToMcp: { sent: webMsgSent },
    rendering: { mentionHighlighted, codeRendered, senderNames: senderCount, timestamps: timeCount }
  };

  console.log('\n=== CROSS-TEST RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('WEB_MSG:', WEB_MSG);
  console.log('==========================\n');

  // Errors
  const errors = consoleLogs.filter(l => l.includes('[error]') && !l.includes('CORS') && !l.includes('9920') && !l.includes('ConnectionStatus'));
  if (errors.length > 0) {
    console.log('Errors:');
    errors.forEach(l => console.log('  ' + l));
  }

  await browser.close();
  return results;
}

run().then(r => {
  const pass = r.mcpToWeb.greeting && r.mcpToWeb.mention && r.mcpToWeb.codeBlock && r.webToMcp.sent;
  console.log(pass ? 'ALL CORE TESTS PASSED' : 'SOME CORE TESTS FAILED');
  process.exit(pass ? 0 : 1);
}).catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
