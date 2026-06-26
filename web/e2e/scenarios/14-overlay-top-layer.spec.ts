// 14-overlay-top-layer.spec.ts - Tier-2 (real Chromium) verification of the
// overlay / top-layer overhaul (design §E Tier-2, §F.3).
//
// This is the ONLY place the "actually painted on top" behaviour can be
// asserted: jsdom implements none of the top-layer APIs (no showPopover /
// :popover-open / elementFromPoint), so the vitest guard is a source scan
// and the truth lives here, hit-testing real paint via
// `expectLocatorOnTop` (document.elementFromPoint) from fixtures/topLayer.
//
// Phase 1 migrates exactly ONE overlay - StatusEditor - to the native top
// layer via <Popover>/use:topLayer. The marquee bug: StatusEditor renders
// INSIDE Sidebar's `.sidebar-left` (backdrop-filter => its own stacking
// context), so with the old `position:fixed; z-index:90/91` it painted
// BEHIND the center column and the right-side panels (which also create
// backdrop-filter stacking contexts). The top layer escapes ALL of them.
//
// We deliberately open StatusEditor while a right-side panel WITH
// backdrop-filter (the artifact panel) is open - the exact trap pair from
// the design's worst-case matrix - and assert:
//   1. visible AND on-top (center-pixel hit-test), AND
//   2. the popover is in the native top layer (`:popover-open`).
//   3. Esc (light-dismiss) closes it and focus returns to the trigger.
//   4. Outside-click (light-dismiss) closes it and focus returns.

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectLocatorOnTop } from '../fixtures/topLayer';

// Slot 13 = a dedicated, previously-unused port window (scenarios 00-13
// occupy slots 0-12). The default canonical seed is fine; the status editor
// is a per-user surface.
test.use({ slot: 13, viewport: { width: 1280, height: 900 } });

async function openArtifactPanel(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
  await appPage.locator('[data-testid="chat-header-artifacts-btn"]').click();
  // The artifact panel sets `backdrop-filter`, creating a stacking context
  // that would trap a non-top-layer overlay.
  await expect(appPage.locator('[data-testid="artifact-panel"]')).toBeVisible({
    timeout: 5000,
  });
}

async function openStatusEditor(appPage: import('@playwright/test').Page) {
  const statusRow = appPage.locator('[data-testid="sidebar-profile-status"]');
  await expect(statusRow).toBeVisible();
  await statusRow.click();
  const editor = appPage.locator('[data-testid="status-editor"]');
  await expect(editor).toBeVisible();
  return editor;
}

test.describe('Scenario 14: StatusEditor in the native top layer', () => {
  test('StatusEditor paints ON TOP over a backdrop-filter panel AND is :popover-open', async ({
    appPage,
    consoleErrors,
  }) => {
    await openArtifactPanel(appPage);
    const editor = await openStatusEditor(appPage);

    // (1) on-top: center-pixel hit-test resolves to the editor (or a
    // descendant) even though a backdrop-filter panel is open. This is the
    // assertion that FAILED conceptually before the migration.
    await expectLocatorOnTop(appPage, editor);

    // (2) the popover element is genuinely in the browser top layer.
    const popover = appPage.locator('[data-testid="status-editor-popover"]');
    await expect(popover).toBeVisible();
    const isPopoverOpen = await popover.evaluate((el) =>
      el.matches(':popover-open'),
    );
    expect(isPopoverOpen, 'editor popover must match :popover-open').toBe(true);

    // Close cleanly.
    await editor.locator('[data-testid="status-editor-cancel"]').click();
    await expect(editor).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('Esc light-dismisses the popover and focus returns to the trigger', async ({
    appPage,
    consoleErrors,
  }) => {
    await openArtifactPanel(appPage);
    const editor = await openStatusEditor(appPage);
    await expectLocatorOnTop(appPage, editor);

    await appPage.keyboard.press('Escape');
    await expect(editor).not.toBeVisible({ timeout: 5000 });

    // restoreFocus: the topLayer action returns focus to the element that
    // was focused before the popover opened (the status-row trigger).
    await expect
      .poll(
        () =>
          appPage.evaluate(
            () => document.activeElement?.getAttribute('data-testid') ?? null,
          ),
        { timeout: 5000 },
      )
      .toBe('sidebar-profile-status');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Outside-click light-dismisses the popover and focus returns to the trigger', async ({
    appPage,
    consoleErrors,
  }) => {
    await openArtifactPanel(appPage);
    const editor = await openStatusEditor(appPage);
    await expectLocatorOnTop(appPage, editor);

    // Click a neutral spot well outside the popover (top-center of the chat
    // header). Popover `auto` light-dismiss closes on outside pointerdown.
    await appPage.mouse.click(640, 10);
    await expect(editor).not.toBeVisible({ timeout: 5000 });

    await expect
      .poll(
        () =>
          appPage.evaluate(
            () => document.activeElement?.getAttribute('data-testid') ?? null,
          ),
        { timeout: 5000 },
      )
      .toBe('sidebar-profile-status');

    assertNoConsoleErrors(consoleErrors);
  });
});

// ── Phase 2: the newly-migrated overlays over deliberately-occluding
// surfaces (design §E Tier-2 / §F worst-case trap pairs). Each asserts the
// real "painted on top" hit-test PLUS the native top-layer pseudo-class
// (:popover-open for popovers, :modal for the dialog) that only Chromium can
// evaluate.
async function openGeneral(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
}

test.describe('Scenario 14: anchored popovers + native modal in the top layer', () => {
  test('MentionDropdown paints ON TOP over the message list AND is :popover-open', async ({
    appPage,
    consoleErrors,
  }) => {
    await openGeneral(appPage);
    const input = appPage.locator('[data-testid="message-input"]');
    await input.click();
    // Typing "@" at a word boundary opens the mention autocomplete over the
    // message list (the composer's stacking/overflow context used to clip it).
    await input.pressSequentially('@');

    const dropdown = appPage.locator('[data-testid="mention-dropdown"]');
    await expect(dropdown).toBeVisible();
    await expectLocatorOnTop(appPage, dropdown);
    const isPopoverOpen = await dropdown.evaluate((el) =>
      el.matches(':popover-open'),
    );
    expect(isPopoverOpen, 'mention dropdown must match :popover-open').toBe(true);

    // Keyboard focus is NOT captured by the dropdown - it stays in the
    // textarea (the dropdown is presentational).
    const focusTestId = await appPage.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? null,
    );
    expect(focusTestId).toBe('message-input');

    // Removing the trigger char closes it.
    await input.press('Backspace');
    await expect(dropdown).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('ChannelContextMenu paints ON TOP over an open backdrop-filter panel AND is :popover-open', async ({
    appPage,
    consoleErrors,
  }) => {
    // Open the artifact panel (backdrop-filter -> its own stacking context),
    // the exact trap that used to paint the menu behind the panel.
    await openArtifactPanel(appPage);
    await appPage
      .locator('[data-testid="sidebar-channel-row-general"]')
      .click({ button: 'right' });

    const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
    await expect(menu).toBeVisible();
    await expectLocatorOnTop(appPage, menu);
    const isPopoverOpen = await menu.evaluate((el) =>
      el.matches(':popover-open'),
    );
    expect(isPopoverOpen, 'channel context menu must match :popover-open').toBe(
      true,
    );

    await appPage.keyboard.press('Escape');
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('quick-join is a native :modal dialog (inert background) and Esc-dismisses', async ({
    appPage,
    consoleErrors,
  }) => {
    await openGeneral(appPage);
    await appPage.keyboard.press('Control+j');

    const dialog = appPage.locator('[data-testid="quick-join-dialog"]');
    await expect(dialog).toBeVisible();
    await expectLocatorOnTop(appPage, dialog);
    const isModal = await dialog.evaluate((el) => el.matches(':modal'));
    expect(isModal, 'quick-join must be a native :modal <dialog>').toBe(true);

    // Inert background: a sidebar channel row sits behind the modal scrim and
    // is NOT the topmost element at its own centre (the ::backdrop is).
    const bgRow = appPage.locator('[data-testid="sidebar-channel-row-dev-chat"]');
    const bgInert = await bgRow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top === null || !el.contains(top);
    });
    expect(bgInert, 'background row must be inert behind the modal').toBe(true);

    await appPage.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });
});
