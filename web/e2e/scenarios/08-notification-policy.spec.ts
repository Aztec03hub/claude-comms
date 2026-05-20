// 08-notification-policy.spec.ts - Phil Layer B items #9 + #10.
//
// Covers v0.4.2 Step 3.9 (Wave G) + the v0.4.2 App.svelte sendNotification
// micro-fix:
//   - ChannelContextMenu Q8 kebab quickview row: top-most "Notifications:
//     <policy>" item is 1-click cycle (All -> Mentions -> Off -> All) via
//     store.cycleNotificationPolicy + dispatches 'notif:cycle' actionId
//   - ChannelContextMenu "Configure notifications..." item: dispatches the
//     'claude-comms:configure-notifications' window CustomEvent which
//     App.svelte listens for and mounts NotificationPolicyMenu
//   - NotificationPolicyMenu: 3 radio buttons (All / Mentions / Off) +
//     highlight-words text input (comma-separated, lowercased on write)
//   - Save persists to localStorage at `cc:notif-policy:{channelId}` as a
//     JSON-encoded {policy, highlightWords} blob; the in-memory
//     notificationPolicies $state map round-trips both directions
//   - SidebarChannelRow bell variant: hidden when policy='All', shows
//     BellDot when 'Mentions', BellOff when 'Off' (variant-mentions /
//     variant-off CSS classes + data-policy attribute)
//   - App.svelte sendNotification gate: never calls browser Notification
//     when policy='Off'; only fires on mention/highlight when 'Mentions'
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - P-1 source-level regex pins on STORAGE_KEY + policy cycle order +
//     bell variant testids
//   - P-2a triple-side prop-drill source pin: store (data) + menu (cycle
//     trigger) + sidebar row (bell variant render) all pinned for the
//     policy contract
//   - P-3 dual-coverage: functional toast/bell behavior + source pins on
//     the policy enum
//   - P-4 localStorage round-trip both directions (write via Save +
//     pre-set value drives initial form state + bell variant on reload)
//   - P-5 console.error spy at the end of every test
//   - P-8 pre-click state assertions on the popover before interacting
//   - W-2 mitigation: toBeVisible() not querySelector
//   - W-7 mitigation: each test that mutates policy uses a UNIQUE seeded
//     channel OR resets localStorage in a tear-down so cumulative state
//     across tests stays disjoint
//
// Cross-edge contracts (pinned from the brief; if wrong, STOP + surface):
//   - store.getNotificationPolicy(id) -> {policy: 'All'|'Mentions'|'Off',
//     highlightWords: string[]}
//   - store.setNotificationPolicy(id, policy, highlightWords?)
//   - store.cycleNotificationPolicy(id) -> next policy
//   - localStorage key: 'cc:notif-policy:{channelId}'
//   - Bell testid: 'row-notif-bell-{channelId}' with data-policy attribute
//     in {'Mentions', 'Off'}; absent entirely when 'All'
//   - Menu testids: 'channel-ctx-item-notif:cycle' (quickview row),
//     'channel-ctx-item-notif:configure', 'notification-policy-menu',
//     'notif-policy-radio-All' / -Mentions / -Off,
//     'notif-policy-highlight-words', 'notif-policy-save', 'notif-policy-cancel'

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectScreenshot, waitForStable } from '../fixtures/screenshot';
import { canonicalSeed, PHIL, CLAUDE, BOT, SeedSpec } from '../fixtures/seedData';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Slot 7 = ports 10000 (mcp) / 10001 (web). Viewport 1280x900 for the
// menu + popover surfaces (mirrors scenario 05/06).
//
// W-7 mitigation: seed THREE channels owned by phil (key gate) so each
// policy-mutating test exercises a distinct channel and cannot collide
// with another test's persisted state. Channels:
//   - 'policy-alpha': for the kebab-quickview 1-click cycle test
//   - 'policy-bravo': for the Configure-notifications popover + Save
//   - 'policy-charlie': for the highlight-words round-trip + bell variant
const baseSeed = canonicalSeed();
const policySeed: SeedSpec = {
  ...baseSeed,
  channels: [
    ...baseSeed.channels,
    {
      name: 'policy-alpha',
      topic: 'Quickview cycle target',
      created_by: PHIL.key,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key],
    },
    {
      name: 'policy-bravo',
      topic: 'Configure menu target',
      created_by: PHIL.key,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key],
    },
    {
      name: 'policy-charlie',
      topic: 'Highlight words + bell variant target',
      created_by: PHIL.key,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key],
    },
  ],
  roles: [
    ...baseSeed.roles,
    { conversation: 'policy-alpha', participantKey: PHIL.key, role: 'owner' },
    { conversation: 'policy-bravo', participantKey: PHIL.key, role: 'owner' },
    { conversation: 'policy-charlie', participantKey: PHIL.key, role: 'owner' },
  ],
};

test.use({ slot: 7, seedSpec: policySeed, viewport: { width: 1280, height: 900 } });

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = resolve(HERE, '..', '..', 'src', 'lib', 'mqtt-store.svelte.js');
const NOTIF_MENU_PATH = resolve(HERE, '..', '..', 'src', 'components', 'NotificationPolicyMenu.svelte');
const CTX_MENU_PATH = resolve(HERE, '..', '..', 'src', 'components', 'ChannelContextMenu.svelte');
const SIDEBAR_ROW_PATH = resolve(HERE, '..', '..', 'src', 'components', 'SidebarChannelRow.svelte');
const APP_SVELTE_PATH = resolve(HERE, '..', '..', 'src', 'App.svelte');

const STORAGE_KEY_PREFIX = 'cc:notif-policy:';

/**
 * Right-click the channel row to open the ChannelContextMenu, wait for
 * the menu to be visible, and return its locator.
 */
async function openChannelMenu(appPage: import('@playwright/test').Page, channelId: string) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  const row = appPage.locator(`[data-testid="sidebar-channel-row-${channelId}"]`);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('Scenario 08: notification policy', () => {
  test('Kebab quickview row shows "Notifications: All" by default', async ({ appPage, consoleErrors }) => {
    const menu = await openChannelMenu(appPage, 'policy-alpha');

    // P-8 pre-click state: assert the quickview row + its sibling Configure
    // row are visible BEFORE we exercise the cycle action.
    const quickview = menu.locator('[data-testid="channel-ctx-item-notif:cycle"]');
    await expect(quickview).toBeVisible();
    await expect(quickview).toHaveText(/Notifications:\s*All/);
    // Configure item sits right below the quickview row.
    await expect(menu.locator('[data-testid="channel-ctx-item-notif:configure"]')).toBeVisible();

    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('1-click quickview cycles policy All -> Mentions -> Off -> All', async ({ appPage, consoleErrors }) => {
    // P-4 write direction (via the quickview cycle action) plus a pre-test
    // localStorage reset (W-7 mitigation) so this test starts deterministic.
    await appPage.evaluate(
      (key) => localStorage.removeItem(key),
      `${STORAGE_KEY_PREFIX}policy-alpha`,
    );

    // Cycle once: All -> Mentions.
    let menu = await openChannelMenu(appPage, 'policy-alpha');
    await menu.locator('[data-testid="channel-ctx-item-notif:cycle"]').click();
    // Menu closes on action (onClose() fires from fireAction).
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    // localStorage now carries {policy: 'Mentions', highlightWords: []}.
    await expect.poll(
      async () => appPage.evaluate(
        (key) => localStorage.getItem(key),
        `${STORAGE_KEY_PREFIX}policy-alpha`,
      ),
      { timeout: 5000 },
    ).not.toBeNull();
    const after1 = await appPage.evaluate(
      (key) => localStorage.getItem(key),
      `${STORAGE_KEY_PREFIX}policy-alpha`,
    );
    expect(JSON.parse(after1!).policy).toBe('Mentions');

    // Re-open: the quickview label MUST now read "Notifications: Mentions"
    // (read-direction P-4 verification).
    menu = await openChannelMenu(appPage, 'policy-alpha');
    await expect(menu.locator('[data-testid="channel-ctx-item-notif:cycle"]')).toHaveText(/Notifications:\s*Mentions/);

    // Cycle again: Mentions -> Off.
    await menu.locator('[data-testid="channel-ctx-item-notif:cycle"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    const after2 = await appPage.evaluate(
      (key) => localStorage.getItem(key),
      `${STORAGE_KEY_PREFIX}policy-alpha`,
    );
    expect(JSON.parse(after2!).policy).toBe('Off');

    // Cycle again: Off -> All (wrap-around).
    menu = await openChannelMenu(appPage, 'policy-alpha');
    await menu.locator('[data-testid="channel-ctx-item-notif:cycle"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    const after3 = await appPage.evaluate(
      (key) => localStorage.getItem(key),
      `${STORAGE_KEY_PREFIX}policy-alpha`,
    );
    expect(JSON.parse(after3!).policy).toBe('All');

    assertNoConsoleErrors(consoleErrors);
  });

  test('SidebarChannelRow bell variant flips per policy (Hidden / BellDot / BellOff)', async ({ appPage, consoleErrors }) => {
    // P-4 read direction: pre-set localStorage BEFORE the channel row reads
    // it (the row's $derived chain re-runs every time the store's
    // notificationPolicies $state map mutates). The first
    // setNotificationPolicy call populates the in-memory cache; subsequent
    // assertions assert the bell variant follows.
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const bell = appPage.locator('[data-testid="row-notif-bell-policy-alpha"]');

    // Drive the store directly via the quickview cycle so the
    // notificationPolicies $state map flows reactively into the row's
    // $derived(showNotifBell + notifPolicyKind). This exercises the same
    // path users hit when they cycle from the menu.
    //
    // Start from a clean policy state ('All' -> bell absent / count=0).
    await appPage.evaluate(
      (key) => localStorage.removeItem(key),
      `${STORAGE_KEY_PREFIX}policy-alpha`,
    );
    // The cached entry can lag a localStorage wipe; force a clean cache by
    // also clearing the in-memory map for this channel.
    await appPage.evaluate(() => {
      // @ts-expect-error: store is exposed for tests via globalThis
      if (globalThis.store) globalThis.store.notificationPolicies = {};
    });
    // The store may not be globally exposed in production; the source-pin
    // tests below validate it, but functionally we rely on the cycle path.
    await expect(bell).toHaveCount(0);

    // Cycle to Mentions via the menu (1 click).
    let menu = await openChannelMenu(appPage, 'policy-alpha');
    await menu.locator('[data-testid="channel-ctx-item-notif:cycle"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('data-policy', 'Mentions');
    await expect(bell).toHaveClass(/variant-mentions/);

    // Cycle to Off (Mentions -> Off).
    menu = await openChannelMenu(appPage, 'policy-alpha');
    await menu.locator('[data-testid="channel-ctx-item-notif:cycle"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('data-policy', 'Off');
    await expect(bell).toHaveClass(/variant-off/);

    // Cycle to All (Off -> All) -> bell hides.
    menu = await openChannelMenu(appPage, 'policy-alpha');
    await menu.locator('[data-testid="channel-ctx-item-notif:cycle"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    await expect(bell).toHaveCount(0);

    assertNoConsoleErrors(consoleErrors);
  });

  test('"Configure notifications..." opens NotificationPolicyMenu with current state', async ({ appPage, consoleErrors }) => {
    // Pre-seed the policy to 'Mentions' + a highlight word so the popover
    // mounts with non-default state (P-4 read direction).
    await appPage.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [
        `${STORAGE_KEY_PREFIX}policy-bravo`,
        JSON.stringify({ policy: 'Mentions', highlightWords: ['release'] }),
      ],
    );
    // Reload so the store rehydrates the policy from localStorage.
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const menu = await openChannelMenu(appPage, 'policy-bravo');
    await menu.locator('[data-testid="channel-ctx-item-notif:configure"]').click();

    const popover = appPage.locator('[data-testid="notification-policy-menu"]');
    await expect(popover).toBeVisible();
    // P-8: assert all surfaces visible before interacting.
    await expect(popover.locator('[data-testid="notif-policy-radio-All"]')).toBeVisible();
    await expect(popover.locator('[data-testid="notif-policy-radio-Mentions"]')).toBeVisible();
    await expect(popover.locator('[data-testid="notif-policy-radio-Off"]')).toBeVisible();
    await expect(popover.locator('[data-testid="notif-policy-highlight-words"]')).toBeVisible();
    await expect(popover.locator('[data-testid="notif-policy-save"]')).toBeVisible();
    await expect(popover.locator('[data-testid="notif-policy-cancel"]')).toBeVisible();

    // The popover mirrors current state: Mentions radio is checked, the
    // words input pre-fills 'release'.
    await expect(popover.locator('[data-testid="notif-policy-radio-Mentions"]')).toBeChecked();
    await expect(popover.locator('[data-testid="notif-policy-highlight-words"]')).toHaveValue('release');

    // Close cleanly via Cancel so the test does not commit a mutation.
    await popover.locator('[data-testid="notif-policy-cancel"]').click();
    await expect(popover).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('Saving the popover persists policy + highlight words to localStorage', async ({ appPage, consoleErrors }) => {
    // W-7 mitigation: clean state for policy-bravo before this test.
    await appPage.evaluate(
      (key) => localStorage.removeItem(key),
      `${STORAGE_KEY_PREFIX}policy-bravo`,
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const menu = await openChannelMenu(appPage, 'policy-bravo');
    await menu.locator('[data-testid="channel-ctx-item-notif:configure"]').click();

    const popover = appPage.locator('[data-testid="notification-policy-menu"]');
    await expect(popover).toBeVisible();

    // Pick 'Off' radio + type a comma-separated word list.
    await popover.locator('[data-testid="notif-policy-radio-Off"]').check();
    await popover.locator('[data-testid="notif-policy-highlight-words"]').fill('Deploy, BUG, release');
    await popover.locator('[data-testid="notif-policy-save"]').click();

    await expect(popover).not.toBeVisible({ timeout: 5000 });

    // localStorage now carries {policy: 'Off', highlightWords: ['deploy',
    // 'bug', 'release']} -- the store lowercases each word on write per
    // setNotificationPolicy.
    const stored = await appPage.evaluate(
      (key) => localStorage.getItem(key),
      `${STORAGE_KEY_PREFIX}policy-bravo`,
    );
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.policy).toBe('Off');
    // The store lowercases + trims; order is preserved from the input.
    expect(parsed.highlightWords).toEqual(['deploy', 'bug', 'release']);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Cancel discards changes without writing to localStorage', async ({ appPage, consoleErrors }) => {
    // Set a baseline policy first so we can confirm Cancel preserves it.
    await appPage.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [
        `${STORAGE_KEY_PREFIX}policy-bravo`,
        JSON.stringify({ policy: 'All', highlightWords: [] }),
      ],
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const menu = await openChannelMenu(appPage, 'policy-bravo');
    await menu.locator('[data-testid="channel-ctx-item-notif:configure"]').click();

    const popover = appPage.locator('[data-testid="notification-policy-menu"]');
    await expect(popover).toBeVisible();
    // Make changes then Cancel.
    await popover.locator('[data-testid="notif-policy-radio-Off"]').check();
    await popover.locator('[data-testid="notif-policy-highlight-words"]').fill('discarded');
    await popover.locator('[data-testid="notif-policy-cancel"]').click();
    await expect(popover).not.toBeVisible({ timeout: 5000 });

    // Storage stayed at the baseline.
    const stored = await appPage.evaluate(
      (key) => localStorage.getItem(key),
      `${STORAGE_KEY_PREFIX}policy-bravo`,
    );
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.policy).toBe('All');
    expect(parsed.highlightWords).toEqual([]);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Escape closes the popover without writing', async ({ appPage, consoleErrors }) => {
    await appPage.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [
        `${STORAGE_KEY_PREFIX}policy-bravo`,
        JSON.stringify({ policy: 'All', highlightWords: [] }),
      ],
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const menu = await openChannelMenu(appPage, 'policy-bravo');
    await menu.locator('[data-testid="channel-ctx-item-notif:configure"]').click();
    const popover = appPage.locator('[data-testid="notification-policy-menu"]');
    await expect(popover).toBeVisible();

    await popover.locator('[data-testid="notif-policy-radio-Off"]').check();
    await appPage.keyboard.press('Escape');
    await expect(popover).not.toBeVisible({ timeout: 5000 });

    const stored = await appPage.evaluate(
      (key) => localStorage.getItem(key),
      `${STORAGE_KEY_PREFIX}policy-bravo`,
    );
    const parsed = JSON.parse(stored!);
    expect(parsed.policy).toBe('All');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Highlight words round-trip: pre-seeded value pre-fills the input', async ({ appPage, consoleErrors }) => {
    // P-4 read direction: pre-write a multi-word list directly to
    // localStorage, then verify the popover displays the joined form.
    await appPage.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [
        `${STORAGE_KEY_PREFIX}policy-charlie`,
        JSON.stringify({
          policy: 'Mentions',
          highlightWords: ['ship', 'fire', 'urgent'],
        }),
      ],
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const menu = await openChannelMenu(appPage, 'policy-charlie');
    await menu.locator('[data-testid="channel-ctx-item-notif:configure"]').click();

    const popover = appPage.locator('[data-testid="notification-policy-menu"]');
    await expect(popover).toBeVisible();
    // The component joins the words with ", " on mount.
    await expect(popover.locator('[data-testid="notif-policy-highlight-words"]'))
      .toHaveValue('ship, fire, urgent');

    await popover.locator('[data-testid="notif-policy-cancel"]').click();
    await expect(popover).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('Bell variant reflects pre-seeded policy on reload (P-4 full round-trip)', async ({ appPage, consoleErrors }) => {
    // Pre-set policy-charlie to 'Off' + reload + assert the sidebar bell
    // variant renders 'Off' on first paint (no menu interaction needed).
    await appPage.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [
        `${STORAGE_KEY_PREFIX}policy-charlie`,
        JSON.stringify({ policy: 'Off', highlightWords: [] }),
      ],
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const bell = appPage.locator('[data-testid="row-notif-bell-policy-charlie"]');
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('data-policy', 'Off');
    await expect(bell).toHaveClass(/variant-off/);

    assertNoConsoleErrors(consoleErrors);
  });

  test('No state_unsafe_mutation across menu open + cycle + popover save', async ({ appPage, consoleErrors }) => {
    // Load-bearing P-5 + cascade-prevent test (Agent 1's getChannelRole
    // pure-read fix). Walk the full notification-policy surface in one
    // pass: open menu, cycle, open menu again, open Configure popover,
    // save, then verify no state_unsafe_mutation landed.
    await appPage.evaluate(
      (key) => localStorage.removeItem(key),
      `${STORAGE_KEY_PREFIX}policy-alpha`,
    );

    let menu = await openChannelMenu(appPage, 'policy-alpha');
    await menu.locator('[data-testid="channel-ctx-item-notif:cycle"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });

    menu = await openChannelMenu(appPage, 'policy-alpha');
    await menu.locator('[data-testid="channel-ctx-item-notif:configure"]').click();
    const popover = appPage.locator('[data-testid="notification-policy-menu"]');
    await expect(popover).toBeVisible();
    await popover.locator('[data-testid="notif-policy-radio-Off"]').check();
    await popover.locator('[data-testid="notif-policy-save"]').click();
    await expect(popover).not.toBeVisible({ timeout: 5000 });

    // Explicit state_unsafe_mutation enumeration (mirrors scenarios 03/04).
    const cascadeHits = consoleErrors.filter((e) => e.includes('state_unsafe_mutation'));
    expect(cascadeHits).toEqual([]);
    assertNoConsoleErrors(consoleErrors);
  });

  // -------------------------------------------------------------------------
  // Screenshot baselines
  // -------------------------------------------------------------------------

  test('screenshot: quickview-current-policy', async ({ appPage }) => {
    // Clean policy state so the label reads "Notifications: All".
    await appPage.evaluate(
      (key) => localStorage.removeItem(key),
      `${STORAGE_KEY_PREFIX}policy-alpha`,
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    const menu = await openChannelMenu(appPage, 'policy-alpha');
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'quickview-current-policy', {
      locator: menu,
      fullPage: false,
    });
  });

  test('screenshot: menu-open-with-words', async ({ appPage }) => {
    await appPage.evaluate(
      ([key, value]) => localStorage.setItem(key, value),
      [
        `${STORAGE_KEY_PREFIX}policy-charlie`,
        JSON.stringify({
          policy: 'Mentions',
          highlightWords: ['ship', 'fire'],
        }),
      ],
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    const menu = await openChannelMenu(appPage, 'policy-charlie');
    await menu.locator('[data-testid="channel-ctx-item-notif:configure"]').click();
    const popover = appPage.locator('[data-testid="notification-policy-menu"]');
    await expect(popover).toBeVisible();
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'menu-open-with-words', {
      locator: popover,
      fullPage: false,
    });
  });

  test('screenshot: sidebar-bell-variants-by-policy', async ({ appPage }) => {
    // Pre-seed: alpha=All (no bell), bravo=Mentions, charlie=Off so a
    // single sidebar screenshot captures all 3 variants in adjacent rows.
    await appPage.evaluate(
      (entries) => {
        for (const [k, v] of entries) localStorage.setItem(k, v);
      },
      [
        [
          `${STORAGE_KEY_PREFIX}policy-alpha`,
          JSON.stringify({ policy: 'All', highlightWords: [] }),
        ],
        [
          `${STORAGE_KEY_PREFIX}policy-bravo`,
          JSON.stringify({ policy: 'Mentions', highlightWords: [] }),
        ],
        [
          `${STORAGE_KEY_PREFIX}policy-charlie`,
          JSON.stringify({ policy: 'Off', highlightWords: [] }),
        ],
      ] as [string, string][],
    );
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    // The Active section anchors the bell-variant rows.
    const active = appPage.locator('[data-testid="sidebar-channel-section-Active"]');
    await expect(active.locator('[data-testid="sidebar-channel-row-policy-bravo"]')).toBeVisible();
    await expect(active.locator('[data-testid="sidebar-channel-row-policy-charlie"]')).toBeVisible();
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'sidebar-bell-variants-by-policy', {
      locator: active,
      fullPage: false,
    });
  });
});

// -------------------------------------------------------------------------
// Source-level invariants (Pattern P-1 + P-2 + P-2a).
// -------------------------------------------------------------------------

test.describe('source-level invariants: notification policy', () => {
  test('store pins STORAGE_KEY prefix cc:notif-policy:', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-1: pin the localStorage namespace. The Phase 2 tests above read +
    // write via this exact prefix; a future refactor that renames it would
    // silently break the round-trip without this pin.
    expect(src).toMatch(/NOTIF_POLICY_STORAGE_PREFIX\s*=\s*['"]cc:notif-policy:['"]/);
  });

  test('store pins NOTIF_POLICIES enum [All, Mentions, Off]', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-1: pin the enum source so adding/removing a value trips here.
    expect(src).toMatch(/NOTIF_POLICIES\s*=\s*\[\s*['"]All['"]\s*,\s*['"]Mentions['"]\s*,\s*['"]Off['"]\s*\]/);
  });

  test('store pins cycle order All -> Mentions -> Off -> All', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-1: pin the wrap-around order matching the quickview cycle test.
    expect(src).toMatch(/NOTIF_POLICY_CYCLE\s*=\s*\{[\s\S]*?All:\s*['"]Mentions['"]/);
    expect(src).toMatch(/Mentions:\s*['"]Off['"]/);
    expect(src).toMatch(/Off:\s*['"]All['"]/);
  });

  test('store wires getNotificationPolicy / setNotificationPolicy / cycleNotificationPolicy', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-2a triple-side prop-drill: the store is the data side. Pin each
    // accessor by name so a rename surfaces here.
    expect(src).toMatch(/getNotificationPolicy\s*\(\s*channelId\s*\)/);
    expect(src).toMatch(/setNotificationPolicy\s*\(\s*channelId\s*,\s*policy/);
    expect(src).toMatch(/cycleNotificationPolicy\s*\(\s*channelId\s*\)/);
  });

  test('ChannelContextMenu pins notif:cycle quickview + notif:configure rows', () => {
    const src = readFileSync(CTX_MENU_PATH, 'utf-8');
    // P-2a: cycle action + configure action. The cycle row has
    // quickview:true so the menu can render it distinctively.
    expect(src).toMatch(/id:\s*['"]notif:cycle['"]/);
    expect(src).toMatch(/quickview:\s*true/);
    expect(src).toMatch(/id:\s*['"]notif:configure['"]/);
    expect(src).toMatch(/Configure notifications/);
    // The Configure action MUST dispatch the window CustomEvent that
    // App.svelte listens for.
    expect(src).toMatch(/claude-comms:configure-notifications/);
  });

  test('NotificationPolicyMenu pins the data-testid surface + 3 radios', () => {
    const src = readFileSync(NOTIF_MENU_PATH, 'utf-8');
    // P-1: testid surface. Tests above use these verbatim.
    expect(src).toMatch(/data-testid="notification-policy-menu"/);
    expect(src).toMatch(/data-testid="notif-policy-radio-All"/);
    expect(src).toMatch(/data-testid="notif-policy-radio-Mentions"/);
    expect(src).toMatch(/data-testid="notif-policy-radio-Off"/);
    expect(src).toMatch(/data-testid="notif-policy-highlight-words"/);
    expect(src).toMatch(/data-testid="notif-policy-save"/);
    expect(src).toMatch(/data-testid="notif-policy-cancel"/);
  });

  test('SidebarChannelRow pins bell variant testid + variant-mentions / variant-off CSS', () => {
    const src = readFileSync(SIDEBAR_ROW_PATH, 'utf-8');
    // P-2a render-side: the bell variant is the third pinned side of the
    // policy contract (store data + menu trigger + sidebar render).
    expect(src).toMatch(/data-testid="row-notif-bell-/);
    expect(src).toMatch(/class:variant-mentions=/);
    expect(src).toMatch(/class:variant-off=/);
    expect(src).toMatch(/data-policy=/);
  });

  test('App.svelte wires claude-comms:configure-notifications -> NotificationPolicyMenu mount', () => {
    const src = readFileSync(APP_SVELTE_PATH, 'utf-8');
    // P-2 cross-component invariant: App.svelte is the consumer of the
    // ChannelContextMenu CustomEvent (producer pinned above). Both sides
    // pinned so a rename trips one of these tests.
    expect(src).toMatch(/addEventListener\(['"]claude-comms:configure-notifications['"]/);
    expect(src).toMatch(/handleNotifPolicySave/);
    expect(src).toMatch(/store\.setNotificationPolicy\(/);
  });

  test('App.svelte sendNotification toast handler gates by policy (Off / Mentions / All)', () => {
    const src = readFileSync(APP_SVELTE_PATH, 'utf-8');
    // P-1 + P-2 source pin for the Wave G [VERIFY-WAVE-G-1] fix: the
    // toast handler decision tree must enumerate all three policy
    // branches. A regression that drops the Mentions or Off branch would
    // silently re-introduce the muted-channel mention-suppression bug.
    expect(src).toMatch(/policy\.policy\s*===\s*['"]Off['"]/);
    expect(src).toMatch(/policy\.policy\s*===\s*['"]Mentions['"]/);
    expect(src).toMatch(/store\.getNotificationPolicy\(/);
    // Highlight-word resolution must use .includes() (case-insensitive
    // because the store lowercases on write).
    expect(src).toMatch(/highlightWords\.some\(/);
  });
});
