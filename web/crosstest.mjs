/**
 * Cross-platform integration test: MCP <-> Web UI via MQTT
 *
 * Opens the web UI, waits for connection, signals for MCP messages,
 * then verifies they appear. Also sends a message from the web UI.
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
  await page.waitForTimeout(3000);

  // Signal ready for MCP sends
  writeFileSync(SIGNAL_FILE, 'ready');
  console.log('[PW] Signaled ready. Waiting for MCP messages...');

  // Wait for all 3 MCP messages (up to 45s)
  let attempts = 0;
  let hasGreeting = false, hasMention = false, hasCode = false;
  while (attempts < 45) {
    await page.waitForTimeout(1000);
    const text = await page.textContent('body');
    hasGreeting = text.includes('CROSSTEST-LIVE');
    hasMention = text.includes('@phil-human');
    hasCode = text.includes('verify_cross_platform');
    if (hasGreeting && hasMention && hasCode) {
      console.log('[PW] All 3 MCP messages detected!');
      break;
    }
    attempts++;
    if (attempts % 5 === 0) {
      console.log(`[PW] Waiting... (${attempts}s) greeting=${hasGreeting} mention=${hasMention} code=${hasCode}`);
    }
  }

  // Extra wait for rendering
  await page.waitForTimeout(1000);

  // Screenshot #1: MCP messages in the UI
  await page.screenshot({ path: join(MOCKUPS, 'crosstest-01-mcp-messages.png'), fullPage: false });

  // Check mention highlighting
  const mentionEls = await page.locator('.mention').all();
  const mentionHighlighted = mentionEls.length > 0;

  // Check code block rendering
  const codeBlockEls = await page.locator('.code-block, pre code, .code-content').all();
  const codeBlockRendered = codeBlockEls.length > 0;

  // Check sender names
  const senderEls = await page.locator('.sender-name, .msg-sender').all();
  const senderCount = senderEls.length;

  // Check timestamps
  const timeEls = await page.locator('.msg-time, time, .timestamp').all();
  const timeCount = timeEls.length;

  // Screenshot #2: close-up of chat area
  const chatArea = page.locator('.messages-scroll, .chat-messages, .messages-list').first();
  if (await chatArea.isVisible().catch(() => false)) {
    await chatArea.screenshot({ path: join(MOCKUPS, 'crosstest-02-chat-area.png') });
  }

  // If mention is highlighted, screenshot it
  if (mentionEls.length > 0) {
    try {
      await mentionEls[0].screenshot({ path: join(MOCKUPS, 'crosstest-04-mention-highlight.png') });
    } catch {}
  }

  // Send message FROM web UI
  console.log('[PW] Sending message from web UI...');
  const WEB_MSG = 'CROSSTEST-WEBMSG: Hello from browser at ' + new Date().toISOString();

  const input = page.locator('[data-testid="message-input"]');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.click();
  await input.fill(WEB_MSG);
  await page.locator('[data-testid="send-button"]').click();
  await page.waitForTimeout(2000);

  // Screenshot #3: after web send
  await page.screenshot({ path: join(MOCKUPS, 'crosstest-03-after-web-send.png'), fullPage: false });

  const afterText = await page.textContent('body');
  const webMsgSent = afterText.includes('CROSSTEST-WEBMSG');
  writeFileSync(RESULT_FILE, WEB_MSG);

  // Print errors
  const errors = consoleLogs.filter(l => l.toLowerCase().includes('error'));
  if (errors.length > 0) {
    console.log('\nConsole errors:');
    errors.forEach(l => console.log('  ' + l));
  }

  const results = {
    mcpToWeb: { greeting: hasGreeting, mention: hasMention, codeBlock: hasCode },
    webToMcp: { sent: webMsgSent },
    rendering: { mentionHighlighted, codeBlockRendered, senderNames: senderCount, timestamps: timeCount }
  };

  console.log('\n=== CROSS-TEST RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('WEB_MSG:', WEB_MSG);
  console.log('==========================\n');

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
