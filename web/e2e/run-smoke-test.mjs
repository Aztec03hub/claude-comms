#!/usr/bin/env node
/**
 * Comprehensive smoke test for Claude Comms.
 * Exercises every major interaction while capturing ALL console output.
 * Reports every unique error with the interaction that triggered it.
 *
 * Usage: node e2e/run-smoke-test.mjs [baseURL]
 * Default: http://localhost:5299
 */

import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';

const BASE_URL = process.argv[2] || 'http://localhost:5299';
const LOG_PATH = '/home/plafayette/claude-comms/mockups/test-console-log.txt';

const IGNORE_PATTERNS = [
  'WebSocket', 'mqtt', 'MQTT', 'ws://',
  'each_key_duplicate',
  'ERR_CONNECTION_REFUSED',
  'Failed to load resource',
  'net::ERR',
];

function shouldIgnore(text) {
  return IGNORE_PATTERNS.some(p => text.includes(p));
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);

  const allConsole = [];
  const errors = [];
  const warnings = [];
  let currentInteraction = 'init';

  function logMsg(type, text) {
    allConsole.push(`[${type.toUpperCase()}] (${currentInteraction}) ${text}`);
  }

  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    logMsg(type, text);
    if (shouldIgnore(text)) return;
    if (type === 'error') errors.push({ interaction: currentInteraction, text, type: 'console.error' });
    if (type === 'warning') warnings.push({ interaction: currentInteraction, text, type: 'console.warn' });
  });

  page.on('pageerror', (err) => {
    const text = err.message;
    logMsg('pageerror', text);
    if (!shouldIgnore(text)) errors.push({ interaction: currentInteraction, text, type: 'pageerror' });
  });

  async function step(name, fn) {
    currentInteraction = name;
    allConsole.push(`\n--- STEP: ${name} ---`);
    process.stdout.write(`  ${name}... `);
    try {
      await fn();
      console.log('OK');
    } catch (e) {
      const msg = `Step failed: ${e.message.split('\n')[0]}`;
      allConsole.push(`[STEP-ERROR] ${name}: ${msg}`);
      errors.push({ interaction: name, text: msg, type: 'step-error' });
      console.log(`FAIL: ${msg.slice(0, 80)}`);
      try { await page.screenshot({ path: `/home/plafayette/claude-comms/mockups/smoke-fail-${name}.png` }); } catch (_) {}
    }
  }

  try {
    // 1. Load page
    await step('1-load-page', async () => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await wait(3000);
      const hasLayout = await page.evaluate(() => document.querySelector('.app-layout') !== null);
      if (!hasLayout) throw new Error('App layout not rendered');
    });

    // 2. Click sidebar channels
    await step('2-click-sidebar-channels', async () => {
      const count = await page.evaluate(() => {
        return document.querySelectorAll('[data-testid^="channel-item-"], [data-testid^="starred-channel-item-"]').length;
      });
      allConsole.push(`  Found ${count} channel items`);
      for (let i = 0; i < Math.min(count, 4); i++) {
        await page.evaluate((idx) => {
          const items = document.querySelectorAll('[data-testid^="channel-item-"], [data-testid^="starred-channel-item-"]');
          if (items[idx]) items[idx].click();
        }, i);
        await wait(200);
      }
    });

    // Switch to general
    await step('2b-switch-to-general', async () => {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="channel-item-general"]') ||
                   document.querySelector('[data-testid="starred-channel-item-general"]');
        if (el) el.click();
      });
      await wait(300);
    });

    // 3. Send 3 messages
    await step('3-send-messages', async () => {
      for (let i = 1; i <= 3; i++) {
        const input = page.locator('[data-testid="message-input"]');
        await input.click({ force: true });
        await input.fill(`Smoke test message ${i}`);
        await page.keyboard.press('Enter');
        await wait(300);
        allConsole.push(`  Sent message ${i}`);
      }
    });

    // 4. Search panel
    await step('4-search-panel-open', async () => {
      await page.locator('[data-testid="header-search-btn"]').click({ force: true });
      await wait(400);
    });

    await step('4b-search-panel-close', async () => {
      const hasClose = await page.evaluate(() => !!document.querySelector('[data-testid="search-panel-close"]'));
      if (hasClose) {
        await page.locator('[data-testid="search-panel-close"]').click({ force: true });
      } else {
        await page.locator('[data-testid="header-search-btn"]').click({ force: true });
      }
      await wait(300);
    });

    // 5. Pinned panel
    await step('5-pinned-panel-open', async () => {
      await page.locator('[data-testid="header-pin-btn"]').click({ force: true });
      await wait(400);
    });

    await step('5b-pinned-panel-close', async () => {
      const hasClose = await page.evaluate(() => !!document.querySelector('[data-testid="pinned-panel-close"]'));
      if (hasClose) {
        await page.locator('[data-testid="pinned-panel-close"]').click({ force: true });
      } else {
        await page.locator('[data-testid="header-pin-btn"]').click({ force: true });
      }
      await wait(300);
    });

    // 6. Channel modal - cancel
    await step('6-channel-modal-fill-cancel', async () => {
      await page.locator('[data-testid="sidebar-create-channel"]').click({ force: true });
      await wait(300);
      await page.locator('[data-testid="channel-modal-name-input"]').click({ force: true });
      await page.locator('[data-testid="channel-modal-name-input"]').fill('test-cancel-channel');
      await page.locator('[data-testid="channel-modal-description"]').click({ force: true });
      await page.locator('[data-testid="channel-modal-description"]').fill('Will cancel');
      await page.locator('[data-testid="channel-modal-cancel"]').click({ force: true });
      await wait(200);
    });

    // 7. Channel modal - create
    await step('7-channel-modal-create', async () => {
      await page.locator('[data-testid="sidebar-create-channel"]').click({ force: true });
      await wait(300);
      await page.locator('[data-testid="channel-modal-name-input"]').click({ force: true });
      await page.locator('[data-testid="channel-modal-name-input"]').fill('smoke-test-chan');
      await page.locator('[data-testid="channel-modal-description"]').click({ force: true });
      await page.locator('[data-testid="channel-modal-description"]').fill('Smoke test');
      await page.locator('[data-testid="channel-modal-create"]').click({ force: true });
      await wait(300);
    });

    // Back to general
    await step('7b-switch-back-general', async () => {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="channel-item-general"]') ||
                   document.querySelector('[data-testid="starred-channel-item-general"]');
        if (el) el.click();
      });
      await wait(300);
    });

    // 8. Context menu
    await step('8-context-menu-open', async () => {
      const hasMsg = await page.evaluate(() => !!document.querySelector('.msg-row'));
      if (hasMsg) {
        await page.locator('.msg-row').first().click({ button: 'right', force: true });
        await wait(300);
      } else {
        allConsole.push('  WARNING: No messages found to right-click');
      }
    });

    // 9. Close context menu
    await step('9-context-menu-close', async () => {
      const has = await page.evaluate(() => !!document.querySelector('[data-testid="context-menu"]'));
      if (has) {
        await page.keyboard.press('Escape');
        await wait(200);
      }
    });

    // 10. Emoji picker
    await step('10-emoji-picker-open', async () => {
      await page.locator('[data-testid="input-emoji"]').click({ force: true });
      await wait(400);
    });

    // 11. Close emoji picker
    await step('11-emoji-picker-close', async () => {
      const has = await page.evaluate(() => !!document.querySelector('[data-testid="emoji-picker"]'));
      if (has) {
        await page.keyboard.press('Escape');
        await wait(200);
      }
    });

    // 12. Click member
    await step('12-member-click', async () => {
      await page.locator('.user-avatar-wrap').click({ force: true });
      await wait(300);
    });

    // 13. Close profile card
    await step('13-profile-card-close', async () => {
      const has = await page.evaluate(() => !!document.querySelector('[data-testid="profile-card"]'));
      if (has) {
        await page.keyboard.press('Escape');
        await wait(200);
      }
    });

    // 14. Ctrl+K
    await step('14-ctrl-k-shortcut', async () => {
      await page.keyboard.press('Control+k');
      await wait(400);
    });

    // 15. Escape
    await step('15-escape-close', async () => {
      await page.keyboard.press('Escape');
      await wait(200);
    });

    // 16. Resize mobile
    await step('16-resize-480px', async () => {
      await page.setViewportSize({ width: 480, height: 768 });
      await wait(500);
    });

    // 17. Resize back
    await step('17-resize-1440px', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await wait(500);
    });

    // Final screenshot
    await page.screenshot({ path: '/home/plafayette/claude-comms/mockups/smoke-test-final.png' });

  } finally {
    // REPORT
    allConsole.push('\n\n========================================');
    allConsole.push('SMOKE TEST REPORT');
    allConsole.push('========================================\n');

    const appErrors = errors.filter(e => e.type !== 'step-error');
    const stepErrors = errors.filter(e => e.type === 'step-error');

    const uniqueAppErrors = [];
    const seen = new Set();
    for (const err of appErrors) {
      const key = `${err.type}::${err.text}`;
      if (!seen.has(key)) { seen.add(key); uniqueAppErrors.push(err); }
    }

    const uniqueWarnings = [];
    const seenW = new Set();
    for (const w of warnings) {
      if (!seenW.has(w.text)) { seenW.add(w.text); uniqueWarnings.push(w); }
    }

    allConsole.push(`Total console entries: ${allConsole.length}`);
    allConsole.push(`App errors (non-ignored): ${uniqueAppErrors.length}`);
    allConsole.push(`App warnings (non-ignored): ${uniqueWarnings.length}`);
    allConsole.push(`Step failures (test infra): ${stepErrors.length}`);

    if (uniqueAppErrors.length > 0) {
      allConsole.push('\n--- APP ERRORS ---');
      for (const e of uniqueAppErrors) allConsole.push(`  [${e.type}] during "${e.interaction}": ${e.text}`);
    }
    if (uniqueWarnings.length > 0) {
      allConsole.push('\n--- APP WARNINGS ---');
      for (const w of uniqueWarnings) allConsole.push(`  [${w.type}] during "${w.interaction}": ${w.text}`);
    }
    if (stepErrors.length > 0) {
      allConsole.push('\n--- STEP FAILURES ---');
      for (const e of stepErrors) allConsole.push(`  during "${e.interaction}": ${e.text}`);
    }
    if (uniqueAppErrors.length === 0 && uniqueWarnings.length === 0) {
      allConsole.push('\nNo application JS errors or warnings detected across all interactions.');
    }

    writeFileSync(LOG_PATH, allConsole.join('\n'), 'utf-8');

    console.log(`\nConsole log: ${LOG_PATH}`);
    console.log('\n========================================');
    console.log('RESULTS');
    console.log('========================================');
    console.log(`App errors: ${uniqueAppErrors.length}`);
    console.log(`App warnings: ${uniqueWarnings.length}`);
    console.log(`Steps passed: ${17 - stepErrors.length} / 17`);
    if (uniqueAppErrors.length > 0) {
      console.log('\nAPP ERRORS:');
      for (const e of uniqueAppErrors) console.log(`  [${e.type}] "${e.interaction}": ${e.text}`);
    }
    if (stepErrors.length > 0) {
      console.log('\nSTEP FAILURES:');
      for (const e of stepErrors) console.log(`  "${e.interaction}": ${e.text.slice(0, 80)}`);
    }

    await browser.close();
    process.exit(uniqueAppErrors.length > 0 ? 1 : 0);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(2); });
