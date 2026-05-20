// topLayer.ts - Z-stacking / top-layer assertion helpers.
//
// Phil's manual Layer B re-pass against v0.4.3 caught Bug 1: right-click
// menus rendered BEHIND other elements (panels with backdrop-filter creating
// new stacking contexts). The automated suite missed it because
// `expect(locator).toBeVisible()` only checks display / opacity / visibility
// / in-viewport - NOT z-stacking. A menu painted under another element
// passes .toBeVisible() perfectly.
//
// This helper closes that hole via `document.elementFromPoint(x, y)`, which
// returns the topmost element at a pixel coordinate. We assert the returned
// element is the target (or a descendant), proving nothing is overlaid.
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - W-8 mitigation: every menu / popover / overlay test must use
//     `expectOnTop()` (or a sibling check that exercises pointer hit-testing)
//     in addition to `toBeVisible()`.
//
// Source: 2026-05-20 v0.4.4 E2E enhancement agent.

import { Page, Locator, expect } from '@playwright/test';

/**
 * Assert `locator` paints on the top of the stacking context: the element at
 * its center coordinates (per `document.elementFromPoint`) is `locator`
 * itself OR a descendant of it.
 *
 * Usage:
 *   const menu = appPage.locator('[data-testid="member-ctx-menu"]');
 *   await expect(menu).toBeVisible();
 *   await expectOnTop(appPage, menu);
 *
 * Why this matters: Bug 1 in v0.4.3 was a menu rendered with z-index 250
 * inside a stacking context that itself was UNDER the right-side panels'
 * backdrop-filter stacking contexts. `.toBeVisible()` returned true (the
 * menu had display:block, opacity:1, and was in the viewport) but the menu
 * was painted UNDER the panel - users could not interact with it. The
 * v0.4.4 fix (`{@attach portal()}` + z-index: 9999) relocates the menu DOM
 * into <body> and bumps the index above 9000. This helper bites if either
 * leg regresses.
 *
 * @param page    Playwright Page (needed for `evaluate` of elementFromPoint).
 * @param locator The target locator we expect on top.
 * @param options.tolerance  Optional inset (px) from the bounding box edges
 *                            when computing the hit point. Default is to
 *                            pick the center.
 */
export async function expectOnTop(
  page: Page,
  locator: Locator,
  options: { tolerance?: number } = {},
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, 'locator must have a bounding box (visible) before checking top-layer').not.toBeNull();
  const inset = options.tolerance ?? 0;
  const x = box!.x + Math.max(0, box!.width / 2 - inset);
  const y = box!.y + Math.max(0, box!.height / 2 - inset);

  const isOnTop = await page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return { hit: null, found: false };
      // Walk up the chain; the target should be the hit OR an ancestor.
      // We bail at <body> so a hit on <html> / <body> is not considered a
      // match for some descendant we are checking.
      let cur: Element | null = hit;
      // Tag the target via a data-* attribute the page evaluate can read.
      // We add it before this call site (see signature below).
      while (cur && cur !== document.body) {
        if ((cur as HTMLElement).dataset?.e2eOnTopProbe === 'target') {
          return {
            hit: hit.tagName.toLowerCase(),
            found: true,
            hitTestId: (hit as HTMLElement).dataset?.testid ?? null,
          };
        }
        cur = cur.parentElement;
      }
      return {
        hit: hit.tagName.toLowerCase(),
        found: false,
        hitTestId: (hit as HTMLElement).dataset?.testid ?? null,
        hitClass: hit.className ?? null,
      };
    },
    { x, y },
  );

  expect(
    isOnTop.found,
    `expected locator to be on top at (${Math.round(x)}, ${Math.round(y)}). ` +
      `Hit element: <${isOnTop.hit}> testid=${JSON.stringify(isOnTop.hitTestId)}`,
  ).toBe(true);
}

/**
 * Convenience: marks the locator's root element with a data-attribute the
 * `expectOnTop` walker recognises, runs the assertion, then strips the
 * attribute. The mark + clear keeps the production DOM clean between
 * assertions (otherwise multiple `expectOnTop` calls would compete for the
 * same attribute).
 *
 * Use this in scenario tests; it is the canonical "menu is on top" pattern.
 */
export async function expectLocatorOnTop(
  page: Page,
  locator: Locator,
  options: { tolerance?: number } = {},
): Promise<void> {
  // Mark.
  await locator.evaluate((el) => {
    (el as HTMLElement).dataset.e2eOnTopProbe = 'target';
  });
  try {
    await expectOnTop(page, locator, options);
  } finally {
    // Clear (even on failure so subsequent tests are not polluted).
    await locator.evaluate((el) => {
      delete (el as HTMLElement).dataset.e2eOnTopProbe;
    });
  }
}

/**
 * Returns the data-testid (if any) of the element at the screen center of
 * `locator`. Useful for diagnostic failures and for tests that want to
 * positively assert "the thing on top is exactly X."
 */
export async function topElementTestIdAt(
  page: Page,
  locator: Locator,
): Promise<string | null> {
  const box = await locator.boundingBox();
  if (!box) return null;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return null;
      // Walk up looking for ANY data-testid (descendants of the menu may not
      // carry one; the menu's root usually does).
      let cur: Element | null = hit;
      while (cur && cur !== document.body) {
        const tid = (cur as HTMLElement).dataset?.testid;
        if (tid) return tid;
        cur = cur.parentElement;
      }
      return null;
    },
    { x, y },
  );
}
