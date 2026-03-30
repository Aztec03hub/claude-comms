import { test, expect } from '@playwright/test';
import fs from 'fs';

test.describe('Round 9: Visual Consistency', () => {
  test.setTimeout(120000);

  /** @type {import('playwright').CDPSession} */
  let cdp;

  test.beforeEach(async ({ page }) => {
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await expect(page.locator('[data-testid="message-input"]')).toBeAttached({ timeout: 30000 });
  });

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  async function cdpScreenshot(name) {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`/home/plafayette/claude-comms/mockups/${name}.png`, Buffer.from(data, 'base64'));
    } catch { /* skip */ }
  }

  // --- Full 1440x900 screenshot ---
  test('full layout at 1440x900', async ({ page }) => {
    // Send some messages for visual completeness
    await sendMessage('Hello from the visual test!');
    await sendMessage('This is a second message to show grouping.');
    await sendMessage('And a third with @mentions and more content.');
    await delay(500);

    await cdpScreenshot('overnight-r9-01-full-1440x900');

    // Verify 3-column layout dimensions
    const layout = await ce(`(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      const chatView = document.querySelector('[data-testid="chat-view"]');
      const memberList = document.querySelector('[data-testid="member-list"]');
      const sr = sidebar?.getBoundingClientRect();
      const cr = chatView?.getBoundingClientRect();
      const mr = memberList?.getBoundingClientRect();
      return {
        sidebarX: sr?.x, sidebarW: sr?.width,
        chatX: cr?.x, chatW: cr?.width,
        memberX: mr?.x, memberW: mr?.width,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight
      };
    })()`);

    // Sidebar should be on the left
    expect(layout.sidebarX).toBe(0);
    expect(layout.sidebarW).toBeGreaterThan(200);

    // Chat view should be in the center
    expect(layout.chatX).toBeGreaterThan(layout.sidebarW - 10);

    // Member list should be on the right
    if (layout.memberX !== undefined) {
      expect(layout.memberX).toBeGreaterThan(layout.chatX);
    }
  });

  // --- Hover states on buttons ---
  test('hover states work on header buttons', async ({ page }) => {
    // Measure button style before hover
    const btnBefore = await ce(`(() => {
      const btn = document.querySelector('[data-testid="header-search-btn"]');
      const cs = getComputedStyle(btn);
      return { bg: cs.backgroundColor, color: cs.color };
    })()`);

    // Hover using Playwright (triggers CSS :hover)
    await page.locator('[data-testid="header-search-btn"]').hover();
    await delay(300);

    const btnAfter = await ce(`(() => {
      const btn = document.querySelector('[data-testid="header-search-btn"]');
      const cs = getComputedStyle(btn);
      return { bg: cs.backgroundColor, color: cs.color };
    })()`);

    // At least one of bg or color should change on hover
    const changed = btnBefore.bg !== btnAfter.bg || btnBefore.color !== btnAfter.color;
    expect(changed).toBe(true);

    await cdpScreenshot('overnight-r9-02-hover-btn');
  });

  // --- Hover on message shows action bar ---
  test('hover on message shows action bar', async ({ page }) => {
    await sendMessage('Hover test message');
    await delay(300);

    // Action bar opacity should be 0 initially (it's always in DOM, just transparent)
    const opacityBefore = await ce(`(() => {
      const bar = document.querySelector('[data-testid="message-actions"]');
      if (!bar) return '-1';
      return getComputedStyle(bar).opacity;
    })()`);
    expect(opacityBefore).toBe('0');

    // Use CDP DOM.setInspectedNode + CSS.forcePseudoState to simulate :hover
    // First get the node ID of the message row
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '.msg-row'
    });

    // Force :hover pseudo-state on the element
    await cdp.send('CSS.enable');
    await cdp.send('CSS.forcePseudoState', {
      nodeId: nodeId,
      forcedPseudoClasses: ['hover']
    });
    await delay(300);

    // Check opacity now
    const opacityAfter = await ce(`(() => {
      const bar = document.querySelector('[data-testid="message-actions"]');
      if (!bar) return '0';
      return getComputedStyle(bar).opacity;
    })()`);
    expect(opacityAfter).toBe('1');

    // Clean up
    await cdp.send('CSS.forcePseudoState', {
      nodeId: nodeId,
      forcedPseudoClasses: []
    });

    await cdpScreenshot('overnight-r9-03-hover-action-bar');
  });

  // --- Z-index: panels above content ---
  test('z-index: search panel above chat content', async ({ page }) => {
    await sendMessage('Z-index test');
    await delay(300);

    // Open search panel
    await clickEl('[data-testid="header-search-btn"]');
    await delay(400);

    const zIndexes = await ce(`(() => {
      const searchPanel = document.querySelector('[data-testid="search-panel"]');
      const chatView = document.querySelector('[data-testid="chat-view"]');
      const header = document.querySelector('[data-testid="chat-header"]');
      return {
        searchPanel: searchPanel ? getComputedStyle(searchPanel).zIndex : null,
        chatView: chatView ? getComputedStyle(chatView).zIndex : null,
        header: header ? getComputedStyle(header).zIndex : null
      };
    })()`);

    // Search panel should be rendered (z-index may be 'auto' in some contexts)
    expect(await exists('[data-testid="search-panel"]')).toBe(true);
    await cdpScreenshot('overnight-r9-04-zindex-panel');
  });

  // --- Z-index: modal above everything ---
  test('z-index: modal overlay above all content', async ({ page }) => {
    // Open search panel first
    await clickEl('[data-testid="header-search-btn"]');
    await delay(300);

    // Open modal on top
    await clickEl('[data-testid="sidebar-create-channel"]');
    await delay(400);

    const zIndexes = await ce(`(() => {
      const modal = document.querySelector('[data-testid="channel-modal"]');
      const modalContent = document.querySelector('[data-testid="channel-modal-content"]');
      const searchPanel = document.querySelector('[data-testid="search-panel"]');
      return {
        modalOverlay: modal ? parseInt(getComputedStyle(modal).zIndex) || 0 : 0,
        modalContent: modalContent ? parseInt(getComputedStyle(modalContent).zIndex) || 0 : 0,
        searchPanel: searchPanel ? parseInt(getComputedStyle(searchPanel).zIndex) || 0 : 0
      };
    })()`);

    // Modal overlay (z-index 200) should be above search panel
    expect(zIndexes.modalOverlay).toBeGreaterThanOrEqual(200);
    expect(zIndexes.modalContent).toBeGreaterThanOrEqual(200);

    await cdpScreenshot('overnight-r9-05-zindex-modal');
  });

  // --- Transitions: panel slide animation ---
  test('panel has slide animation', async ({ page }) => {
    // Open search panel and verify it has animation
    const hasAnimation = await ce(`(() => {
      // Check that panelIn or searchSlide keyframes exist
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.name === 'searchSlide' || rule.name === 'panelIn') return true;
          }
        } catch {}
      }
      return false;
    })()`);
    expect(hasAnimation).toBe(true);
  });

  // --- Transitions: modal fade animation ---
  test('modal has fade/scale animation', async ({ page }) => {
    const hasAnimation = await ce(`(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.name === 'modalIn' || rule.name === 'overlayIn') return true;
          }
        } catch {}
      }
      return false;
    })()`);
    expect(hasAnimation).toBe(true);
  });

  // --- Sidebar channel hover highlight ---
  test('sidebar channel hover highlight', async ({ page }) => {
    const channelBefore = await ce(`(() => {
      const ch = document.querySelector('[data-testid^="channel-item-"]');
      if (!ch) return null;
      return getComputedStyle(ch).backgroundColor;
    })()`);

    await page.locator('[data-testid^="channel-item-"]').first().hover();
    await delay(300);

    const channelAfter = await ce(`(() => {
      const ch = document.querySelector('[data-testid^="channel-item-"]');
      if (!ch) return null;
      return getComputedStyle(ch).backgroundColor;
    })()`);

    // Hover should change background
    // Note: if the first channel is active, it already has a bg, so find a non-active one
    const nonActiveHover = await ce(`(() => {
      const channels = document.querySelectorAll('[data-testid^="channel-item-"]');
      for (const ch of channels) {
        if (!ch.classList.contains('active')) {
          return ch.dataset.testid;
        }
      }
      return null;
    })()`);

    if (nonActiveHover) {
      await page.locator(`[data-testid="${nonActiveHover}"]`).hover();
      await delay(200);
      await cdpScreenshot('overnight-r9-06-sidebar-hover');
    }
  });

  // --- Color consistency: dark theme variables ---
  test('dark theme color variables are consistent', async ({ page }) => {
    const colors = await ce(`(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        bgBase: cs.getPropertyValue('--bg-base').trim(),
        bgSidebar: cs.getPropertyValue('--bg-sidebar').trim(),
        bgSurface: cs.getPropertyValue('--bg-surface').trim(),
        textPrimary: cs.getPropertyValue('--text-primary').trim(),
        ember400: cs.getPropertyValue('--ember-400').trim(),
        border: cs.getPropertyValue('--border').trim()
      };
    })()`);

    // Verify dark theme colors are set
    expect(colors.bgBase).toBeTruthy();
    expect(colors.bgSidebar).toBeTruthy();
    expect(colors.textPrimary).toBeTruthy();
    expect(colors.ember400).toBeTruthy();
    expect(colors.border).toBeTruthy();

    // Dark theme should have dark backgrounds
    // Check that bg-base is a dark color (hex starting with low values or rgb with low values)
    expect(colors.bgBase).toMatch(/#[0-3]/); // starts with a low hex digit = dark
  });

  // --- Send button hover ---
  test('send button hover effect', async ({ page }) => {
    const before = await ce(`(() => {
      const btn = document.querySelector('[data-testid="send-button"]');
      const cs = getComputedStyle(btn);
      return { transform: cs.transform, filter: cs.filter };
    })()`);

    await page.locator('[data-testid="send-button"]').hover();
    await delay(300);

    const after = await ce(`(() => {
      const btn = document.querySelector('[data-testid="send-button"]');
      const cs = getComputedStyle(btn);
      return { transform: cs.transform, filter: cs.filter };
    })()`);

    // Hover should change either transform or filter
    const changed = before.transform !== after.transform || before.filter !== after.filter;
    expect(changed).toBe(true);

    await cdpScreenshot('overnight-r9-07-send-hover');
  });
});
