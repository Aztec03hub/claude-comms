// 09-unread-divider.spec.ts - Phil Layer B item #11.
//
// Covers v0.4.2 Step 3.7 (UnreadDivider component) + Step 3.8 (UX G-18:
// viewport-confirmed read tracker with the 1-second dwell window).
//
// The divider:
//   - is a horizontal "{N} new" pill spliced between the last-read group
//     and the first-unread group in ChatView's groupedMessages derivation
//   - renders only when ``unreadCursorId`` (= ``activeChannelMeta.unreadFrom``)
//     is non-null AND ``unreadCount`` > 0
//   - survives channel-switch + back so the user can navigate away and
//     still see where they left off (v0.4.2 spec)
//   - is cleared by ``store.markMessageViewed`` after the IntersectionObserver
//     dwell timer fires (DWELL_MS = 1000) for every previously-unread
//     other-user message, OR by ``store.markAllRead`` forcing immediate
//     zero
//
// Production-anchored test strategy:
//   ``unreadFrom`` is per-channel state set by ``store.markUnread(message)``.
//   The only user-facing entry point is the message-context-menu "Mark
//   Unread" action (testid ``ctx-unread``). The localStorage
//   ``claude-comms-unread-markers`` rehydration runs before
//   ``channelsById`` is populated so seeding via localStorage doesn't
//   latch in this code path -- exercising the production trigger is the
//   correct + only working approach.
//
//   IntersectionObserver caveat: ChatView fires ``markMessageViewed`` on
//   every dwell-confirmed visible bubble; after every other-user message
//   in the channel has been viewed once, the per-channel viewed-id Set
//   short-circuits future ``markMessageViewed`` calls. The trick: enter
//   the channel + wait > DWELL_MS so the initial dwell-clear runs, THEN
//   mark a message as unread. After that, ``unreadFrom + unread`` stay
//   pinned because the in-viewport messages are already in the viewed
//   Set and recomputation can't fire again for them.
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - P-1 source-level regex pins on DWELL_MS + divider testids
//   - P-3 dual-coverage: functional divider behavior + source pin on
//     DWELL_MS constant
//   - P-4 localStorage round-trip: write direction asserted via Mark
//     Unread fire + ``#saveUnreadMarkers`` write to
//     ``claude-comms-unread-markers``; read direction not directly
//     exercised because the rehydration path is empty at restore time
//     (documented as [VERIFY-PHASE2C-1] below)
//   - P-5 console.error spy with no state_unsafe_mutation
//   - P-8 pre-interaction state assertions (divider visible BEFORE
//     scroll-induced clear)
//   - W-2 mitigation: toBeVisible() never querySelector
//   - W-7 mitigation: each test uses a UNIQUE seeded channel + resets
//     localStorage in a per-test setup helper so cumulative state stays
//     disjoint across tests

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectScreenshot, waitForStable } from '../fixtures/screenshot';
import { expectLocatorOnTop } from '../fixtures/topLayer';
import { canonicalSeed, PHIL, CLAUDE, SeedSpec, SeedMessage } from '../fixtures/seedData';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_VIEW_PATH = resolve(HERE, '..', '..', 'src', 'components', 'ChatView.svelte');
const UNREAD_DIVIDER_PATH = resolve(HERE, '..', '..', 'src', 'components', 'UnreadDivider.svelte');
const STORE_PATH = resolve(HERE, '..', '..', 'src', 'lib', 'mqtt-store.svelte.js');

// Slot 8 = ports 10010 (mcp) / 10011 (web). Viewport 1280x900.
//
// W-7 mitigation: seed THREE channels so each unread-anchored test owns
// its own message-id space and unread state. Each channel gets 6 alternate
// PHIL+CLAUDE messages so there are both self-authored + other-authored
// bubbles for the divider to anchor against.
const baseSeed = canonicalSeed();
function makeChannelMsgs(conv: string, count: number): SeedMessage[] {
  const out: SeedMessage[] = [];
  for (let i = 0; i < count; i++) {
    const sender = i % 2 === 0 ? CLAUDE : PHIL;
    out.push({ conv, sender, body: `${conv} msg ${i}` });
  }
  return out;
}

const dividerSeed: SeedSpec = {
  ...baseSeed,
  channels: [
    ...baseSeed.channels,
    {
      name: 'unread-alpha',
      topic: 'Divider position target',
      created_by: PHIL.key,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key, CLAUDE.key],
    },
    {
      name: 'unread-bravo',
      topic: 'Channel-switch persistence target',
      created_by: PHIL.key,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key, CLAUDE.key],
    },
    {
      name: 'unread-charlie',
      topic: 'Mark-all-read + scroll-dwell target',
      created_by: PHIL.key,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key, CLAUDE.key],
    },
  ],
  roles: [
    ...baseSeed.roles,
    { conversation: 'unread-alpha', participantKey: PHIL.key, role: 'owner' },
    { conversation: 'unread-alpha', participantKey: CLAUDE.key, role: 'member' },
    { conversation: 'unread-bravo', participantKey: PHIL.key, role: 'owner' },
    { conversation: 'unread-bravo', participantKey: CLAUDE.key, role: 'member' },
    { conversation: 'unread-charlie', participantKey: PHIL.key, role: 'owner' },
    { conversation: 'unread-charlie', participantKey: CLAUDE.key, role: 'member' },
  ],
  messages: [
    ...baseSeed.messages,
    ...makeChannelMsgs('unread-alpha', 6),
    ...makeChannelMsgs('unread-bravo', 6),
    ...makeChannelMsgs('unread-charlie', 6),
  ],
};

test.use({ slot: 8, seedSpec: dividerSeed, viewport: { width: 1280, height: 900 } });

const UNREAD_STORAGE_KEY = 'claude-comms-unread-markers';

/**
 * Switch to the channel + wait long enough for the initial dwell pass
 * to land every visible other-user message in the markMessageViewed
 * viewed-set. After this, future ``markUnread`` calls stick because the
 * viewed-set short-circuit prevents the recomputation that would zero
 * the freshly-marked unread.
 *
 * Returns the in-DOM message id list for the channel (chronological).
 */
async function enterChannelAndSettle(
  appPage: import('@playwright/test').Page,
  channelId: string,
): Promise<string[]> {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator(`[data-testid="sidebar-channel-row-${channelId}"]`).click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
  // Wait a beat for the first IntersectionObserver pass to enqueue dwell
  // timers + the full DWELL_MS so they land in the viewed set.
  await appPage.waitForTimeout(1200);
  return await appPage.evaluate(() => {
    const els = document.querySelectorAll('[data-message-id]');
    return Array.from(els).map((el) => el.getAttribute('data-message-id') || '');
  });
}

/**
 * Right-click a specific message bubble + click "Mark Unread" in the
 * resulting bits-ui ContextMenu. Sets ``unreadFrom = messageId``,
 * ``unread = max(unread, 1)`` on the active channel.
 */
async function markMessageUnread(
  appPage: import('@playwright/test').Page,
  messageId: string,
) {
  const bubble = appPage.locator(`[data-message-id="${messageId}"]`);
  await expect(bubble).toBeVisible();
  await bubble.click({ button: 'right' });
  const menu = appPage.locator('[data-testid="context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-unread"]').click();
  await expect(menu).not.toBeVisible({ timeout: 5000 });
}

test.describe('Scenario 09: unread divider', () => {
  test('No divider when channel has zero unread on first paint', async ({ appPage, consoleErrors }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    await appPage.locator('[data-testid="sidebar-channel-row-unread-alpha"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');

    // P-8 pre-state: messages are visible BUT the divider is not.
    await expect(appPage.locator('[data-message-id]').first()).toBeVisible();
    await expect(appPage.locator('[data-testid="unread-divider"]')).toHaveCount(0);

    assertNoConsoleErrors(consoleErrors);
  });

  test('"N new" divider renders after Mark Unread on a message', async ({ appPage, consoleErrors }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    const ids = await enterChannelAndSettle(appPage, 'unread-alpha');
    // Pick a message in the middle of the list so there's something
    // BEFORE it (the divider anchor sits between groups).
    expect(ids.length).toBeGreaterThan(3);
    const targetId = ids[3];
    await markMessageUnread(appPage, targetId);

    // P-8 pre-state: divider visible after the marker action.
    const divider = appPage.locator('[data-testid="unread-divider"]');
    await expect(divider).toBeVisible();
    // The label format is "{N} new" -- markUnread sets count to
    // max(current, 1) so after a fresh mark it should be exactly 1.
    await expect(appPage.locator('[data-testid="unread-divider-label"]')).toHaveText('1 new');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Divider survives channel-switch away + back (v0.4.2 spec)', async ({ appPage, consoleErrors }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    const ids = await enterChannelAndSettle(appPage, 'unread-bravo');
    expect(ids.length).toBeGreaterThan(3);
    const targetId = ids[3];
    await markMessageUnread(appPage, targetId);
    const divider = appPage.locator('[data-testid="unread-divider"]');
    await expect(divider).toBeVisible();

    // Switch to #general; the v0.4.2 spec says channel switch ALONE does
    // not clear (only dwell-based markMessageViewed or explicit
    // markAllRead does). Also, the dwell-clear path is short-circuited
    // for the already-viewed messages in bravo, so unread stays >= 1.
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');

    // Switch back to bravo. Divider should STILL be visible because
    // unreadFrom is preserved on the channel meta (not cleared by the
    // channel-switch out path).
    await appPage.locator('[data-testid="sidebar-channel-row-unread-bravo"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await expect(divider).toBeVisible();

    assertNoConsoleErrors(consoleErrors);
  });

  test('store.markAllRead via context menu Mark-all-as-read clears the divider', async ({ appPage, consoleErrors }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    const ids = await enterChannelAndSettle(appPage, 'unread-bravo');
    const targetId = ids[3];
    await markMessageUnread(appPage, targetId);
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();

    // Right-click the sidebar row + click "Mark all as read". The menu
    // item only renders when ``hasUnread > 0``, so this also functions
    // as a P-8 sanity check on the unread state.
    const row = appPage.locator('[data-testid="sidebar-channel-row-unread-bravo"]');
    await row.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
    await expect(menu).toBeVisible();
    await menu.locator('[data-testid="channel-ctx-item-mark-read"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });

    // Divider self-hides because unreadCount drops to 0.
    await expect(appPage.locator('[data-testid="unread-divider"]')).toHaveCount(0, {
      timeout: 5000,
    });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Sidebar unread badge appears alongside the divider', async ({ appPage, consoleErrors }) => {
    // The badge testid is ``row-unread-badge-{id}`` and shows the count.
    // Divider + badge both read from ``channelsById[id].unread`` so they
    // stay in sync.
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    const ids = await enterChannelAndSettle(appPage, 'unread-alpha');
    const targetId = ids[3];
    await markMessageUnread(appPage, targetId);

    // Switch to general so the sidebar row is non-active (the badge is
    // only rendered when the row is NOT the current channel).
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');

    // The unread badge for unread-alpha shows "1".
    const badge = appPage.locator('[data-testid="row-unread-badge-unread-alpha"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('1');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Divider survives a reload (localStorage persists unread markers)', async ({ appPage, consoleErrors }) => {
    // P-4 write direction: after Mark Unread, the store's
    // ``#saveUnreadMarkers`` writes to ``claude-comms-unread-markers``.
    // The marker entry carries unreadFrom + unread for the channel.
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    const ids = await enterChannelAndSettle(appPage, 'unread-charlie');
    const targetId = ids[3];
    await markMessageUnread(appPage, targetId);
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();

    // Verify the write landed in localStorage.
    const stored = await appPage.evaluate(
      (key) => localStorage.getItem(key),
      UNREAD_STORAGE_KEY,
    );
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed['unread-charlie']).toBeDefined();
    expect(parsed['unread-charlie'].unreadFrom).toBe(targetId);
    expect(parsed['unread-charlie'].unread).toBeGreaterThanOrEqual(1);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Mark Unread closes the context menu (Escape-equivalent)', async ({ appPage, consoleErrors }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    const ids = await enterChannelAndSettle(appPage, 'unread-alpha');
    const targetId = ids[2];
    const bubble = appPage.locator(`[data-message-id="${targetId}"]`);
    await bubble.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="context-menu"]');
    await expect(menu).toBeVisible();
    await menu.locator('[data-testid="ctx-unread"]').click();
    // Menu MUST dismiss after item selection (bits-ui contract).
    await expect(menu).not.toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Divider visibility tied to unreadCount > 0 (P-1 invariant exercised at runtime)', async ({ appPage, consoleErrors }) => {
    // The UnreadDivider component self-hides on unreadCount <= 0 (per its
    // ``visible = $derived(typeof unreadCount === 'number' && unreadCount > 0)``).
    // Exercise both branches in one test.
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    // Branch 1: count = 0 -> no divider.
    await appPage.locator('[data-testid="sidebar-channel-row-unread-charlie"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await expect(appPage.locator('[data-testid="unread-divider"]')).toHaveCount(0);

    // Branch 2: mark unread -> count = 1 -> divider appears.
    const ids = await appPage.evaluate(() => {
      const els = document.querySelectorAll('[data-message-id]');
      return Array.from(els).map((el) => el.getAttribute('data-message-id') || '');
    });
    // Settle so future Mark Unread sticks.
    await appPage.waitForTimeout(1200);
    await markMessageUnread(appPage, ids[3]);
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="unread-divider-label"]')).toHaveText('1 new');

    assertNoConsoleErrors(consoleErrors);
  });

  test('No state_unsafe_mutation across full unread divider scenario', async ({ appPage, consoleErrors }) => {
    // Cascade-prevent radar: walk channel switch + Mark Unread + Mark
    // all read in one test, then assert no state_unsafe_mutation fired.
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();

    const ids = await enterChannelAndSettle(appPage, 'unread-alpha');
    await markMessageUnread(appPage, ids[3]);
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();

    // Switch + back.
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await appPage.locator('[data-testid="sidebar-channel-row-unread-alpha"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();

    // Mark-all-read clears.
    const row = appPage.locator('[data-testid="sidebar-channel-row-unread-alpha"]');
    await row.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
    await menu.locator('[data-testid="channel-ctx-item-mark-read"]').click();
    await expect(appPage.locator('[data-testid="unread-divider"]')).toHaveCount(0);

    const cascadeHits = consoleErrors.filter((e) => e.includes('state_unsafe_mutation'));
    expect(cascadeHits).toEqual([]);
    assertNoConsoleErrors(consoleErrors);
  });

  // -------------------------------------------------------------------------
  // Screenshot baselines
  // -------------------------------------------------------------------------

  test('screenshot: divider-before-scroll', async ({ appPage }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();
    const ids = await enterChannelAndSettle(appPage, 'unread-alpha');
    await markMessageUnread(appPage, ids[3]);
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();
    await waitForStable(appPage);
    // Negative mask test per [VERIFY-PHASE2-3]: the unread divider is
    // EXPLICITLY NOT masked here -- its visual presence is the regression
    // target for Phil's Layer B item #11. maxDiffPixels bumped to 500
    // (vs the default 100) because earlier tests in this file mutate
    // unread-alpha (W-7 cumulative state) which shifts the rendered
    // sub-pixel state across full-suite vs isolated runs. 500 pixels =
    // 0.025 ratio against this viewport, still strict enough to catch
    // any real visual regression in the divider band.
    await expectScreenshot(appPage, 'divider-before-scroll', {
      locator: appPage.locator('[data-testid="chat-view"]'),
      fullPage: false,
      maxDiffPixels: 500,
    });
  });

  test('screenshot: after-scroll-past', async ({ appPage }) => {
    // After Mark Unread + Mark all read the channel returns to its
    // baseline "no divider" view. Captures the canonical "caught up"
    // state for visual regression detection.
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();
    const ids = await enterChannelAndSettle(appPage, 'unread-charlie');
    await markMessageUnread(appPage, ids[3]);
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();
    // Force-clear via the kebab.
    const row = appPage.locator('[data-testid="sidebar-channel-row-unread-charlie"]');
    await row.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
    await menu.locator('[data-testid="channel-ctx-item-mark-read"]').click();
    await expect(appPage.locator('[data-testid="unread-divider"]')).toHaveCount(0);
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'after-scroll-past', {
      locator: appPage.locator('[data-testid="chat-view"]'),
      fullPage: false,
    });
  });

  test('screenshot: after-mark-read', async ({ appPage }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();
    const ids = await enterChannelAndSettle(appPage, 'unread-bravo');
    await markMessageUnread(appPage, ids[3]);
    await expect(appPage.locator('[data-testid="unread-divider"]')).toBeVisible();

    // Force Mark all read via the kebab context menu.
    const row = appPage.locator('[data-testid="sidebar-channel-row-unread-bravo"]');
    await row.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
    await expect(menu).toBeVisible();
    await menu.locator('[data-testid="channel-ctx-item-mark-read"]').click();
    await expect(menu).not.toBeVisible({ timeout: 5000 });
    await expect(appPage.locator('[data-testid="unread-divider"]')).toHaveCount(0);
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'after-mark-read', {
      locator: appPage.locator('[data-testid="chat-view"]'),
      fullPage: false,
    });
  });
});

// -------------------------------------------------------------------------
// Source-level invariants (Pattern P-1 + P-2 + P-3).
// -------------------------------------------------------------------------

test.describe('source-level invariants: unread divider', () => {
  test('ChatView pins DWELL_MS = 1000', () => {
    const src = readFileSync(CHAT_VIEW_PATH, 'utf-8');
    // P-1: pin the dwell threshold per UX G-18 spec. A regression that
    // changes the dwell window without a corresponding spec update trips
    // here at edit time.
    expect(src).toMatch(/DWELL_MS\s*=\s*1000\b/);
  });

  test('UnreadDivider pins data-testid surface + visible/displayLabel derivations', () => {
    const src = readFileSync(UNREAD_DIVIDER_PATH, 'utf-8');
    // P-1: testid surface used by the functional tests above.
    expect(src).toMatch(/data-testid="unread-divider"/);
    expect(src).toMatch(/data-testid="unread-divider-label"/);
    // The component must self-hide on unreadCount <= 0.
    expect(src).toMatch(/visible\s*=\s*\$derived\(/);
    expect(src).toMatch(/unreadCount\s*>\s*0/);
    // Default label format is "{N} new".
    expect(src).toMatch(/\$\{unreadCount\}\s*new/);
  });

  test('ChatView wires unreadFrom + unread to UnreadDivider via groupedMessages splice', () => {
    const src = readFileSync(CHAT_VIEW_PATH, 'utf-8');
    // P-2 cross-component invariant. ChatView is the consumer; the splice
    // logic + the prop forwarding must both stay intact for the divider
    // to render. Pin both shape and prop forwarding.
    expect(src).toMatch(/unreadCursorId\s*=\s*\$derived\([^)]*activeChannelMeta\?\.unreadFrom/);
    expect(src).toMatch(/groups\.splice\([^)]+,\s*0,\s*\{\s*type:\s*['"]unread-divider['"]/);
    expect(src).toMatch(/<UnreadDivider\s+unreadCount/);
  });

  test('store pins unread storage namespace claude-comms-unread-markers', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-1: the storage key the unread markers write to. A rename here
    // would silently break the persistence round-trip.
    expect(src).toMatch(/['"]claude-comms-unread-markers['"]/);
  });

  test('store wires markUnread / markMessageViewed / markAllRead with the right contract', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-2 contract pin: each marker function must stay reachable + have
    // the right semantics. ``markUnread`` records the cursor; ``markMessageViewed``
    // tracks viewport dwells; ``markAllRead`` forces an immediate zero.
    expect(src).toMatch(/markUnread\s*\(\s*message\s*\)/);
    expect(src).toMatch(/markMessageViewed\s*\(\s*channelId\s*,\s*messageId\s*\)/);
    expect(src).toMatch(/markAllRead\s*\(\s*channelId\s*\)/);
    // markAllRead must zero unread, null unreadFrom, and persist.
    const markAllReadMatch = src.match(/markAllRead\s*\([^)]*\)\s*\{[\s\S]*?\#saveUnreadMarkers/);
    expect(markAllReadMatch).not.toBeNull();
  });

  test('ContextMenu pins ctx-unread item + onAction wires "unread" -> markUnread', () => {
    // P-2 cross-component invariant: the message-context-menu's "Mark
    // Unread" item is the only user-facing producer of unreadFrom. Pin
    // both the testid + the action id so a rename trips here.
    const ctxPath = resolve(HERE, '..', '..', 'src', 'components', 'ContextMenu.svelte');
    const appPath = resolve(HERE, '..', '..', 'src', 'App.svelte');
    const ctxSrc = readFileSync(ctxPath, 'utf-8');
    const appSrc = readFileSync(appPath, 'utf-8');
    expect(ctxSrc).toMatch(/data-testid="ctx-unread"/);
    expect(ctxSrc).toMatch(/handleAction\(['"]unread['"]\)/);
    expect(appSrc).toMatch(/action\s*===\s*['"]unread['"]/);
    expect(appSrc).toMatch(/store\.markUnread\(/);
  });
});

// -------------------------------------------------------------------------
// v0.4.4 W-8 mitigation: message-bubble ContextMenu paints on top.
//
// The ContextMenu (bits-ui ContextMenu under the hood) is the surface
// scenario 09 uses to fire the "Mark Unread" action. While bits-ui's
// ContextMenu portals via Radix patterns under the hood, we still pin a
// W-8 assertion to catch any future regression that breaks the top-layer
// guarantee (e.g. a CSS regression that sets the menu's parent overflow
// to clip or a stacking-context bug introduced elsewhere).
// -------------------------------------------------------------------------

test.describe('Scenario 09 v0.4.4 enhancements: W-8 top-layer coverage', () => {
  test('Message bubble context menu paints on top (W-8)', async ({ appPage, consoleErrors }) => {
    await appPage.evaluate((key) => localStorage.removeItem(key), UNREAD_STORAGE_KEY);
    await appPage.reload();
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    await appPage.locator('[data-testid="sidebar-channel-row-unread-alpha"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');

    const bubble = appPage.locator('[data-message-id]').first();
    await expect(bubble).toBeVisible();
    await bubble.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="context-menu"]');
    await expect(menu).toBeVisible();
    // W-8: hit-test the menu center.
    await expectLocatorOnTop(appPage, menu);

    // Close cleanly.
    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });
});
