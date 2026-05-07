/**
 * gallery-screenshots.spec.js — README gallery refresh against the live daemon.
 *
 * Differences from final-screenshots.spec.js:
 *   - Targets the daemon's web UI on http://127.0.0.1:9921 (NOT the dev vite
 *     server) so MQTT actually connects to 127.0.0.1:9001 and the orange
 *     "Establishing secure connection" banner clears.
 *   - Does NOT mock WebSocket and does NOT block Google Fonts. Real fonts +
 *     Noto Color Emoji from CDN ensure emoji glyphs render as glyphs (not
 *     empty rectangles).
 *   - Pre-seeds messages + reactions via two helper scripts:
 *       1. ``seed-gallery-state.py``  (run BEFORE these tests) — wipes the
 *          ``general`` JSONL log, writes a synthetic conversation, restarts
 *          the daemon so the messages replay into the in-memory store.
 *       2. ``seed-live-reactions.py`` (run from each test that needs them)
 *          — publishes synthetic reaction events on the live MQTT topic so
 *          a connected web client paints the reactions bar.
 *
 * Identity model
 *   The daemon's config identity is Phil / a1aece1b / human. The web UI
 *   adopts that identity on connect. Wire ``mentions`` arrays in the seeded
 *   JSONL include "a1aece1b" so MessageBubble's `mention-self` branch fires
 *   (loud amber chip + bubble border accent). Other-bot keys in the JSONL
 *   match the keys returned by the corresponding ``comms_join`` calls so
 *   sender resolution and the participants list line up.
 */

import { test } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const OUT = '/home/plafayette/claude-comms/mockups';
const REPO = '/home/plafayette/claude-comms';
const DAEMON_BASE = 'http://127.0.0.1:9921';
const delay = ms => new Promise(r => setTimeout(r, ms));

test.describe('Gallery Screenshots', () => {
  test.setTimeout(180000);
  // Tests share the seeded daemon state — run them serially so reaction
  // publishes from one test don't bleed into another's screenshot.
  test.describe.configure({ mode: 'serial' });

  /** @type {import('playwright').CDPSession} */
  let cdp;

  test.beforeEach(async ({ page }) => {
    cdp = await page.context().newCDPSession(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(DAEMON_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-testid="message-input"]', { timeout: 30000 });

    // Wait for the connection banner to clear (it auto-hides after 3s on
    // successful MQTT connect). Also gives the participants poll a chance
    // to pick up the seeded ember/phoenix/sage/alex bots.
    await delay(4500);

    // Make sure the messages REST fetch finished and at least the seeded
    // root thread has rendered.
    await page.waitForFunction(
      () => document.querySelectorAll('.bubble').length >= 4,
      { timeout: 15000 },
    );
  });

  async function ce(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('CDP eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async function clickEl(sel) {
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(300);
  }

  async function cdpScreenshot(name) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  }

  /**
   * Publish synthetic reaction events on the live MQTT topic via the
   * seed-live-reactions.py helper. Idempotent — re-running the helper
   * just adds to the active reactions counts on the in-memory bubble,
   * which the local-vs-remote dedup branch in #handleRemoteReaction
   * tolerates (it ignores actor_key === self for the reactions actor we
   * use here, and other actors increment their counts). For our purposes
   * we just call this once per run.
   */
  function publishReactions() {
    try {
      execFileSync('python3', [path.join(REPO, 'web/e2e/seed-live-reactions.py')], {
        stdio: 'inherit',
        timeout: 15000,
      });
    } catch (e) {
      console.warn('[gallery] reaction seed helper failed:', e.message);
    }
  }

  // ----- 01: Main dark-theme view, populated channel -----
  test('01 main dark', async ({ page }) => {
    publishReactions();
    await delay(800);
    await cdpScreenshot('gallery-01-main');
  });

  // ----- 02: Light theme toggled -----
  test('02 light theme', async ({ page }) => {
    publishReactions();
    await delay(400);
    await clickEl('[data-testid="theme-toggle"]');
    await delay(700);
    await cdpScreenshot('gallery-02-light');
  });

  // ----- 03: Mobile (iPhone-12-ish) viewport -----
  test('03 mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await delay(700);
    await cdpScreenshot('gallery-03-mobile');
  });

  // ----- 04: Emoji picker (real glyphs render) -----
  test('04 emoji picker', async ({ page }) => {
    await clickEl('[data-testid="input-emoji"]');
    await delay(700);
    await cdpScreenshot('gallery-04-emoji');
  });

  // ----- 05: Right-click context menu on a message -----
  test('05 context menu', async ({ page }) => {
    publishReactions();
    await delay(400);
    // Right-click the second-to-last bubble (the 'reaction-bait' alex
    // message — visible without needing to scroll).
    const bubbles = await page.locator('.bubble').all();
    const target = bubbles[Math.max(0, bubbles.length - 5)];
    await target.click({ button: 'right', timeout: 5000 });
    await delay(500);
    await cdpScreenshot('gallery-05-context');
  });

  // ----- 06: Thread panel open with replies -----
  test('06 thread panel', async ({ page }) => {
    // Click the thread chip on the seeded root (the phoenix message at
    // ROOT_THREAD_ID has 3 replies wired in the JSONL).
    await ce(`(() => {
      const chip = document.querySelector('[data-testid="thread-indicator"]');
      if (chip) chip.click();
    })()`);
    await delay(900);
    await cdpScreenshot('gallery-06-thread');
  });

  // ----- 07: Self-mention chip + amber bubble border -----
  test('07 mention self', async ({ page }) => {
    // The seeded ember message mentions @Phil with wire mentions=[a1aece1b],
    // which fires the mention-self render branch. Scroll it into view + crop.
    await ce(`(() => {
      const bubble = document.querySelector('.bubble.has-self-mention');
      if (bubble) bubble.scrollIntoView({ block: 'center', behavior: 'instant' });
    })()`);
    await delay(500);
    await cdpScreenshot('gallery-07-mention-self');
  });

  // ----- 08: Whisper bubble (recipients=[a1aece1b]) -----
  test('08 whisper', async ({ page }) => {
    // Capture the seeded phoenix whisper bubble (dashed border + "Targeted
    // message" lock label). Pair it with a /dm draft typed into the
    // composer so the gallery shot shows both halves of the whisper UX
    // in a single frame.
    await ce(`(() => {
      const bubble = document.querySelector('.bubble.bubble-targeted');
      if (bubble) bubble.scrollIntoView({ block: 'center', behavior: 'instant' });
      const i = document.querySelector('[data-testid="message-input"]');
      if (i) {
        const desc = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ) || Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        );
        desc.set.call(i, '/dm @ember psst — between us, looks like we should ship the rc');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.focus();
      }
    })()`);
    await delay(700);
    await cdpScreenshot('gallery-08-whisper');
  });

  // ----- 09: Code-block message with Shiki highlighting -----
  test('09 code block', async ({ page }) => {
    // The alex JS code-block message is mid-stream; scroll it into view.
    await ce(`(() => {
      const cb = document.querySelector('[data-testid="code-block"]');
      if (cb) cb.scrollIntoView({ block: 'center', behavior: 'instant' });
    })()`);
    await delay(700);
    await cdpScreenshot('gallery-09-code-block');
  });

  // ----- 10: Reactions bar -----
  test('10 reactions', async ({ page }) => {
    publishReactions();
    // Reactions need a moment to round-trip through MQTT and apply to the
    // target bubble. Then scroll it into view and capture.
    await delay(1500);
    await ce(`(() => {
      const bar = document.querySelector('.reactions');
      if (bar) bar.scrollIntoView({ block: 'center', behavior: 'instant' });
    })()`);
    await delay(500);
    await cdpScreenshot('gallery-10-reactions');
  });
});
