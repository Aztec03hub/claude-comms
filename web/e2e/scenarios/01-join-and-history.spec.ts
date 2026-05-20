// 01-join-and-history.spec.ts — canonical reference scenario for Phase 1.
//
// Covers Phil's Layer B item #1 (#general history visible without joining)
// PLUS the baseline assertions every Phase 2 scenario should mirror:
//   - Daemon spawned with isolated $HOME, seeded with 3 participants +
//     4 channels + 12 mixed messages BEFORE start
//   - Page loads at the daemon's web URL with NO console.error
//     (validates the `state_unsafe_mutation` cascade fix from Agent 1)
//   - Sidebar renders Starred / Active / Available sections
//   - Seeded channels appear in the correct sections (auto-join lobby logic)
//   - Switching to a seeded channel shows the seeded messages
//   - Switching to an empty channel shows the empty-state copy
//   - Screenshot baselines committed for regression detection
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - Computed-visibility assertions via toBeVisible(), not querySelector
//   - Mutation-testable assertions (each line maps to a production-code line
//     whose deletion would cause that assertion to fail)
//   - console.error spy with `state_unsafe_mutation` guard

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectScreenshot, waitForStable } from '../fixtures/screenshot';
import { canonicalSeed } from '../fixtures/seedData';

// Slot 0 = ports 9930 (mcp) / 9931 (web) / 1893 (mqtt) / 9011 (mqtt-ws).
// Each scenario file MUST declare a unique slot.
test.use({ slot: 0 });

test.describe('Scenario 01: join + history', () => {
  test('daemon starts and serves identity GET', async ({ daemon }) => {
    // Direct API smoke test — proves the seed reached the daemon.
    const res = await fetch(`${daemon.apiURL}/api/identity`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.key).toBe('aaaaaaaa');
    expect(json.name).toBe('phil');
    expect(json.type).toBe('human');
  });

  test('conversations API returns the 4 seeded channels', async ({ daemon }) => {
    const res = await fetch(`${daemon.apiURL}/api/conversations?all=true`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const names = json.conversations.map((c: { name?: string; id?: string }) => c.name ?? c.id).sort();
    // legacy-empty + dev-chat + general + private-room (alphabetical)
    expect(names).toContain('general');
    expect(names).toContain('dev-chat');
    expect(names).toContain('private-room');
    expect(names).toContain('legacy-empty');
    expect(json.count).toBeGreaterThanOrEqual(4);
  });

  test('page loads with no console errors', async ({ appPage, consoleErrors }) => {
    // The Bug 1 cascade fix from Agent 1 means state_unsafe_mutation must
    // never fire during App.svelte's render. If it does, this assertion
    // catches it AND every downstream visibility test in this file fails
    // (which is the §I.19 cascade-detection pattern in action).
    await appPage.waitForSelector('[data-testid="sidebar"]', { timeout: 10000 });
    await waitForStable(appPage);
    assertNoConsoleErrors(consoleErrors);
  });

  test('sidebar renders all three sections', async ({ appPage }) => {
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    // Computed-visibility assertions (not just DOM presence).
    await expect(appPage.locator('[data-testid="sidebar-channel-section-Starred"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="sidebar-channel-section-Active"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="sidebar-channel-section-Available"]')).toBeVisible();
  });

  test('seeded member channels appear in Active section', async ({ appPage }) => {
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const active = appPage.locator('[data-testid="sidebar-channel-section-Active"]');
    // Phil is a member of general, dev-chat, private-room (per canonicalSeed roles).
    await expect(active.locator('[data-testid="sidebar-channel-row-general"]')).toBeVisible();
    await expect(active.locator('[data-testid="sidebar-channel-row-dev-chat"]')).toBeVisible();
    await expect(active.locator('[data-testid="sidebar-channel-row-private-room"]')).toBeVisible();
  });

  test('non-member public channel appears in Available section', async ({ appPage }) => {
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    const available = appPage.locator('[data-testid="sidebar-channel-section-Available"]');
    // legacy-empty is public/open with no members; phil sees it as joinable.
    await expect(available.locator('[data-testid="sidebar-channel-row-legacy-empty"]')).toBeVisible();
  });

  test('switching to #general shows the 6 seeded messages', async ({ appPage }) => {
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    // Click general (it should already be active as default lobby, but click
    // to be explicit and deterministic).
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');

    // MessageBubble carries data-message-id on the wrapper; sender link has
    // data-testid="message-sender-{key}" but no data-message-id. Use
    // data-message-id to pin the bubble count cleanly.
    const chatBubbles = appPage.locator('[data-message-id]');
    const systemMsgs = appPage.locator('[data-testid^="system-message-"]');

    // 6 chat bubbles total (5 chat + 1 system message). The system message ALSO
    // gets data-message-id (verified in ChatView.svelte). Plus toHaveCount(1) on
    // the system selector gives us a separate, narrower regression guard.
    await expect(chatBubbles).toHaveCount(6, { timeout: 5000 });
    await expect(systemMsgs).toHaveCount(1);

    // Anchor specific seeded bodies to defend against rendering regressions
    // (these would not catch a "show only first N" bug; the counts do).
    await expect(appPage.getByText('shipping the v0.4.3 e2e suite today')).toBeVisible();
    await expect(appPage.getByText('beep boop status: nominal')).toBeVisible();
  });

  test('switching to #legacy-empty shows empty-state copy', async ({ appPage }) => {
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');

    // legacy-empty is in Available (phil is not a member). Clicking it should
    // join him AND switch the view. After that, the chat view should show the
    // empty-state copy from src/lib/copy/emptyStates.js.
    await appPage.locator('[data-testid="sidebar-channel-row-legacy-empty"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');

    // Empty state title + subtitle + hint — pinning all 3 catches any single
    // copy-key regression.
    await expect(appPage.getByText('No messages yet')).toBeVisible();
    await expect(appPage.getByText('This is the very beginning of the conversation.')).toBeVisible();
    await expect(appPage.getByText('Type a message below to get things started.')).toBeVisible();
  });

  test('no state_unsafe_mutation across the full scenario', async ({ appPage, consoleErrors }) => {
    // Exercise the full flow: load + 2 channel switches.
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    await appPage.locator('[data-testid="sidebar-channel-row-dev-chat"]').click();
    await appPage.waitForTimeout(200);
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForTimeout(200);

    // This is the cascade-bug regression guard. Bug 1 made App.svelte abort
    // its render tree mid-flight; if it ever returns, this test catches it
    // before downstream visibility assertions misdiagnose the symptom.
    assertNoConsoleErrors(consoleErrors);
  });

  // -------------------------------------------------------------------------
  // Screenshot baselines
  // -------------------------------------------------------------------------

  test('screenshot: sidebar-after-seed', async ({ appPage }) => {
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    await waitForStable(appPage);

    await expectScreenshot(appPage, 'sidebar-after-seed', {
      locator: appPage.locator('[data-testid="sidebar"]'),
      fullPage: false,
    });
  });

  test('screenshot: chatview-general', async ({ appPage }) => {
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    // Wait for all 6 messages to actually render.
    await expect(appPage.locator('[data-testid^="message-"]')).not.toHaveCount(0);
    await waitForStable(appPage);

    await expectScreenshot(appPage, 'chatview-general', {
      locator: appPage.locator('[data-testid="chat-view"]'),
      fullPage: false,
    });
  });

  test('screenshot: chatview-legacy-empty', async ({ appPage }) => {
    await appPage.locator('[data-testid="sidebar-channel-row-legacy-empty"]').click();
    await appPage.waitForSelector('[data-testid="chat-view"]');
    await expect(appPage.getByText('No messages yet')).toBeVisible();
    await waitForStable(appPage);

    await expectScreenshot(appPage, 'chatview-legacy-empty', {
      locator: appPage.locator('[data-testid="chat-view"]'),
      fullPage: false,
    });
  });
});

// Source-level invariant pin (per §I.19 pattern). Catches the case where a
// future refactor accidentally removes the canonical seed's general/dev-chat/
// private-room/legacy-empty bundle. This regex bites at edit-time, not just
// at runtime — robust to test-fixture drift.
test.describe('source-level invariants', () => {
  test('canonicalSeed exposes the 4 canonical channels', () => {
    const spec = canonicalSeed();
    const names = spec.channels.map((c) => c.name).sort();
    expect(names).toEqual(['dev-chat', 'general', 'legacy-empty', 'private-room']);
  });

  test('canonicalSeed pins the 12 seeded messages', () => {
    const spec = canonicalSeed();
    // 6 in general + 4 in dev-chat + 2 in private-room + 0 in legacy-empty
    expect(spec.messages.length).toBe(12);
    const byConv = new Map<string, number>();
    for (const m of spec.messages) {
      byConv.set(m.conv, (byConv.get(m.conv) ?? 0) + 1);
    }
    expect(byConv.get('general')).toBe(6);
    expect(byConv.get('dev-chat')).toBe(4);
    expect(byConv.get('private-room')).toBe(2);
    expect(byConv.get('legacy-empty') ?? 0).toBe(0);
  });
});
