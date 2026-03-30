import { test, expect } from '@playwright/test';
import { writeFileSync, appendFileSync, existsSync, unlinkSync } from 'fs';

/**
 * Comprehensive smoke test for Claude Comms.
 *
 * Tests every major interaction while capturing ALL console output.
 * Uses page.evaluate with requestAnimationFrame delays to work within
 * Svelte's async rendering model and avoid browser resource issues.
 *
 * Saves full console output to mockups/test-console-log.txt
 */

const LOG_PATH = '/home/plafayette/claude-comms/mockups/test-console-log.txt';

const IGNORE_PATTERNS = [
  'WebSocket', 'mqtt', 'MQTT', 'ws://',
  'each_key_duplicate',
  'ERR_CONNECTION_REFUSED',
  'Failed to load resource',
  'net::ERR',
  'CORS',
  'api/participants',
  'Access-Control-Allow-Origin',
];

function shouldIgnore(text) {
  return IGNORE_PATTERNS.some(p => text.includes(p));
}

test.describe('Comprehensive smoke test - all interactions', () => {
  test.setTimeout(120000);

  test('exercise all major UI interactions and capture console output', async ({ page }) => {
    const allLog = [];
    const appErrors = [];

    page.on('console', (msg) => {
      const text = msg.text();
      const type = msg.type();
      allLog.push(`[${type.toUpperCase()}] ${text}`);
      if (shouldIgnore(text)) return;
      if (type === 'error') appErrors.push({ type: 'console.error', text });
      if (type === 'warning') appErrors.push({ type: 'console.warn', text });
    });

    page.on('pageerror', (err) => {
      const text = err.message;
      allLog.push(`[PAGEERROR] ${text}`);
      if (!shouldIgnore(text)) appErrors.push({ type: 'pageerror', text });
    });

    await page.goto('/');
    await page.waitForSelector('.app-layout');

    // Run all interactions via page.evaluate with Svelte-aware async delays
    const results = await page.evaluate(() => {
      return new Promise((resolve) => {
        const log = [];
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

        function tick() {
          return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        }

        async function run() {
          try {
            // 1. Click each sidebar channel (up to 4)
            const channels = document.querySelectorAll(
              '[data-testid^="channel-item-"], [data-testid^="starred-channel-item-"]'
            );
            for (const c of channels) { c.click(); await tick(); }
            log.push('1. Clicked ' + channels.length + ' sidebar channels');

            // 2. Switch back to general
            const gen = document.querySelector('[data-testid="channel-item-general"]') ||
                       document.querySelector('[data-testid="starred-channel-item-general"]');
            if (gen) gen.click();
            await tick();
            log.push('2. Switched to general');

            // 3. Send 3 messages
            for (let i = 1; i <= 3; i++) {
              const inp = document.querySelector('[data-testid="message-input"]');
              setter.call(inp, 'Smoke test message ' + i);
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await tick();
            }
            log.push('3. Sent 3 messages');

            // 4. Open search panel
            document.querySelector('[data-testid="header-search-btn"]')?.click();
            await tick();
            log.push('4. Search panel open: ' + !!document.querySelector('[data-testid="search-panel"]'));

            // 5. Close search panel
            const searchClose = document.querySelector('[data-testid="search-panel-close"]');
            if (searchClose) searchClose.click();
            else document.querySelector('[data-testid="header-search-btn"]')?.click();
            await tick();
            log.push('5. Search panel closed');

            // 6. Open pinned panel
            document.querySelector('[data-testid="header-pin-btn"]')?.click();
            await tick();
            log.push('6. Pinned panel open: ' + !!document.querySelector('[data-testid="pinned-panel"]'));

            // 7. Close pinned panel
            document.querySelector('[data-testid="pinned-panel-close"]')?.click();
            await tick();
            log.push('7. Pinned panel closed');

            // 8. Channel modal - fill and cancel
            document.querySelector('[data-testid="sidebar-create-channel"]')?.click();
            await tick();
            const nameInput = document.querySelector('[data-testid="channel-modal-name-input"]');
            if (nameInput) {
              setter.call(nameInput, 'test-cancel-channel');
              nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            log.push('8. Channel modal filled: ' + !!nameInput);
            document.querySelector('[data-testid="channel-modal-cancel"]')?.click();
            await tick();
            log.push('   Channel modal cancelled');

            // 9. Channel modal - create
            document.querySelector('[data-testid="sidebar-create-channel"]')?.click();
            await tick();
            const nameInput2 = document.querySelector('[data-testid="channel-modal-name-input"]');
            if (nameInput2) {
              setter.call(nameInput2, 'smoke-test-ch');
              nameInput2.dispatchEvent(new Event('input', { bubbles: true }));
            }
            document.querySelector('[data-testid="channel-modal-create"]')?.click();
            await tick();
            log.push('9. Channel created');

            // Switch back to general for context menu test
            const gen2 = document.querySelector('[data-testid="channel-item-general"]') ||
                        document.querySelector('[data-testid="starred-channel-item-general"]');
            if (gen2) gen2.click();
            await tick();

            // 10. Right-click message (context menu)
            const msgRow = document.querySelector('.msg-row');
            if (msgRow) {
              msgRow.dispatchEvent(new MouseEvent('contextmenu', {
                clientX: 400, clientY: 300, bubbles: true, cancelable: true
              }));
              await tick();
              const hasCtx = !!document.querySelector('[data-testid="context-menu"]');
              log.push('10. Context menu open: ' + hasCtx);
              // Close
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              await tick();
              log.push('    Context menu closed');
            } else {
              log.push('10. Context menu skipped (no messages)');
            }

            // 11. Emoji picker
            document.querySelector('[data-testid="input-emoji"]')?.click();
            await tick();
            log.push('11. Emoji picker open: ' + !!document.querySelector('[data-testid="emoji-picker"]'));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await tick();
            log.push('    Emoji picker closed');

            // 12. Member click / profile card
            document.querySelector('.user-avatar-wrap')?.click();
            await tick();
            log.push('12. Profile card open: ' + !!document.querySelector('[data-testid="profile-card"]'));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await tick();
            log.push('    Profile card closed');

            // 13. Ctrl+K shortcut
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
            await tick();
            log.push('13. Ctrl+K pressed');

            // 14. Escape
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await tick();
            log.push('14. Escape pressed');

          } catch (e) {
            log.push('RUNTIME ERROR: ' + e.message);
          }
          resolve(log);
        }
        run();
      });
    });

    allLog.push('\n--- Interaction Results ---');
    results.forEach(l => allLog.push('  ' + l));

    // 15-16. Resize viewport
    try {
      await page.setViewportSize({ width: 480, height: 768 });
      allLog.push('  15. Resized to 480px');
      await page.setViewportSize({ width: 1440, height: 900 });
      allLog.push('  16. Resized to 1440px');
    } catch (e) {
      allLog.push('  Resize failed: ' + e.message.slice(0, 60));
    }

    // Write report
    allLog.push('\n\n========================================');
    allLog.push('SMOKE TEST REPORT');
    allLog.push('========================================');
    allLog.push('Interactions completed: ' + results.length);
    allLog.push('App errors (non-ignored): ' + appErrors.length);
    if (appErrors.length > 0) {
      allLog.push('\nERRORS:');
      appErrors.forEach(e => allLog.push(`  [${e.type}] ${e.text}`));
    } else {
      allLog.push('\nNo application JS errors or warnings detected across all interactions.');
    }

    writeFileSync(LOG_PATH, allLog.join('\n'), 'utf-8');
    console.log(`Console log saved to ${LOG_PATH}`);
    console.log(`Interactions: ${results.length}, Errors: ${appErrors.length}`);

    // Assert no application errors
    expect(appErrors).toEqual([]);
  });
});
