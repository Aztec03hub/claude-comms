/**
 * Final cross-test on production build (port 4173)
 * Tests MCP -> WebUI and WebUI -> MCP bidirectional messaging
 */
import { chromium } from '@playwright/test';
import { writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCKUPS = join(__dirname, '..', 'mockups');
const BASE_URL = 'http://localhost:4173';
const SIGNAL = join(__dirname, '..', '.crosstest-ready');
const WEBMSG = join(__dirname, '..', '.crosstest-webmsg');

async function run() {
  try { unlinkSync(SIGNAL); } catch {}
  try { unlinkSync(WEBMSG); } catch {}

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  console.log('[PW] Loading production build...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  // Wait for MQTT connection
  console.log('[PW] Waiting for MQTT connection...');
  await page.waitForTimeout(8000);

  // Check connection
  const bodyText = await page.textContent('body');
  const isConnected = !bodyText.includes('Broker unavailable') && !bodyText.includes('Reconnecting');
  console.log('[PW] Connected:', isConnected);
  console.log('[PW] Console logs so far:', logs.length);

  // Signal ready
  writeFileSync(SIGNAL, 'ready');
  console.log('[PW] Signaled ready. Waiting for MCP messages...');

  // Wait for messages with extended timeout
  let hasGreeting = false, hasMention = false, hasCode = false;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(1000);
    const cnt = await page.locator('.msg-row').count();
    if (cnt > 0) {
      const text = await page.textContent('body');
      hasGreeting = text.includes('CROSSTEST-LIVE');
      hasMention = text.includes('@phil-human');
      hasCode = text.includes('verify_cross_platform');
      console.log(`[PW] ${i+1}s: ${cnt} msgs - greeting=${hasGreeting} mention=${hasMention} code=${hasCode}`);
      if (hasGreeting && hasMention && hasCode) {
        console.log('[PW] All 3 MCP messages detected!');
        break;
      }
    } else if (i % 5 === 0) {
      console.log(`[PW] ${i+1}s: waiting... (${logs.length} console logs)`);
    }
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(MOCKUPS, 'crosstest-01-mcp-messages.png'), fullPage: false });

  // Check rendering
  const mentionEls = await page.locator('.mention').all();
  const codeEls = await page.locator('.code-block, pre code').all();
  const senderCount = await page.locator('.sender-name').count();
  const timeCount = await page.locator('.msg-time').count();

  // Chat area screenshot
  const chatView = page.locator('[data-testid="chat-view"]');
  if (await chatView.isVisible()) {
    await chatView.screenshot({ path: join(MOCKUPS, 'crosstest-02-chat-area.png') });
  }
  if (mentionEls.length > 0) {
    try { await mentionEls[0].screenshot({ path: join(MOCKUPS, 'crosstest-04-mention-highlight.png') }); } catch {}
  }

  // Send from web UI
  console.log('[PW] Sending from web UI...');
  const WEB_MSG = 'CROSSTEST-WEBMSG: Hello from browser at ' + new Date().toISOString();
  const input = page.locator('[data-testid="message-input"]');
  await input.click();
  await input.pressSequentially(WEB_MSG, { delay: 10 });
  await page.waitForTimeout(300);
  await input.press('Enter');
  await page.waitForTimeout(3000);

  await page.screenshot({ path: join(MOCKUPS, 'crosstest-03-after-web-send.png'), fullPage: false });
  const afterText = await page.textContent('body');
  const webMsgSent = afterText.includes('CROSSTEST-WEBMSG');
  writeFileSync(WEBMSG, WEB_MSG);

  const results = {
    mcpToWeb: { greeting: hasGreeting, mention: hasMention, codeBlock: hasCode },
    webToMcp: { sent: webMsgSent },
    rendering: {
      mentionHighlighted: mentionEls.length > 0,
      codeRendered: codeEls.length > 0,
      senderNames: senderCount,
      timestamps: timeCount
    }
  };

  console.log('\n=== CROSS-TEST RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('WEB_MSG:', WEB_MSG);

  // Error logs
  const errors = logs.filter(l => l.includes('[error]') && !l.includes('CORS') && !l.includes('9920') && !l.includes('ConnectionStatus'));
  if (errors.length) { console.log('Errors:'); errors.forEach(l => console.log('  ' + l)); }

  console.log('==========================\n');
  await browser.close();
  return results;
}

run().then(r => {
  const pass = r.mcpToWeb.greeting && r.mcpToWeb.mention && r.mcpToWeb.codeBlock && r.webToMcp.sent;
  console.log(pass ? 'ALL CORE TESTS PASSED' : 'SOME CORE TESTS FAILED');
  process.exit(pass ? 0 : 1);
}).catch(err => { console.error('Test crashed:', err); process.exit(2); });
