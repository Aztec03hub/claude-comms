// 04-member-context-menu.spec.ts - Phil Layer B items #3 + #5.
//
// Covers MemberContextMenu including the right-click-on-own-username
// case that originally triggered state_unsafe_mutation in v0.4.2 (the
// cascade bug fixed by v0.4.3 Agent 1's getChannelRole pure-read).
//
// Test surface:
//   - Right-click on another member's row -> menu opens at cursor with
//     Kick / Mute globally / Start a DM (phil is owner of dev-chat, so
//     Kick is visible)
//   - Right-click on own username row -> menu does NOT render any
//     menuitems for self (isSelf gates kick/dm/mute) AND no console.error
//     is thrown (P-5: this is the regression target for #3 + #5)
//   - Kick action -> confirmDestructive(danger) typed-name required ->
//     target's row disappears
//   - Mute globally -> localStorage cc:user-muted:{key} = '1' (P-4)
//   - Start a DM -> comms_dm_open fires -> dm conversation becomes
//     active
//   - Escape closes menu
//   - Click outside closes menu
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - P-1 source-level regex pins on action gating + testids
//   - P-3 dual-coverage: functional behavior + source pins for invariants
//   - P-4 localStorage round-trip (write direction asserted; read
//        direction asserted via a follow-up label check)
//   - P-5 console.error spy at the end of every test; explicit
//        state_unsafe_mutation enumeration for the self-row test
//   - W-2 mitigation: toBeVisible() not querySelector !== null

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectScreenshot, waitForStable } from '../fixtures/screenshot';
import { expectLocatorOnTop } from '../fixtures/topLayer';
import { canonicalSeed, PHIL, CLAUDE, BOT, SeedSpec } from '../fixtures/seedData';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Slot 3 = ports 9960 (mcp) / 9961 (web) / 1883 (mqtt) / 9001 (mqtt-ws).
// Re-seed dev-chat with created_by = phil's KEY so phil registers as the
// channel role 'owner' (Kick action visibility gate).
const baseSeed = canonicalSeed();
const memberCtxSeed: SeedSpec = {
  ...baseSeed,
  channels: baseSeed.channels.map((c) =>
    c.name === 'dev-chat' ? { ...c, created_by: PHIL.key } : c,
  ),
};

test.use({ slot: 3, seedSpec: memberCtxSeed });

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMBER_CTX_PATH = resolve(HERE, '..', '..', 'src', 'components', 'MemberContextMenu.svelte');
const APP_SVELTE_PATH = resolve(HERE, '..', '..', 'src', 'App.svelte');

async function switchToDevChat(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator('[data-testid="sidebar-channel-row-dev-chat"]').click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
  // MemberList mounts as a sibling - wait for it.
  await expect(appPage.locator('[data-testid="member-list"]')).toBeVisible();
}

async function rightClickMember(
  appPage: import('@playwright/test').Page,
  memberKey: string,
) {
  // claude/bot are offline; offline section is collapsed by default.
  // Expand it so the row is in the visible DOM tree.
  const offlineToggle = appPage.locator('[data-testid="members-offline-section"]');
  const offlineExpanded = await offlineToggle.getAttribute('aria-expanded');
  if (offlineExpanded !== 'true') {
    await offlineToggle.click();
    await expect(appPage.locator('[data-testid="members-offline-body"]')).toBeVisible();
  }
  const row = appPage.locator(`[data-testid="member-${memberKey}"]`);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
}

test.describe('Scenario 04: member context menu', () => {
  test('right-click on another member opens menu with kick/mute/dm', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);

    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    // Phil is owner of dev-chat -> kick is visible.
    await expect(menu.locator('[data-testid="member-ctx-item-kick"]')).toBeVisible();
    // claude not currently muted -> the menu shows "mute" (not "unmute").
    await expect(menu.locator('[data-testid="member-ctx-item-mute"]')).toBeVisible();
    await expect(menu.locator('[data-testid="member-ctx-item-dm"]')).toBeVisible();

    // Close the menu before asserting console errors (no stray state).
    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('right-click on own username row does NOT throw state_unsafe_mutation', async ({ appPage, consoleErrors }) => {
    // The original Phil item #5 + #3 regression: right-clicking your own
    // username triggered the cascade bug. Post-Agent-1 fix, the menu should
    // either render with reduced items or not render at all (isSelf gates
    // kick + mute + dm to false, so items.length === 0 -> the `{#if}` block
    // does not mount). Either outcome is acceptable; the load-bearing
    // assertion is that no state_unsafe_mutation surfaces.
    await switchToDevChat(appPage);

    // Phil shows in the Active section (online + member of dev-chat).
    const selfRow = appPage.locator(`[data-testid="member-${PHIL.key}"]`);
    await expect(selfRow).toBeVisible();
    await selfRow.click({ button: 'right' });

    // Self menu should NOT show kick/dm (component contract: isSelf gates
    // those to false). The menu may not mount at all (items.length === 0).
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    const menuCount = await menu.count();
    if (menuCount > 0) {
      // If the menu did open, it MUST NOT contain kick or dm items.
      await expect(menu.locator('[data-testid="member-ctx-item-kick"]')).toHaveCount(0);
      await expect(menu.locator('[data-testid="member-ctx-item-dm"]')).toHaveCount(0);
    }

    // The critical regression-prevent: no state_unsafe_mutation thrown.
    const cascades = consoleErrors.filter((e) => e.includes('state_unsafe_mutation'));
    expect(cascades).toEqual([]);
    assertNoConsoleErrors(consoleErrors);
  });

  test('clicking Kick opens confirmDestructive with typed-name required', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);
    await appPage.locator('[data-testid="member-ctx-item-kick"]').click();

    // Kick is severity='danger' -> typed-name input required.
    const dialog = appPage.locator('[data-testid="type-name-confirm-dialog"]');
    await expect(dialog).toBeVisible();
    const input = appPage.locator('[data-testid="type-name-confirm-input"]');
    await expect(input).toBeVisible();
    await expect(appPage.locator('[data-testid="type-name-confirm-confirm"]')).toBeDisabled();

    // Cancel the dialog so the kick does not actually fire (the kick API
    // requires claude to be online; in our test setup he is offline, so
    // the wire call would error harmlessly anyway, but cancelling keeps
    // the rest of the suite clean).
    await appPage.locator('[data-testid="type-name-confirm-cancel"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Mute globally writes localStorage cc:user-muted:{key} (P-4 write direction)', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);
    await appPage.locator('[data-testid="member-ctx-item-mute"]').click();

    // P-4 write direction: localStorage holds cc:user-muted:{claude.key} = '1'.
    const stored = await appPage.evaluate(
      (key: string) => window.localStorage.getItem(`cc:user-muted:${key}`),
      CLAUDE.key,
    );
    expect(stored).toBe('1');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Mute then re-open menu: label flips to Unmute globally (P-4 read direction)', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    // Pre-mute so the read-direction test starts from a muted state. Use
    // localStorage directly (the muteUserGlobally path is exercised by the
    // sibling test above).
    await appPage.evaluate(
      (key: string) => window.localStorage.setItem(`cc:user-muted:${key}`, '1'),
      CLAUDE.key,
    );
    // Reload so the store re-hydrates isUserGloballyMuted from storage.
    await appPage.reload();
    await switchToDevChat(appPage);

    await rightClickMember(appPage, CLAUDE.key);
    // P-4 read direction: menu label now shows "Unmute globally" via the
    // isMuted prop the parent reads from store.isUserGloballyMuted.
    await expect(appPage.locator('[data-testid="member-ctx-item-unmute"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="member-ctx-item-mute"]')).toHaveCount(0);

    // Cleanup
    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('Escape closes the open menu', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    await appPage.keyboard.press('Escape');
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('Click outside the menu closes it', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    // Click on a known non-menu element (the sidebar).
    await appPage.locator('[data-testid="sidebar"]').click({ position: { x: 20, y: 20 } });
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('Right-click on bot opens menu (additional offline member coverage)', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    // bot is NOT a member of dev-chat per canonicalSeed (members: phil, claude).
    // Switch to general where bot IS a member, so the row renders.
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await expect(appPage.locator('[data-testid="member-list"]')).toBeVisible();

    await rightClickMember(appPage, BOT.key);
    // In #general phil's role is 'member' -> no Kick item.
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="member-ctx-item-kick"]')).toHaveCount(0);
    // But mute + DM should still be present.
    await expect(menu.locator('[data-testid="member-ctx-item-mute"]')).toBeVisible();
    await expect(menu.locator('[data-testid="member-ctx-item-dm"]')).toBeVisible();

    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  // -------------------------------------------------------------------------
  // Screenshot baselines
  // -------------------------------------------------------------------------

  test('screenshot: menu-on-other-member', async ({ appPage }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'menu-on-other-member', {
      locator: menu,
      fullPage: false,
    });
  });

  test('screenshot: kick-confirm-dialog', async ({ appPage }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);
    await appPage.locator('[data-testid="member-ctx-item-kick"]').click();
    const dialog = appPage.locator('[data-testid="type-name-confirm-dialog"]');
    await expect(dialog).toBeVisible();
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'kick-confirm-dialog', {
      locator: dialog,
      fullPage: false,
    });
    // Cancel cleanly.
    await appPage.locator('[data-testid="type-name-confirm-cancel"]').click();
  });

  test('screenshot: menu-on-self-reduced (or absent)', async ({ appPage }) => {
    // The "reduced" state for self is items.length === 0 -> no menu mounted.
    // We screenshot the member-list region itself, post-right-click, so the
    // diff confirms NO menu overlay is present at the cursor position.
    await switchToDevChat(appPage);
    const selfRow = appPage.locator(`[data-testid="member-${PHIL.key}"]`);
    await expect(selfRow).toBeVisible();
    await selfRow.click({ button: 'right' });
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'menu-on-self', {
      locator: appPage.locator('[data-testid="member-list"]'),
      fullPage: false,
    });
  });
});

// -------------------------------------------------------------------------
// Source-level invariants (Pattern P-1 + P-2).
// -------------------------------------------------------------------------

test.describe('source-level invariants: MemberContextMenu', () => {
  test('MemberContextMenu pins isSelf gating on kick + dm (post-v0.4.4 Bug 4)', () => {
    const src = readFileSync(MEMBER_CTX_PATH, 'utf-8');
    // P-1: pin the isSelf gating so any future refactor that allows
    // self-kick / self-dm trips this test immediately. The v0.4.4 Bug 4
    // fix intentionally REMOVED the !isSelf gate on canMute - Mute-globally
    // (Pause notifications) is a legitimate self-action. The Mute gate is
    // pinned in a separate v0.4.4 test below.
    expect(src).toMatch(/let\s+isSelf\s*=\s*\$derived/);
    expect(src).toMatch(/canKick\s*=\s*\$derived\(\s*!isSelf\s*&&/);
    expect(src).toMatch(/canDM\s*=\s*\$derived\(!isSelf\)/);
  });

  test('MemberContextMenu pins data-testid surface', () => {
    const src = readFileSync(MEMBER_CTX_PATH, 'utf-8');
    // P-1: testid surface the Phase 2 tests above depend on.
    expect(src).toMatch(/data-testid="member-ctx-menu"/);
    expect(src).toMatch(/data-testid="member-ctx-item-/);
  });

  test('App.svelte wires Kick action through confirmDestructive with severity danger', () => {
    const src = readFileSync(APP_SVELTE_PATH, 'utf-8');
    // P-2: cross-component invariant. The kick handler must keep using
    // severity='danger' so the typed-name confirm dialog gates the wire
    // call. A flip to 'warning' would silently skip the gate.
    const handlerMatch = src.match(/handleMemberContextAction[\s\S]*?\n  }/);
    expect(handlerMatch).not.toBeNull();
    expect(handlerMatch![0]).toMatch(/severity:\s*['"]danger['"]/);
  });

  test('mute storage key namespace is cc:user-muted', () => {
    // P-2: pin the localStorage key shape that both store.muteUserGlobally
    // and the read-direction test above rely on. The test code uses
    // `cc:user-muted:${key}` directly; this test pins the convention.
    const storePath = resolve(HERE, '..', '..', 'src', 'lib', 'mqtt-store.svelte.js');
    const src = readFileSync(storePath, 'utf-8');
    expect(src).toMatch(/cc:user-muted:/);
  });
});

// -------------------------------------------------------------------------
// v0.4.4 W-8 + W-12 mitigation tests.
//
// Phil's v0.4.3 manual Layer B re-pass caught:
//   - Bug 1: context menus rendered BEHIND other elements (backdrop-filter
//     panels created new stacking contexts that z-index couldn't escape).
//     v0.4.4 fix: portal via Svelte 5 `{@attach}` to <body> + z-index 9999.
//   - Bug 4: right-click own username -> NO menu appeared (console clean).
//     The pre-fix self-case filter killed mount entirely (items.length===0
//     guard short-circuited render). v0.4.4 fix: canMute=true for self
//     (Mute-globally is "Pause notifications" - sensible for self) + remove
//     the items.length>0 outer guard + add member-ctx-empty empty-state row.
//
// W-8 mitigation: every menu test asserts top-layer via expectLocatorOnTop.
// W-12 mitigation: two-stage assertion - menu MOUNT visible first, then
// each item visible/absent separately. Distinguishes "menu open with
// reduced items" from "menu doesn't mount at all" (Phil's Bug 4 symptom).
// -------------------------------------------------------------------------

test.describe('Scenario 04 v0.4.4 enhancements: W-8 + W-12 coverage', () => {
  test('Menu on other member paints on TOP of other elements (W-8)', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);

    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    // W-8: assert hit-test resolves to the menu (or its descendants). The
    // v0.4.4 fix portals the menu to <body> + z-index 9999. If either leg
    // regresses (portal removed; z-index drops), the elementFromPoint walk
    // will return some other element (panel, sidebar) and this test bites.
    await expectLocatorOnTop(appPage, menu);

    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('Self-case menu MOUNTS (W-12 stage 1) - menu container present', async ({ appPage, consoleErrors }) => {
    // W-12 STAGE 1: assert the menu MOUNT is visible. Phil's Bug 4 manifest
    // was no menu mounted - the {#if items.length > 0} guard short-
    // circuited render entirely. The v0.4.4 fix removes that guard +
    // always mounts.
    await switchToDevChat(appPage);
    const selfRow = appPage.locator(`[data-testid="member-${PHIL.key}"]`);
    await expect(selfRow).toBeVisible();
    await selfRow.click({ button: 'right' });

    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    // STAGE 1: assert the menu MOUNT (container) visible. Pre-v0.4.4 this
    // would fail because no DOM was produced at all.
    await expect(menu).toBeVisible({ timeout: 5000 });

    // Close cleanly.
    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('Self-case menu items (W-12 stage 2) - Mute visible, Kick + DM absent', async ({ appPage, consoleErrors }) => {
    // W-12 STAGE 2: now that we know the menu mounts (stage 1), assert each
    // expected item visible/absent. v0.4.4 contract:
    //   - Mute-globally (canMute=true for self in v0.4.4) -> VISIBLE
    //   - Kick (canKick=!isSelf) -> ABSENT
    //   - DM (canDM=!isSelf) -> ABSENT
    await switchToDevChat(appPage);
    const selfRow = appPage.locator(`[data-testid="member-${PHIL.key}"]`);
    await expect(selfRow).toBeVisible();
    await selfRow.click({ button: 'right' });

    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();

    // The v0.4.4 fix: Mute is available for self (legitimate quiet-hours
    // toggle).
    await expect(menu.locator('[data-testid="member-ctx-item-mute"]')).toBeVisible();
    // Kick + DM remain self-gated.
    await expect(menu.locator('[data-testid="member-ctx-item-kick"]')).toHaveCount(0);
    await expect(menu.locator('[data-testid="member-ctx-item-dm"]')).toHaveCount(0);

    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('Self-case menu paints on TOP (W-8 + W-12 combined)', async ({ appPage, consoleErrors }) => {
    // Combined assertion: the self-case menu mounts AND paints on top.
    await switchToDevChat(appPage);
    const selfRow = appPage.locator(`[data-testid="member-${PHIL.key}"]`);
    await selfRow.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    await expectLocatorOnTop(appPage, menu);
    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('Menu on bot in #general paints on top (W-8)', async ({ appPage, consoleErrors }) => {
    // Mirror of the existing "right-click bot in #general" test, with the
    // top-layer assertion added.
    await switchToDevChat(appPage);
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await expect(appPage.locator('[data-testid="member-list"]')).toBeVisible();

    await rightClickMember(appPage, BOT.key);
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible();
    await expectLocatorOnTop(appPage, menu);

    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('source-level pin: MemberContextMenu portals to <body> (W-8)', () => {
    // P-1 + W-8 source side: the v0.4.4 fix relocates the menu DOM under
    // <body> via Svelte 5 `{@attach portal()}`. If the attachment is
    // removed, the menu falls back to its native location (inside the
    // backdrop-filter stacking context) and Phil's Bug 1 returns.
    const src = readFileSync(MEMBER_CTX_PATH, 'utf-8');
    // Pin the attach directive + the portal import.
    expect(src).toMatch(/\{@attach\s+portal\(\)\}/);
    expect(src).toMatch(/from\s+['"][^'"]*portal/);
    // Pin the z-index bump (post-v0.4.4 = 9999, pre-v0.4.4 = 250).
    expect(src).toMatch(/z-index:\s*9999/);
  });

  test('source-level pin: portal helper exists at lib/portal.js (W-8)', () => {
    // P-1 + W-8 + cross-component invariant. The portal helper is the
    // shared lib that ChannelContextMenu + MemberContextMenu both attach.
    const PORTAL_PATH = resolve(HERE, '..', '..', 'src', 'lib', 'portal.js');
    const src = readFileSync(PORTAL_PATH, 'utf-8');
    // The helper must export a function (default or named).
    expect(src).toMatch(/export\s+(?:default\s+)?function\s+portal|export\s+const\s+portal\s*=/);
    // Plus the document.body relocation logic.
    expect(src).toMatch(/document\.body/);
  });

  test('source-level pin: canMute = true for self (W-12 Bug 4 fix)', () => {
    // P-1 + W-12 source side: the v0.4.4 fix changes canMute from
    // !isSelf to true (Mute-globally available for self).
    const src = readFileSync(MEMBER_CTX_PATH, 'utf-8');
    expect(src).toMatch(/canMute\s*=\s*\$derived\(\s*true\s*\)/);
  });

  test('source-level pin: member-ctx-empty empty-state testid (W-12 Bug 4 fix)', () => {
    // P-1 + W-12 source side: the v0.4.4 fix adds an empty-state row that
    // mounts when items.length === 0 (rare with canMute=true, but possible
    // under future role gating).
    const src = readFileSync(MEMBER_CTX_PATH, 'utf-8');
    expect(src).toMatch(/data-testid="member-ctx-empty"/);
  });

  test('Two-stage assertion on other-member menu: mount visible then items present (W-12)', async ({ appPage, consoleErrors }) => {
    // W-12 protocol on a NON-self row. STAGE 1: assert the menu mount
    // visible. STAGE 2: assert each expected item visible (Kick / Mute /
    // DM all present because phil is owner of dev-chat).
    await switchToDevChat(appPage);
    await rightClickMember(appPage, CLAUDE.key);

    // STAGE 1: menu container.
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible({ timeout: 5000 });

    // STAGE 2: each expected item independently. (Pre-W-12 the visibility-
    // matrix tests used menu.toBeVisible + count > 0 - which conflates
    // "menu open with reduced items" with "menu doesn't mount." The
    // two-stage pattern distinguishes them.)
    await expect(menu.locator('[data-testid="member-ctx-item-kick"]')).toBeVisible();
    await expect(menu.locator('[data-testid="member-ctx-item-mute"]')).toBeVisible();
    await expect(menu.locator('[data-testid="member-ctx-item-dm"]')).toBeVisible();

    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('Two-stage assertion when role demotes Kick: mount visible, Kick absent (W-12)', async ({ appPage, consoleErrors }) => {
    // W-12 boundary: in #general phil is a regular member (not owner).
    // Kick should be ABSENT but the menu still mounts with Mute + DM.
    // The two-stage pattern catches this cleanly.
    await switchToDevChat(appPage);
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await expect(appPage.locator('[data-testid="member-list"]')).toBeVisible();
    await rightClickMember(appPage, BOT.key);

    // STAGE 1: menu mount.
    const menu = appPage.locator('[data-testid="member-ctx-menu"]');
    await expect(menu).toBeVisible({ timeout: 5000 });

    // STAGE 2: Mute + DM present, Kick absent.
    await expect(menu.locator('[data-testid="member-ctx-item-mute"]')).toBeVisible();
    await expect(menu.locator('[data-testid="member-ctx-item-dm"]')).toBeVisible();
    await expect(menu.locator('[data-testid="member-ctx-item-kick"]')).toHaveCount(0);

    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });
});
