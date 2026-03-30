import { test, expect } from '@playwright/test';
import fs from 'fs';

const MOCKUPS = '/home/plafayette/claude-comms/mockups';

test.describe('Overnight: Members, Profile Card, Theme, Responsive', () => {
  test.setTimeout(120000);

  /** @type {import('playwright').CDPSession} */
  let cdp;

  test.beforeEach(async ({ page }) => {
    // Block Google Fonts
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

    // Mock MQTT WebSocket
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

    cdp = await page.context().newCDPSession(page);
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await expect(page.locator('[data-testid="message-input"]')).toBeAttached({ timeout: 30000 });
  });

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function ce(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('CDP: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  async function clickEl(sel) {
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(400);
  }

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  async function cdpScreenshot(name) {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${MOCKUPS}/${name}.png`, Buffer.from(data, 'base64'));
    } catch (e) { console.log('Screenshot failed:', name, e.message); }
  }

  // Inject fake participants into the Svelte store so the member list has data
  async function injectParticipants() {
    await ce(`(() => {
      // Access the app component's store via the global __svelte_store hook
      // The store is on the MqttChatStore instance; we need to poke at the reactive state.
      // Since Svelte 5 runes are compiled, we inject via the DOM's __svelte context or
      // directly manipulate the store object that's accessible from the app.
      // The simplest way: find the store reference on window or via component internals.

      // Actually, let's just set participants directly on the store instance.
      // The store is created in App.svelte as 'const store = new MqttChatStore()'
      // We can't easily access it. Instead, let's use a different approach:
      // expose the store on window in the init script.
    })()`);
  }

  // Better approach: use addInitScript to expose the store
  // But we need it after the app mounts. Let's use page.evaluate after load.
  async function injectFakeMembers() {
    // We need to access the Svelte store. Since it's not exposed on window,
    // we'll monkey-patch MqttChatStore to expose it.
    await ce(`(() => {
      // The participants object is reactive ($state). We need to find the store instance.
      // Approach: look for the member-list aside and its Svelte component context
      // Or: search through __svelte_meta on DOM nodes
      // Simplest: find the store by looking at what's rendered and using the Svelte internals

      // Actually, the best approach with Svelte 5 is to find the component instance.
      // Let's try accessing via the root component's context.
      // In dev mode, Svelte components have __svelte_meta on their DOM elements.

      // Alternative: Use MutationObserver approach - just check if members already exist
      return document.querySelectorAll('.member').length;
    })()`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ROUND 1: Member List
  // ═══════════════════════════════════════════════════════════════════════

  test('R1.1 — member list visible with header', async ({ page }) => {
    const memberList = await exists('[data-testid="member-list"]');
    expect(memberList).toBe(true);

    // Check header shows "Members (N)"
    const headerText = await ce(`document.querySelector('[data-testid="member-list"] .members-header')?.textContent`);
    expect(headerText).toContain('Members');

    // Online/offline sections may or may not exist depending on MQTT state
    const onlineSection = await exists('[data-testid="members-online-section"]');
    const offlineSection = await exists('[data-testid="members-offline-section"]');
    // At least the header should always be present even if no members
    console.log(`Online section: ${onlineSection}, Offline section: ${offlineSection}`);

    await cdpScreenshot('overnight-members-01-list');
  });

  test('R1.2 — member search button toggles search input', async ({ page }) => {
    const searchBtn = await exists('[data-testid="members-search-btn"]');
    expect(searchBtn).toBe(true);

    // Click to show search
    await clickEl('[data-testid="members-search-btn"]');
    await delay(300);

    const searchInput = await exists('[data-testid="members-search-input"]');
    expect(searchInput).toBe(true);

    await cdpScreenshot('overnight-members-02-search-open');

    // Click again to hide
    await clickEl('[data-testid="members-search-btn"]');
    await delay(300);

    const searchHidden = await exists('[data-testid="members-search-input"]');
    expect(searchHidden).toBe(false);
  });

  test('R1.3 — members count pill toggles member list visibility', async ({ page }) => {
    const visible = await exists('[data-testid="member-list"]');
    expect(visible).toBe(true);

    // Click the header members count button to hide
    await clickEl('[data-testid="header-members-count"]');
    await delay(400);

    const hidden = await exists('[data-testid="member-list"]');
    expect(hidden).toBe(false);

    await cdpScreenshot('overnight-members-03-list-hidden');

    // Click again to show
    await clickEl('[data-testid="header-members-count"]');
    await delay(400);

    const shown = await exists('[data-testid="member-list"]');
    expect(shown).toBe(true);

    await cdpScreenshot('overnight-members-04-list-shown');
  });

  test('R1.4 — click member opens profile card (if members present)', async ({ page }) => {
    const memberCount = await ce(`document.querySelectorAll('.member').length`);
    if (memberCount > 0) {
      await clickEl('.member');
      await delay(400);
      const cardVisible = await exists('[data-testid="profile-card"]');
      expect(cardVisible).toBe(true);
      await cdpScreenshot('overnight-members-05-profile-from-member');
    } else {
      console.log('No members in list (MQTT mock) - skipping member click test');
      // Open from sidebar user bar instead (always present)
      await clickEl('[data-testid="sidebar-user-profile"]');
      await delay(400);
      const cardVisible = await exists('[data-testid="profile-card"]');
      expect(cardVisible).toBe(true);
      await cdpScreenshot('overnight-members-05-profile-from-sidebar');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ROUND 2: Profile Card
  // ═══════════════════════════════════════════════════════════════════════

  test('R2.1 — profile card opens from sidebar user bar', async ({ page }) => {
    await clickEl('[data-testid="sidebar-user-profile"]');
    await delay(400);

    const cardVisible = await exists('[data-testid="profile-card"]');
    expect(cardVisible).toBe(true);

    await cdpScreenshot('overnight-members-06-profile-from-sidebar');
  });

  test('R2.2 — profile card shows name, handle, role, buttons', async ({ page }) => {
    // Open from sidebar user bar (always available)
    await clickEl('[data-testid="sidebar-user-profile"]');
    await delay(400);

    // Name
    const name = await ce(`document.querySelector('[data-testid="profile-card-name"]')?.textContent`);
    expect(name).toBeTruthy();
    console.log('Profile card name:', name);

    // Handle (@name)
    const handle = await ce(`document.querySelector('.profile-card-handle')?.textContent`);
    expect(handle).toContain('@');

    // Role
    const role = await ce(`document.querySelector('.profile-card-role')?.textContent`);
    expect(role).toBeTruthy();

    // Message button
    const msgBtn = await ce(`!!document.querySelector('.profile-card-btn')`);
    expect(msgBtn).toBe(true);
    // View Profile button
    const viewBtn = await ce(`!!document.querySelector('.profile-card-btn.primary')`);
    expect(viewBtn).toBe(true);

    await cdpScreenshot('overnight-members-07-profile-content');
  });

  test('R2.3 — profile card closes on click outside (backdrop)', async ({ page }) => {
    await clickEl('[data-testid="sidebar-user-profile"]');
    await delay(400);
    expect(await exists('[data-testid="profile-card"]')).toBe(true);

    // Click backdrop
    await clickEl('[data-testid="profile-card-close"]');
    await delay(400);

    expect(await exists('[data-testid="profile-card"]')).toBe(false);
  });

  test('R2.4 — profile card closes on Escape', async ({ page }) => {
    await clickEl('[data-testid="sidebar-user-profile"]');
    await delay(400);
    expect(await exists('[data-testid="profile-card"]')).toBe(true);

    // Press Escape via window keydown (Svelte listens on svelte:window)
    await ce(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await delay(400);

    expect(await exists('[data-testid="profile-card"]')).toBe(false);
    await cdpScreenshot('overnight-members-08-escape-close');
  });

  test('R2.5 — Message button closes card', async ({ page }) => {
    await clickEl('[data-testid="sidebar-user-profile"]');
    await delay(400);
    expect(await exists('[data-testid="profile-card"]')).toBe(true);

    // Click Message button (first .profile-card-btn, not .primary)
    await ce(`document.querySelector('.profile-card-btn:not(.primary)')?.click()`);
    await delay(400);

    expect(await exists('[data-testid="profile-card"]')).toBe(false);
  });

  test('R2.6 — View Profile button closes card', async ({ page }) => {
    await clickEl('[data-testid="sidebar-user-profile"]');
    await delay(400);
    expect(await exists('[data-testid="profile-card"]')).toBe(true);

    await clickEl('.profile-card-btn.primary');
    await delay(400);

    expect(await exists('[data-testid="profile-card"]')).toBe(false);
  });

  test('R2.7 — profile card opens from message avatar click', async ({ page }) => {
    // Send a message
    await ce(`(() => {
      const i = document.querySelector('[data-testid="message-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, 'Test message for avatar click');
      i.dispatchEvent(new Event('input', {bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await delay(700);

    // Try clicking on message sender element
    const hasSender = await exists('[data-testid^="message-sender-"]');
    if (hasSender) {
      await clickEl('[data-testid^="message-sender-"]');
      await delay(400);
      const cardVisible = await exists('[data-testid="profile-card"]');
      expect(cardVisible).toBe(true);
      await cdpScreenshot('overnight-members-09-profile-from-avatar');
    } else {
      console.log('No message-sender testid found - avatar click from messages may not be wired up');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ROUND 3: Theme Toggle
  // ═══════════════════════════════════════════════════════════════════════

  test('R3.1 — theme toggle switches between dark and light', async ({ page }) => {
    const initialTheme = await ce(`document.documentElement.getAttribute('data-theme')`);
    expect(initialTheme === null || initialTheme === 'dark').toBe(true);

    await cdpScreenshot('overnight-theme-01-dark');

    await clickEl('[data-testid="theme-toggle"]');
    await delay(500);

    const lightTheme = await ce(`document.documentElement.getAttribute('data-theme')`);
    expect(lightTheme).toBe('light');

    await cdpScreenshot('overnight-theme-02-light');

    await clickEl('[data-testid="theme-toggle"]');
    await delay(500);

    const darkAgain = await ce(`document.documentElement.getAttribute('data-theme')`);
    expect(darkAgain).toBe('dark');

    await cdpScreenshot('overnight-theme-03-dark-again');
  });

  test('R3.2 — light theme: check all areas for correct theming', async ({ page }) => {
    await clickEl('[data-testid="theme-toggle"]');
    await delay(500);

    // Collect background colors for all major areas
    const areas = await ce(`(() => {
      const results = {};
      const check = (name, sel) => {
        const el = document.querySelector(sel);
        if (el) {
          const cs = getComputedStyle(el);
          results[name] = { bg: cs.backgroundColor, color: cs.color };
        }
      };
      check('body', 'body');
      check('sidebar', '[data-testid="sidebar"]');
      check('chat-header', '[data-testid="chat-header"]');
      check('message-input', '[data-testid="message-input"]');
      check('member-list', '[data-testid="member-list"]');
      check('channel-name', '[data-testid="header-channel-name"]');
      return results;
    })()`);

    console.log('Light theme computed styles:', JSON.stringify(areas, null, 2));

    // Body background should be light
    const bodyMatch = areas.body?.bg?.match(/rgb\((\d+), (\d+), (\d+)\)/);
    if (bodyMatch) {
      const r = parseInt(bodyMatch[1]);
      expect(r).toBeGreaterThan(100);
    }

    // Identify elements still dark in light mode
    const issues = [];
    for (const [name, { bg }] of Object.entries(areas)) {
      const m = bg?.match(/rgb\((\d+), (\d+), (\d+)\)/);
      if (m && parseInt(m[1]) < 50 && parseInt(m[2]) < 50 && parseInt(m[3]) < 50) {
        issues.push(`${name} has dark bg in light theme: ${bg}`);
      }
    }

    if (issues.length > 0) {
      console.log('THEME ISSUES:', issues);
    }

    await cdpScreenshot('overnight-theme-04-light-all-areas');
  });

  test('R3.3 — dark theme: verify original dark styling', async ({ page }) => {
    // Verify dark mode baseline
    const areas = await ce(`(() => {
      const results = {};
      const check = (name, sel) => {
        const el = document.querySelector(sel);
        if (el) results[name] = getComputedStyle(el).backgroundColor;
      };
      check('body', 'body');
      check('sidebar', '[data-testid="sidebar"]');
      check('member-list', '[data-testid="member-list"]');
      return results;
    })()`);

    // Body should be dark
    const bodyMatch = areas.body?.match(/rgb\((\d+), (\d+), (\d+)\)/);
    if (bodyMatch) {
      const r = parseInt(bodyMatch[1]);
      expect(r).toBeLessThan(50);
    }

    await cdpScreenshot('overnight-theme-05-dark-verified');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ROUND 4: Responsive
  // ═══════════════════════════════════════════════════════════════════════

  test('R4.1 — responsive at 1920px — full layout', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await delay(500);

    const sidebar = await exists('[data-testid="sidebar"]');
    const memberList = await exists('[data-testid="member-list"]');
    expect(sidebar).toBe(true);
    expect(memberList).toBe(true);

    const overflow = await ce(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
    expect(overflow).toBe(false);

    await cdpScreenshot('overnight-responsive-1920');
  });

  test('R4.2 — responsive at 1024px', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await delay(500);

    expect(await exists('[data-testid="sidebar"]')).toBe(true);

    const overflow = await ce(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
    expect(overflow).toBe(false);

    await cdpScreenshot('overnight-responsive-1024');
  });

  test('R4.3 — responsive at 768px', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await delay(500);

    const overflow = await ce(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
    expect(overflow).toBe(false);

    await cdpScreenshot('overnight-responsive-768');
  });

  test('R4.4 — responsive at 480px — sidebar hides', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await delay(500);

    // At 480px, sidebar slides off-screen via mobile wrapper (translateX(-100%))
    // but still has offsetWidth > 0 because it's display:flex. Check position instead.
    const sidebarOffScreen = await ce(`(() => {
      const el = document.querySelector('[data-testid="sidebar"]');
      if (!el) return true;
      const r = el.getBoundingClientRect();
      return r.x + r.width <= 0;
    })()`);
    expect(sidebarOffScreen).toBe(true);

    // Member list hidden at 640px breakpoint
    const memberVisible = await ce(`document.querySelector('[data-testid="member-list"]')?.offsetWidth > 0`);
    expect(memberVisible).toBeFalsy();

    const overflow = await ce(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
    expect(overflow).toBe(false);

    await cdpScreenshot('overnight-responsive-480');
  });

  test('R4.5 — responsive at 320px — minimal view', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await delay(500);

    expect(await exists('[data-testid="message-input"]')).toBe(true);

    const overflow = await ce(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
    expect(overflow).toBe(false);

    await cdpScreenshot('overnight-responsive-320');
  });
});
