/**
 * Cross-platform integration test: MCP <-> Web UI via MQTT
 *
 * Tests that messages sent via MCP tools appear in the web UI,
 * and messages sent from the web UI are received by MCP.
 *
 * IMPORTANT: MCP messages must be sent AFTER the web UI connects,
 * because they are non-retained QoS 1 messages.
 * This script opens the UI first, waits for connection,
 * then signals that MCP messages should be sent.
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOCKUPS = join(__dirname, '..', 'mockups');
const BASE_URL = 'http://localhost:5173';
const SIGNAL_FILE = join(__dirname, '..', '.crosstest-ready');
const RESULT_FILE = join(__dirname, '..', '.crosstest-webmsg');

async function run() {
  // Clean up signal files
  try { unlinkSync(SIGNAL_FILE); } catch {}
  try { unlinkSync(RESULT_FILE); } catch {}

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const consoleLogs = [];
  page.on('console', msg => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });

  console.log('[Playwright] Navigating to web UI...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  // Wait for MQTT connection
  console.log('[Playwright] Waiting for MQTT connection...');
  await page.waitForTimeout(3000);

  // Signal that the web UI is connected and ready for MCP messages
  writeFileSync(SIGNAL_FILE, 'ready');
  console.log('[Playwright] Signaled ready. Waiting for MCP messages...');

  // Wait for MCP messages to arrive (the caller will send them after seeing the signal)
  // Poll for up to 30 seconds
  let attempts = 0;
  let hasGreeting = false;
  while (attempts < 30) {
    await page.waitForTimeout(1000);
    const text = await page.textContent('body');
    hasGreeting = text.includes('CROSSTEST-LIVE');
    if (hasGreeting) {
      console.log('[Playwright] MCP messages detected!');
      break;
    }
    attempts++;
    if (attempts % 5 === 0) console.log(`[Playwright] Still waiting... (${attempts}s)`);
  }

  // Take screenshot
  await page.screenshot({ path: join(MOCKUPS, 'crosstest-01-mcp-messages.png'), fullPage: false });

  const pageText = await page.textContent('body');
  const results = {
    greeting: pageText.includes('CROSSTEST-LIVE: Hello'),
    mention: pageText.includes('@phil-human'),
    codeBlock: pageText.includes('verify_cross_platform'),
  };

  console.log(`[Playwright] MCP -> WebUI results:`);
  console.log(`  Greeting: ${results.greeting ? 'PASS' : 'FAIL'}`);
  console.log(`  @mention: ${results.mention ? 'PASS' : 'FAIL'}`);
  console.log(`  Code block: ${results.codeBlock ? 'PASS' : 'FAIL'}`);

  // Check mention highlighting
  const mentionEls = await page.locator('.mention').all();
  results.mentionHighlighted = mentionEls.length > 0;
  console.log(`  Mention highlighted: ${results.mentionHighlighted ? 'PASS' : 'FAIL'} (${mentionEls.length} elements)`);

  // Check sender names visible
  const senderEls = await page.locator('.sender-name, .msg-sender').all();
  results.senderNames = senderEls.length > 0;
  console.log(`  Sender names visible: ${results.senderNames ? 'PASS' : 'FAIL'} (${senderEls.length} elements)`);

  // Check timestamps visible
  const timeEls = await page.locator('.msg-time, time, .timestamp').all();
  results.timestamps = timeEls.length > 0;
  console.log(`  Timestamps visible: ${results.timestamps ? 'PASS' : 'FAIL'} (${timeEls.length} elements)`);

  // Screenshot close-up of chat area
  const chatArea = page.locator('.messages-scroll, .chat-messages, .messages-area').first();
  if (await chatArea.isVisible().catch(() => false)) {
    await chatArea.screenshot({ path: join(MOCKUPS, 'crosstest-02-chat-area.png') });
  }

  // Step 3: Send a message FROM the web UI
  console.log('[Playwright] Sending message from web UI...');
  const WEB_MSG = 'CROSSTEST-WEBMSG: Hello from browser at ' + new Date().toISOString();

  const input = page.locator('[data-testid="message-input"]');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.click();
  await input.fill(WEB_MSG);
  await page.locator('[data-testid="send-button"]').click();

  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(MOCKUPS, 'crosstest-03-after-web-send.png'), fullPage: false });

  // Write the web message to a file so the caller can verify via MCP
  writeFileSync(RESULT_FILE, WEB_MSG);

  const afterText = await page.textContent('body');
  results.webMsgSent = afterText.includes('CROSSTEST-WEBMSG');
  console.log(`[Playwright] WebUI -> sent: ${results.webMsgSent ? 'PASS' : 'FAIL'}`);

  // Check for code block rendering
  const codeBlockEls = await page.locator('.code-block, pre code').all();
  results.codeBlockRendered = codeBlockEls.length > 0;
  console.log(`  Code blocks rendered: ${results.codeBlockRendered ? 'PASS' : 'FAIL'} (${codeBlockEls.length} elements)`);

  // Take a mention highlight screenshot if present
  if (mentionEls.length > 0) {
    try {
      const msgWithMention = mentionEls[0].locator('xpath=ancestor::*[contains(@class, "message")]').first();
      if (await msgWithMention.isVisible().catch(() => false)) {
        await msgWithMention.screenshot({ path: join(MOCKUPS, 'crosstest-04-mention-highlight.png') });
      }
    } catch {}
  }

  // Print errors
  const errors = consoleLogs.filter(l => l.toLowerCase().includes('error'));
  if (errors.length > 0) {
    console.log('\nConsole errors:');
    errors.forEach(l => console.log('  ' + l));
  }

  console.log('\n=== CROSS-TEST SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('WEB_MSG:', WEB_MSG);
  console.log('=========================\n');

  await browser.close();
  return results;
}

run().then(results => {
  const allPass = results.greeting && results.mention && results.codeBlock && results.webMsgSent;
  console.log(allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
  process.exit(allPass ? 0 : 1);
}).catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
