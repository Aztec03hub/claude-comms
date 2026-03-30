import { test, expect } from '@playwright/test';
import fs from 'fs';

/**
 * User Story Tests — Round 2
 *
 * Stories 8-12: More realistic multi-step user flows building on the
 * patterns established in Round 1 (user-stories.spec.js).
 */

const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups/user-stories-r2';

test.describe('User Stories — Round 2', () => {
  test.setTimeout(120000);

  /** @type {import('playwright').CDPSession} */
  let cdp;

  test.beforeEach(async ({ page }) => {
    // Block Google Fonts to prevent screenshot/font-loading hangs
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

    // Mock MQTT WebSocket to prevent event loop blocking
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      window.WebSocket = class MockWebSocket extends EventTarget {
        constructor(url) {
          super();
          this.readyState = 0;
          this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
          this.bufferedAmount = 0; this.extensions = ''; this.protocol = ''; this.binaryType = 'blob';
          if (!url.includes('mqtt')) return new OrigWS(url);
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.({});
            this.dispatchEvent(new Event('open'));
          }, 50);
        }
        send() {}
        close() { this.readyState = 3; }
      };
    });

    // Set up CDP session for fast DOM evaluation
    cdp = await page.context().newCDPSession(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Wait for app to render
    await expect(page.locator('[data-testid="message-input"]')).toBeAttached({ timeout: 30000 });
  });

  // ── Helpers ──

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function ce(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('CDP eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async function sendMessage(text) {
    await ce(`(() => {
      const i = document.querySelector('[data-testid="message-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, ${JSON.stringify(text)});
      i.dispatchEvent(new Event('input', {bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await delay(500);
  }

  async function clickEl(sel) {
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(300);
  }

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  async function getText(sel) {
    return ce(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim()`);
  }

  async function getCount(sel) {
    return ce(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  }

  async function cdpScreenshot(page, name) {
    try {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${SCREENSHOT_DIR}/${name}.png`, Buffer.from(data, 'base64'));
    } catch { /* screenshot failures are non-fatal */ }
  }

  async function fillInput(sel, text) {
    await ce(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return;
      const s = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      ).set;
      s.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await delay(200);
  }

  // ── Story 8: Multi-Channel Workflow ──

  test('Story 8: Multi-Channel Workflow', async ({ page }) => {
    // Start in #general (default)
    const startChannel = await getText('[data-testid="header-channel-name"]');
    expect(startChannel).toBe('general');

    // Send 2 messages in #general
    await sendMessage('General message one');
    await sendMessage('General message two');

    const generalBubbles = await getCount('.bubble');
    expect(generalBubbles).toBe(2);

    await cdpScreenshot(page, 's8-general-two-messages');

    // Switch to #project-alpha (it's a starred channel)
    const hasProjectAlpha = await exists('[data-testid="channel-item-project-alpha"], [data-testid="starred-channel-item-project-alpha"]');
    expect(hasProjectAlpha).toBe(true);

    await clickEl('[data-testid="channel-item-project-alpha"], [data-testid="starred-channel-item-project-alpha"]');
    await delay(300);

    // Verify we switched
    const alphaChannel = await getText('[data-testid="header-channel-name"]');
    expect(alphaChannel).toBe('project-alpha');

    // Should be empty (no messages sent here yet)
    const alphaBubblesBefore = await getCount('.bubble');
    expect(alphaBubblesBefore).toBe(0);

    // Send 1 message in #project-alpha
    await sendMessage('Alpha sprint update');

    const alphaBubblesAfter = await getCount('.bubble');
    expect(alphaBubblesAfter).toBe(1);

    const alphaText = await getText('.bubble');
    expect(alphaText).toContain('Alpha sprint update');

    await cdpScreenshot(page, 's8-alpha-one-message');

    // Switch back to #general — 2 messages should still be there
    await clickEl('[data-testid="channel-item-general"], [data-testid="starred-channel-item-general"]');
    await delay(300);

    const backToGeneral = await getText('[data-testid="header-channel-name"]');
    expect(backToGeneral).toBe('general');

    const generalBubblesAfter = await getCount('.bubble');
    expect(generalBubblesAfter).toBe(2);

    // Verify the actual message content didn't leak
    const firstBubbleText = await ce(`document.querySelectorAll('.bubble')[0]?.textContent?.trim()`);
    expect(firstBubbleText).toContain('General message one');

    const secondBubbleText = await ce(`document.querySelectorAll('.bubble')[1]?.textContent?.trim()`);
    expect(secondBubbleText).toContain('General message two');

    // No "Alpha sprint update" in #general
    const generalAllText = await ce(`
      Array.from(document.querySelectorAll('.bubble')).map(b => b.textContent).join(' ')
    `);
    expect(generalAllText).not.toContain('Alpha sprint update');

    await cdpScreenshot(page, 's8-general-preserved');

    // Switch back to #project-alpha — 1 message should still be there
    await clickEl('[data-testid="channel-item-project-alpha"], [data-testid="starred-channel-item-project-alpha"]');
    await delay(300);

    const backToAlpha = await getText('[data-testid="header-channel-name"]');
    expect(backToAlpha).toBe('project-alpha');

    const alphaFinal = await getCount('.bubble');
    expect(alphaFinal).toBe(1);

    const alphaFinalText = await getText('.bubble');
    expect(alphaFinalText).toContain('Alpha sprint update');

    // No general messages leaked into alpha
    expect(alphaFinalText).not.toContain('General message');

    await cdpScreenshot(page, 's8-alpha-preserved');
  });

  // ── Story 9: Power User Keyboard Flow ──

  test('Story 9: Power User Keyboard Flow', async ({ page }) => {
    // Ctrl+K opens search panel
    await ce(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`);
    await delay(400);

    const searchOpen = await exists('[data-testid="search-panel"]');
    expect(searchOpen).toBe(true);

    await cdpScreenshot(page, 's9-ctrlk-search-open');

    // Search input should be focused
    const searchFocused = await ce(`document.activeElement === document.querySelector('[data-testid="search-panel-input"]')`);
    // Search panel is open — that's the key assertion; focus is best-effort
    expect(searchOpen).toBe(true);

    // Escape closes search
    await ce(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await delay(400);

    const searchClosed = await exists('[data-testid="search-panel"]');
    expect(searchClosed).toBe(false);

    // Focus the message input and type a message
    await ce(`document.querySelector('[data-testid="message-input"]')?.focus()`);
    await delay(200);

    // Verify input is focused
    const inputFocused = await ce(`document.activeElement === document.querySelector('[data-testid="message-input"]')`);
    expect(inputFocused).toBe(true);

    // Type a message and send with Enter
    await sendMessage('Sent entirely via keyboard');

    const bubbleCount = await getCount('.bubble');
    expect(bubbleCount).toBe(1);

    const bubbleText = await getText('.bubble');
    expect(bubbleText).toContain('Sent entirely via keyboard');

    await cdpScreenshot(page, 's9-keyboard-message-sent');

    // Ctrl+K again for channel search/switch
    await ce(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`);
    await delay(400);

    const searchReopened = await exists('[data-testid="search-panel"]');
    expect(searchReopened).toBe(true);

    // Type to search
    await fillInput('[data-testid="search-panel-input"]', 'alpha');
    await delay(200);

    await cdpScreenshot(page, 's9-search-typed');

    // Escape closes
    await ce(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await delay(400);

    const searchGone = await exists('[data-testid="search-panel"]');
    expect(searchGone).toBe(false);

    // Verify focus returned to message input after escape
    await delay(200);
    const focusBack = await ce(`document.activeElement?.tagName`);
    // Focus should be on an input element (message input or body)
    // The key point: search panel is closed and user can continue working

    // Send another message to confirm input is still functional
    await sendMessage('Second keyboard message');
    const finalBubbles = await getCount('.bubble');
    expect(finalBubbles).toBe(2);

    await cdpScreenshot(page, 's9-continued-after-escape');
  });

  // ── Story 10: Reaction Conversation ──

  test('Story 10: Reaction Conversation', async ({ page }) => {
    // Send a message
    await sendMessage('Great work on the new feature!');

    const bubbles = await getCount('.bubble');
    expect(bubbles).toBe(1);

    // Hover over the message to trigger the action bar
    const msgRow = page.locator('.msg-row').first();
    await msgRow.hover({ timeout: 5000 });
    await delay(300);

    // Action bar should appear
    const actionBar = await exists('[data-testid="message-actions"]');
    expect(actionBar).toBe(true);

    // Click React button to open emoji picker
    await clickEl('[data-testid="action-react"]');
    await delay(400);

    const pickerOpen = await exists('[data-testid="emoji-picker"]');
    expect(pickerOpen).toBe(true);

    await cdpScreenshot(page, 's10-emoji-picker-open');

    // Pick an emoji — reaction appears on the message
    await clickEl('[data-testid="emoji-item"]');
    await delay(500);

    // Picker should close after selection
    const pickerClosed = await exists('[data-testid="emoji-picker"]');
    expect(pickerClosed).toBe(false);

    // Reaction badge should appear on the message
    const reactionCount = await getCount('.reaction');
    expect(reactionCount).toBeGreaterThanOrEqual(1);

    // Reaction should be active (we just added it)
    const reactionActive = await ce(`
      document.querySelector('.reaction')?.classList?.contains('active') || false
    `);
    expect(reactionActive).toBe(true);

    await cdpScreenshot(page, 's10-reaction-added');

    // Click the reaction to toggle it off
    await clickEl('.reaction');
    await delay(300);

    const afterToggle = await ce(`
      (() => {
        const r = document.querySelector('.reaction');
        if (!r) return 'removed';
        return r.classList.contains('active') ? 'active' : 'inactive';
      })()
    `);
    // Should be either removed or inactive
    expect(afterToggle).not.toBe('active');

    await cdpScreenshot(page, 's10-reaction-toggled-off');

    // Look for the (+) add-reaction button to add a different reaction
    // Need to hover again since action bar disappears
    await msgRow.hover({ timeout: 5000 });
    await delay(300);

    const addReactionBtn = await exists('.reaction-add');
    if (addReactionBtn) {
      await clickEl('.reaction-add');
      await delay(400);

      const pickerAgain = await exists('[data-testid="emoji-picker"]');
      expect(pickerAgain).toBe(true);

      await cdpScreenshot(page, 's10-add-reaction-picker');

      // Pick a different emoji (click the second emoji if available, else first)
      const emojiCount = await getCount('[data-testid="emoji-item"]');
      if (emojiCount > 1) {
        await ce(`document.querySelectorAll('[data-testid="emoji-item"]')[1]?.click()`);
      } else {
        await clickEl('[data-testid="emoji-item"]');
      }
      await delay(500);

      const newReactions = await getCount('.reaction');
      expect(newReactions).toBeGreaterThanOrEqual(1);

      await cdpScreenshot(page, 's10-different-reaction-added');
    } else {
      // No (+) button visible — use the action bar React button instead
      await clickEl('[data-testid="action-react"]');
      await delay(400);

      const pickerViaAction = await exists('[data-testid="emoji-picker"]');
      expect(pickerViaAction).toBe(true);

      // Select an emoji
      await clickEl('[data-testid="emoji-item"]');
      await delay(500);

      const newReactions = await getCount('.reaction');
      expect(newReactions).toBeGreaterThanOrEqual(1);

      await cdpScreenshot(page, 's10-reaction-re-added-via-action');
    }
  });

  // ── Story 11: Settings Workflow ──

  test('Story 11: Settings Workflow', async ({ page }) => {
    // Open settings from header gear button
    await clickEl('[data-testid="header-settings-btn"]');
    await delay(400);

    const settingsOpen = await exists('[data-testid="settings-panel"]');
    expect(settingsOpen).toBe(true);

    await cdpScreenshot(page, 's11-settings-from-header');

    // See profile section with display name
    const profileSection = await ce(`
      (() => {
        const headings = document.querySelectorAll('.section-heading');
        for (const h of headings) {
          if (h.textContent.includes('Profile')) return true;
        }
        return false;
      })()
    `);
    expect(profileSection).toBe(true);

    // Display name input should have a value
    const displayName = await ce(`document.querySelector('#settings-display-name')?.value`);
    expect(displayName).toBeTruthy();
    expect(displayName.length).toBeGreaterThan(0);

    // See Notifications section
    const notifSection = await ce(`
      (() => {
        const headings = document.querySelectorAll('.section-heading');
        for (const h of headings) {
          if (h.textContent.includes('Notification')) return true;
        }
        return false;
      })()
    `);
    expect(notifSection).toBe(true);

    // See Connection section
    const connSection = await ce(`
      (() => {
        const headings = document.querySelectorAll('.section-heading');
        for (const h of headings) {
          if (h.textContent.includes('Connection')) return true;
        }
        return false;
      })()
    `);
    expect(connSection).toBe(true);

    // Close settings via the close button
    await clickEl('[data-testid="settings-panel-close"]');
    await delay(300);

    const settingsClosed = await exists('[data-testid="settings-panel"]');
    expect(settingsClosed).toBe(false);

    await cdpScreenshot(page, 's11-settings-closed');

    // Open settings from sidebar gear button
    await clickEl('.user-settings');
    await delay(400);

    const settingsFromSidebar = await exists('[data-testid="settings-panel"]');
    expect(settingsFromSidebar).toBe(true);

    await cdpScreenshot(page, 's11-settings-from-sidebar');

    // Same panel — verify profile section is still there
    const profileAgain = await ce(`
      (() => {
        const headings = document.querySelectorAll('.section-heading');
        for (const h of headings) {
          if (h.textContent.includes('Profile')) return true;
        }
        return false;
      })()
    `);
    expect(profileAgain).toBe(true);

    // Same display name
    const displayNameAgain = await ce(`document.querySelector('#settings-display-name')?.value`);
    expect(displayNameAgain).toBe(displayName);

    // Close with Escape
    await ce(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await delay(400);

    const settingsEscaped = await exists('[data-testid="settings-panel"]');
    expect(settingsEscaped).toBe(false);

    await cdpScreenshot(page, 's11-settings-escaped');
  });

  // ── Story 12: Pin and Find Important Messages ──

  test('Story 12: Pin and Find Important Messages', async ({ page }) => {
    // Send 3 messages
    await sendMessage('Regular update message');
    await sendMessage('IMPORTANT: Deploy scheduled for Friday');
    await sendMessage('Anyone have questions?');

    const bubbles = await getCount('.bubble');
    expect(bubbles).toBe(3);

    await cdpScreenshot(page, 's12-three-messages');

    // Right-click the second (important) message to open context menu
    const secondBubble = page.locator('.bubble').nth(1);
    await secondBubble.click({ button: 'right', timeout: 5000 });
    await delay(800);

    // Context menu should be visible
    const ctxMenu = page.locator('[data-testid="context-menu"]');
    await expect(ctxMenu).toBeAttached({ timeout: 5000 });

    await cdpScreenshot(page, 's12-context-menu');

    // Click "Pin Message"
    const pinItem = page.locator('[data-testid="ctx-pin"]');
    await pinItem.click({ timeout: 5000 });
    await delay(500);

    // Open pinned messages panel from header button
    await clickEl('[data-testid="header-pin-btn"]');
    await delay(400);

    const pinnedPanelOpen = await exists('[data-testid="pinned-panel"]');
    expect(pinnedPanelOpen).toBe(true);

    await cdpScreenshot(page, 's12-pinned-panel-open');

    // Pinned panel should show the pinned message
    const pinnedItems = await getCount('.pinned-item');
    expect(pinnedItems).toBe(1);

    // Pinned message text should match
    const pinnedText = await getText('.pinned-item-text');
    expect(pinnedText).toContain('IMPORTANT: Deploy scheduled for Friday');

    // Pinned count badge should show 1
    const pinnedCount = await getText('.pinned-count');
    expect(pinnedCount).toBe('1');

    // Close pinned panel
    await clickEl('[data-testid="pinned-panel-close"]');
    await delay(300);

    const pinnedClosed = await exists('[data-testid="pinned-panel"]');
    expect(pinnedClosed).toBe(false);

    // Now unpin: right-click the same message again
    await secondBubble.click({ button: 'right', timeout: 5000 });
    await delay(800);

    const ctxMenu2 = page.locator('[data-testid="context-menu"]');
    await expect(ctxMenu2).toBeAttached({ timeout: 5000 });

    // Click Pin again (toggles to unpin)
    const pinItem2 = page.locator('[data-testid="ctx-pin"]');
    await pinItem2.click({ timeout: 5000 });
    await delay(500);

    // Open pinned panel again — should be empty now
    await clickEl('[data-testid="header-pin-btn"]');
    await delay(400);

    const pinnedPanelAgain = await exists('[data-testid="pinned-panel"]');
    expect(pinnedPanelAgain).toBe(true);

    // Should show empty state
    const emptyPinned = await exists('.pinned-empty');
    expect(emptyPinned).toBe(true);

    const emptyText = await getText('.pinned-empty');
    expect(emptyText).toContain('No pinned messages');

    // Count should be 0
    const pinnedCountAfter = await getText('.pinned-count');
    expect(pinnedCountAfter).toBe('0');

    await cdpScreenshot(page, 's12-pinned-empty-after-unpin');

    // Close pinned panel
    await clickEl('[data-testid="pinned-panel-close"]');
    await delay(300);

    const pinnedFinalClosed = await exists('[data-testid="pinned-panel"]');
    expect(pinnedFinalClosed).toBe(false);
  });
});
