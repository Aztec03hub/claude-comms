import { test, expect } from '@playwright/test';
import { writeFileSync } from 'fs';

/**
 * Comprehensive smoke test: exercises EVERY major interaction while
 * capturing ALL console output (errors, warnings, uncaught exceptions).
 * Saves full console log to mockups/test-console-log.txt.
 */

const LOG_PATH = '/home/plafayette/claude-comms/mockups/test-console-log.txt';

// Patterns to ignore: MQTT broker offline, Svelte internals
const IGNORE_PATTERNS = [
  'WebSocket', 'mqtt', 'MQTT', 'ws://', 'net::ERR',
  'each_key_duplicate',
  'ERR_CONNECTION_REFUSED',
  'Failed to load resource',
];

function shouldIgnore(text) {
  return IGNORE_PATTERNS.some(p => text.includes(p));
}

test.describe('Full smoke test - all interactions', () => {
  test.setTimeout(120000); // 2 minutes for the full interaction sequence

  test('exercise every major UI interaction and capture console output', async ({ page }) => {
    // ── Console Monitoring Setup ──
    const allConsole = [];      // Every console message
    const errors = [];          // errors + pageerrors, with interaction context
    const warnings = [];        // warnings with interaction context
    let currentInteraction = 'page-load';

    function logMsg(type, text) {
      const entry = `[${type.toUpperCase()}] (${currentInteraction}) ${text}`;
      allConsole.push(entry);
    }

    page.on('console', (msg) => {
      const text = msg.text();
      const type = msg.type();
      logMsg(type, text);

      if (shouldIgnore(text)) return;

      if (type === 'error') {
        errors.push({ interaction: currentInteraction, text, type: 'console.error' });
      }
      if (type === 'warning') {
        warnings.push({ interaction: currentInteraction, text, type: 'console.warn' });
      }
    });

    page.on('pageerror', (err) => {
      const text = err.message;
      logMsg('pageerror', text);
      if (!shouldIgnore(text)) {
        errors.push({ interaction: currentInteraction, text, type: 'pageerror' });
      }
    });

    // Helper: set context and wait briefly
    async function step(name, fn) {
      currentInteraction = name;
      allConsole.push(`\n--- STEP: ${name} ---`);
      try {
        await fn();
      } catch (e) {
        allConsole.push(`[STEP-ERROR] ${name}: ${e.message}`);
        errors.push({ interaction: name, text: `Step failed: ${e.message}`, type: 'step-error' });
      }
    }

    // ═══════════════════════════════════════════════
    // 1. Load page, wait for app
    // ═══════════════════════════════════════════════
    await step('1-load-page', async () => {
      await page.goto('/', { waitUntil: 'networkidle', timeout: 30000 });
      // Wait for Svelte app to mount and render the layout
      await page.waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });
      await page.waitForTimeout(2000);
    });

    // ═══════════════════════════════════════════════
    // 2. Click each sidebar channel (4 channels)
    // ═══════════════════════════════════════════════
    await step('2-click-sidebar-channels', async () => {
      // Channels might be in starred or conversations sections
      const allChannelItems = page.locator('[data-testid^="channel-item-"], [data-testid^="starred-channel-item-"]');
      const count = await allChannelItems.count();
      allConsole.push(`  Found ${count} channel items`);
      for (let i = 0; i < Math.min(count, 4); i++) {
        const item = allChannelItems.nth(i);
        const testid = await item.getAttribute('data-testid');
        allConsole.push(`  Clicking channel: ${testid}`);
        await item.click();
        await page.waitForTimeout(300);
      }
    });

    // Switch back to general for messaging
    await step('2b-switch-to-general', async () => {
      const general = page.locator('[data-testid="channel-item-general"]');
      if (await general.count() > 0) {
        await general.click();
        await page.waitForTimeout(200);
      } else {
        // Maybe it's in starred
        const starredGeneral = page.locator('[data-testid="starred-channel-item-general"]');
        if (await starredGeneral.count() > 0) {
          await starredGeneral.click();
          await page.waitForTimeout(200);
        }
      }
    });

    // ═══════════════════════════════════════════════
    // 3. Type and send 3 messages
    // ═══════════════════════════════════════════════
    await step('3-send-messages', async () => {
      const input = page.locator('[data-testid="message-input"]');
      await input.waitFor({ state: 'visible', timeout: 5000 });
      for (let i = 1; i <= 3; i++) {
        await input.click();
        await input.fill(`Smoke test message ${i}`);
        await page.waitForTimeout(100);
        await input.press('Enter');
        await page.waitForTimeout(400);
        allConsole.push(`  Sent message ${i}`);
      }
    });

    // ═══════════════════════════════════════════════
    // 4. Open search panel, close it
    // ═══════════════════════════════════════════════
    await step('4-search-panel-open', async () => {
      await page.locator('[data-testid="header-search-btn"]').click();
      await page.waitForTimeout(500);
    });

    await step('4b-search-panel-close', async () => {
      // Try the close button first
      const closeBtn = page.locator('[data-testid="search-panel-close"]');
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
      } else {
        // Toggle it off via header button
        await page.locator('[data-testid="header-search-btn"]').click();
      }
      await page.waitForTimeout(300);
    });

    // ═══════════════════════════════════════════════
    // 5. Open pinned panel, close it
    // ═══════════════════════════════════════════════
    await step('5-pinned-panel-open', async () => {
      await page.locator('[data-testid="header-pin-btn"]').click();
      await page.waitForTimeout(500);
    });

    await step('5b-pinned-panel-close', async () => {
      const closeBtn = page.locator('[data-testid="pinned-panel-close"]');
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
      } else {
        await page.locator('[data-testid="header-pin-btn"]').click();
      }
      await page.waitForTimeout(300);
    });

    // ═══════════════════════════════════════════════
    // 6. Open channel creation modal, fill fields, cancel
    // ═══════════════════════════════════════════════
    await step('6-channel-modal-fill-cancel', async () => {
      await page.locator('[data-testid="sidebar-create-channel"]').click();
      await page.waitForTimeout(400);

      await page.locator('[data-testid="channel-modal-name-input"]').fill('test-cancel-channel');
      await page.waitForTimeout(100);
      await page.locator('[data-testid="channel-modal-description"]').fill('This channel should not be created');
      await page.waitForTimeout(100);

      await page.locator('[data-testid="channel-modal-cancel"]').click();
      await page.waitForTimeout(300);
    });

    // ═══════════════════════════════════════════════
    // 7. Open channel creation modal, create a channel
    // ═══════════════════════════════════════════════
    await step('7-channel-modal-create', async () => {
      await page.locator('[data-testid="sidebar-create-channel"]').click();
      await page.waitForTimeout(400);

      await page.locator('[data-testid="channel-modal-name-input"]').fill('smoke-test-channel');
      await page.waitForTimeout(100);
      await page.locator('[data-testid="channel-modal-description"]').fill('Created by smoke test');
      await page.waitForTimeout(100);

      await page.locator('[data-testid="channel-modal-create"]').click();
      await page.waitForTimeout(500);
    });

    // Switch back to general so we have messages to right-click
    await step('7b-switch-back-general', async () => {
      const general = page.locator('[data-testid="channel-item-general"]');
      if (await general.count() > 0) {
        await general.click();
      } else {
        const starredGeneral = page.locator('[data-testid="starred-channel-item-general"]');
        if (await starredGeneral.count() > 0) await starredGeneral.click();
      }
      await page.waitForTimeout(300);
    });

    // ═══════════════════════════════════════════════
    // 8. Right-click a message (context menu)
    // ═══════════════════════════════════════════════
    await step('8-context-menu-open', async () => {
      // We sent messages to general earlier, find one
      const msgRow = page.locator('.msg-row').first();
      if (await msgRow.count() > 0) {
        await msgRow.click({ button: 'right' });
        await page.waitForTimeout(400);
      } else {
        allConsole.push('  WARNING: No messages found to right-click');
      }
    });

    // ═══════════════════════════════════════════════
    // 9. Close context menu
    // ═══════════════════════════════════════════════
    await step('9-context-menu-close', async () => {
      const ctxMenu = page.locator('[data-testid="context-menu"]');
      if (await ctxMenu.count() > 0) {
        // Click the backdrop
        await page.locator('.ctx-backdrop').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(300);
      } else {
        // Escape fallback
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    });

    // ═══════════════════════════════════════════════
    // 10. Click emoji button in input area
    // ═══════════════════════════════════════════════
    await step('10-emoji-picker-open', async () => {
      await page.locator('[data-testid="input-emoji"]').click();
      await page.waitForTimeout(500);
    });

    // ═══════════════════════════════════════════════
    // 11. Close emoji picker
    // ═══════════════════════════════════════════════
    await step('11-emoji-picker-close', async () => {
      const picker = page.locator('[data-testid="emoji-picker"]');
      if (await picker.count() > 0) {
        // Click outside via backdrop
        await page.locator('.emoji-backdrop').click({ position: { x: 5, y: 5 } });
        await page.waitForTimeout(300);
      } else {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    });

    // ═══════════════════════════════════════════════
    // 12. Click a member in member list
    // ═══════════════════════════════════════════════
    await step('12-member-click', async () => {
      // The user's own profile is always visible in the sidebar
      const memberEl = page.locator('.user-avatar-wrap');
      if (await memberEl.count() > 0) {
        await memberEl.click();
        await page.waitForTimeout(400);
      } else {
        allConsole.push('  WARNING: No member items found');
      }
    });

    // ═══════════════════════════════════════════════
    // 13. Close profile card
    // ═══════════════════════════════════════════════
    await step('13-profile-card-close', async () => {
      const card = page.locator('[data-testid="profile-card"]');
      if (await card.count() > 0) {
        // Close via backdrop or escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    });

    // ═══════════════════════════════════════════════
    // 14. Press Ctrl+K (search shortcut)
    // ═══════════════════════════════════════════════
    await step('14-ctrl-k-shortcut', async () => {
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(500);
    });

    // ═══════════════════════════════════════════════
    // 15. Press Escape
    // ═══════════════════════════════════════════════
    await step('15-escape-close', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    });

    // ═══════════════════════════════════════════════
    // 16. Resize viewport to 480px wide
    // ═══════════════════════════════════════════════
    await step('16-resize-480px', async () => {
      await page.setViewportSize({ width: 480, height: 768 });
      await page.waitForTimeout(800);
    });

    // ═══════════════════════════════════════════════
    // 17. Resize back to 1440px
    // ═══════════════════════════════════════════════
    await step('17-resize-1440px', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(800);
    });

    // ═══════════════════════════════════════════════
    // REPORT
    // ═══════════════════════════════════════════════
    allConsole.push('\n\n========================================');
    allConsole.push('SMOKE TEST REPORT');
    allConsole.push('========================================\n');

    // Deduplicate errors
    const uniqueErrors = [];
    const seenErrors = new Set();
    for (const err of errors) {
      const key = `${err.type}::${err.text}`;
      if (!seenErrors.has(key)) {
        seenErrors.add(key);
        uniqueErrors.push(err);
      }
    }

    const uniqueWarnings = [];
    const seenWarnings = new Set();
    for (const w of warnings) {
      const key = w.text;
      if (!seenWarnings.has(key)) {
        seenWarnings.add(key);
        uniqueWarnings.push(w);
      }
    }

    allConsole.push(`Total console entries: ${allConsole.length}`);
    allConsole.push(`Unique errors (non-ignored): ${uniqueErrors.length}`);
    allConsole.push(`Unique warnings (non-ignored): ${uniqueWarnings.length}`);

    if (uniqueErrors.length > 0) {
      allConsole.push('\n--- ERRORS ---');
      for (const err of uniqueErrors) {
        allConsole.push(`  [${err.type}] during "${err.interaction}": ${err.text}`);
      }
    }

    if (uniqueWarnings.length > 0) {
      allConsole.push('\n--- WARNINGS ---');
      for (const w of uniqueWarnings) {
        allConsole.push(`  [${w.type}] during "${w.interaction}": ${w.text}`);
      }
    }

    if (uniqueErrors.length === 0 && uniqueWarnings.length === 0) {
      allConsole.push('\nAll interactions completed cleanly - no JS errors or warnings detected.');
    }

    // Write full log
    writeFileSync(LOG_PATH, allConsole.join('\n'), 'utf-8');
    console.log(`Full console log saved to ${LOG_PATH}`);

    // Assert no errors
    if (uniqueErrors.length > 0) {
      console.error('Errors found:');
      for (const err of uniqueErrors) {
        console.error(`  [${err.type}] "${err.interaction}": ${err.text}`);
      }
    }

    expect(uniqueErrors).toEqual([]);
  });
});
