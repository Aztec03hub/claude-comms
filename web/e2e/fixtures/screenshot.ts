// screenshot.ts — Playwright snapshot helper with deterministic masking.
//
// Phil's mandate (§I.19 iteration log): screenshots are REQUIRED, not optional.
// To keep baselines stable across runs, we mask time-dependent UI surfaces:
//   - .msg-time + .hover-time  (e.g. "12:00", "2h ago")
//   - .brand-version           (version string in sidebar header)
//   - .sidebar-status-dot      (presence animation pulses)
//   - any element with data-testid containing "status" or "presence"
//
// We do NOT mask everything — meaningful pixels (channel names, message
// bodies, layout) ARE captured so visual regressions are caught.

import { Page, Locator, expect } from '@playwright/test';

export interface SnapshotOptions {
  /** Additional selectors to mask (added to the time-dependent defaults). */
  extraMask?: string[];
  /** Allowed pixel diff. Defaults to 500 to match playwright.config.js. */
  maxDiffPixels?: number;
  /** Snapshot file name (without extension). */
  name?: string;
  /** Capture full page vs viewport. Defaults to true. */
  fullPage?: boolean;
  /** Optional locator to screenshot instead of the whole page. */
  locator?: Locator;
}

const TIME_DEPENDENT_SELECTORS = [
  '.msg-time',
  '.hover-time',
  '.brand-version',
  '[data-testid="sidebar-version"]',
  '[data-testid="sidebar-status-dot"]',
  // Animations and pulses
  '.status-dot',
  '.presence-indicator',
];

/**
 * Take a snapshot of `page` (or a `locator`) with consistent masking.
 *
 * Usage:
 *   await expectScreenshot(page, 'sidebar-after-seed');
 *   await expectScreenshot(page, 'chatview-general', { locator: page.locator('.center') });
 *   await expectScreenshot(page, 'message-with-extra-mask', {
 *     extraMask: ['.dynamic-counter'],
 *   });
 */
export async function expectScreenshot(
  page: Page,
  name: string,
  options: SnapshotOptions = {}
): Promise<void> {
  const maskSelectors = [...TIME_DEPENDENT_SELECTORS, ...(options.extraMask ?? [])];
  const mask = maskSelectors.map((sel) => page.locator(sel));

  const screenshotOptions = {
    mask,
    // Default 500: small element captures (e.g. the chat header) diff by a
    // couple hundred px of icon/font anti-aliasing run-to-run on CI (audit
    // W-6/W-7). Behavioral testids gate element presence; this is a visual
    // smoke. Real layout/content regressions far exceed 500px.
    maxDiffPixels: options.maxDiffPixels ?? 500,
    fullPage: options.fullPage ?? true,
    animations: 'disabled' as const,
    caret: 'hide' as const,
  };

  if (options.locator) {
    await expect(options.locator).toHaveScreenshot(`${name}.png`, screenshotOptions);
  } else {
    await expect(page).toHaveScreenshot(`${name}.png`, screenshotOptions);
  }
}

/**
 * Best-effort wait for the page to settle: fonts loaded, no in-flight
 * network requests for 500ms, animations finished. Call before screenshot.
 */
export async function waitForStable(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForLoadState('networkidle');
  // Disable CSS animations for screenshot stability.
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}
