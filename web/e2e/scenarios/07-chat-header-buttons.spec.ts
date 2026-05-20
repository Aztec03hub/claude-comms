// 07-chat-header-buttons.spec.ts - Phil Layer B item #8.
//
// Covers the ChatHeader button row: search, pinned, artifacts, settings,
// theme toggle, and mobile-menu trigger. These 6 buttons were originally
// restored in v0.4.2 commit 7e7d5a6 ([VERIFY-i] Wave E.2 follow-up), but
// in v0.4.2 the cascade bug in mqtt-store.svelte.js's getChannelRole
// (state_unsafe_mutation thrown inside a $derived) aborted App.svelte's
// render tree mid-flight and the buttons NEVER REACHED THE DOM. The
// v0.4.3 hotfix (commit cb5695d, Agent 1) fixed the cascade. This
// scenario verifies the buttons render AND each panel toggles correctly.
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - P-1 source-level regex pins on the 6 button testids in ChatHeader
//   - P-2 cross-component invariant: prop wire pinned at App.svelte
//     (onToggle... callbacks supplied) AND ChatView.svelte (forwarded
//     through to ChatHeader) AND ChatHeader.svelte (rendered when
//     callback present)
//   - P-3 dual coverage: functional toggle behavior + source pins
//   - P-5 console.error spy at the end of every test; explicit
//     state_unsafe_mutation enumeration for the cascade-prevent test
//   - W-2 mitigation: toBeVisible() never querySelector !== null
//   - W-6 mitigation: tests assert PROPER behavior (each button click
//     opens the corresponding panel; Enter on the topic input saves the
//     topic). After the parallel bug-fix-mini lands BUG-PHASE2A-2,
//     pressing Enter is the canonical commit path; pressing the wrong
//     path is fragile not "shipped behavior."

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectScreenshot, waitForStable } from '../fixtures/screenshot';
import { canonicalSeed, PHIL, SeedSpec } from '../fixtures/seedData';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Slot 6 = ports 9990 (mcp) / 9991 (web). Default viewport 1280x900 so
// none of the panel toggles clip the chat-header row + so the mobile-menu
// button is hidden by CSS (>768px) - we still assert DOM presence.
//
// Seed override: dev-chat created_by = phil's KEY so phil registers as
// channel role 'owner' and ChatHeader's edit-topic affordance renders.
const baseSeed = canonicalSeed();
const chatHeaderSeed: SeedSpec = {
  ...baseSeed,
  channels: baseSeed.channels.map((c) =>
    c.name === 'dev-chat' ? { ...c, created_by: PHIL.key } : c,
  ),
};

test.use({ slot: 6, seedSpec: chatHeaderSeed, viewport: { width: 1280, height: 900 } });

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_HEADER_PATH = resolve(HERE, '..', '..', 'src', 'components', 'ChatHeader.svelte');
const CHAT_VIEW_PATH = resolve(HERE, '..', '..', 'src', 'components', 'ChatView.svelte');
const APP_SVELTE_PATH = resolve(HERE, '..', '..', 'src', 'App.svelte');
const STORE_PATH = resolve(HERE, '..', '..', 'src', 'lib', 'mqtt-store.svelte.js');

async function switchToDevChat(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator('[data-testid="sidebar-channel-row-dev-chat"]').click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
  // ChatHeader mounts as the header inside ChatView; wait for it.
  await expect(appPage.locator('[data-testid="chat-header-new"]')).toBeVisible();
}

test.describe('Scenario 07: chat-header button row visibility + toggles', () => {
  test('All 6 ChatHeader buttons are VISIBLE on a viewed channel (cascade-fix proof)', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    // P-5 + W-2 mitigation: use toBeVisible(), not DOM-presence. The Bug 1
    // cascade originally aborted the render mid-flight so the buttons
    // never reached the DOM. Post-fix they MUST render AND be visible.
    // The mobile-menu button is in the DOM but hidden by @media (max-width:
    // 768px); on the 1280px viewport here it is hidden, so we assert it's
    // NOT visible but IS in the DOM (count > 0).
    const buttons = [
      'chat-header-search-btn',
      'chat-header-pinned-btn',
      'chat-header-artifacts-btn',
      'chat-header-theme-toggle-btn',
      'chat-header-settings-btn',
    ];
    for (const tid of buttons) {
      await expect(appPage.locator(`[data-testid="${tid}"]`))
        .toBeVisible({ timeout: 5000 });
    }
    // Mobile menu is in DOM but hidden by media-query at this viewport.
    await expect(appPage.locator('[data-testid="chat-header-mobile-menu-btn"]'))
      .toHaveCount(1);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Mobile-menu button becomes VISIBLE on narrow viewport (<=768px)', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    // Shrink the viewport to trigger the media query. The button has
    //   .header-btn-mobile { display: none; }
    //   @media (max-width: 768px) { .header-btn-mobile { display: inline-flex; } }
    // so on a 600px viewport it MUST be visible.
    await appPage.setViewportSize({ width: 600, height: 800 });
    await expect(appPage.locator('[data-testid="chat-header-mobile-menu-btn"]'))
      .toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Search button click opens SearchPanel', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    // P-8 pre-click state: panel is NOT visible yet.
    await expect(appPage.locator('[data-testid="search-panel"]')).toHaveCount(0);
    await appPage.locator('[data-testid="chat-header-search-btn"]').click();
    await expect(appPage.locator('[data-testid="search-panel"]')).toBeVisible({ timeout: 5000 });

    // Toggle off via second click.
    await appPage.locator('[data-testid="chat-header-search-btn"]').click();
    await expect(appPage.locator('[data-testid="search-panel"]')).toHaveCount(0, { timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Pinned button click opens PinnedPanel', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    await expect(appPage.locator('[data-testid="pinned-panel"]')).toHaveCount(0);
    await appPage.locator('[data-testid="chat-header-pinned-btn"]').click();
    await expect(appPage.locator('[data-testid="pinned-panel"]')).toBeVisible({ timeout: 5000 });

    await appPage.locator('[data-testid="chat-header-pinned-btn"]').click();
    await expect(appPage.locator('[data-testid="pinned-panel"]')).toHaveCount(0, { timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Artifacts button click opens ArtifactPanel', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    await expect(appPage.locator('[data-testid="artifact-panel"]')).toHaveCount(0);
    await appPage.locator('[data-testid="chat-header-artifacts-btn"]').click();
    await expect(appPage.locator('[data-testid="artifact-panel"]')).toBeVisible({ timeout: 5000 });

    // Close via the panel's own close button. The artifact panel renders
    // as a right-side overlay that visually sits beside the chat header,
    // but in narrower viewport modes its pointer-intercept overlaps the
    // chat-header-artifacts-btn position, so we can't reliably re-click
    // the chat-header trigger to toggle off. Closing via the panel's own
    // close affordance is the production-canonical way to dismiss the
    // overlay anyway.
    await appPage.locator('[data-testid="artifact-panel-close"]').first().click();
    await expect(appPage.locator('[data-testid="artifact-panel"]')).toHaveCount(0, { timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Settings button click opens SettingsPanel', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    await expect(appPage.locator('[data-testid="settings-panel"]')).toHaveCount(0);
    await appPage.locator('[data-testid="chat-header-settings-btn"]').click();
    await expect(appPage.locator('[data-testid="settings-panel"]')).toBeVisible({ timeout: 5000 });

    await appPage.locator('[data-testid="chat-header-settings-btn"]').click();
    await expect(appPage.locator('[data-testid="settings-panel"]')).toHaveCount(0, { timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Theme toggle flips data-theme on <html> between dark and light', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    // App.svelte's toggleTheme sets document.documentElement.dataset.theme.
    // The default theme is 'dark'; one click flips to 'light', second flips back.
    await appPage.locator('[data-testid="chat-header-theme-toggle-btn"]').click();
    await expect.poll(
      () => appPage.evaluate(() => document.documentElement.getAttribute('data-theme')),
      { timeout: 5000 },
    ).toBe('light');

    await appPage.locator('[data-testid="chat-header-theme-toggle-btn"]').click();
    await expect.poll(
      () => appPage.evaluate(() => document.documentElement.getAttribute('data-theme')),
      { timeout: 5000 },
    ).toBe('dark');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Mobile-menu button click opens the mobile sidebar wrapper', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    // Force narrow viewport so the button is visible (CSS @media gate).
    await appPage.setViewportSize({ width: 600, height: 800 });
    const mobileBtn = appPage.locator('[data-testid="chat-header-mobile-menu-btn"]');
    await expect(mobileBtn).toBeVisible({ timeout: 5000 });

    // The "open" mobile state lives on .sidebar-mobile-wrapper as a class.
    // Pre-click: not open.
    await expect(appPage.locator('.sidebar-mobile-wrapper.open')).toHaveCount(0);
    await mobileBtn.click();
    await expect(appPage.locator('.sidebar-mobile-wrapper.open')).toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Topic inline edit: Enter saves the new topic (post-BUG-PHASE2A-2 fix)', async ({ appPage, daemon, consoleErrors }) => {
    await switchToDevChat(appPage);

    // The edit-affordance button + pencil only render when canEditTopic
    // (currentUserRole='owner'|'admin'). Phil is owner of dev-chat per
    // the seed override, so the topic-static button is editable.
    const topicStatic = appPage.locator('[data-testid="chat-header-topic-static"]');
    await expect(topicStatic).toBeVisible();
    await expect(topicStatic).toBeEnabled();
    await topicStatic.click();

    const topicInput = appPage.locator('[data-testid="chat-header-topic-input"]');
    await expect(topicInput).toBeVisible();
    // The input is auto-focused + selected; we can type to replace.
    await topicInput.fill('updated topic via Enter');

    // After the parallel bug-fix-mini lands (BUG-PHASE2A-2), the Enter
    // path is the canonical commit. Per ChatHeader.svelte:
    //   handleTopicKeydown -> Enter -> commitEditTopic
    // commitEditTopic snapshots topicDraft + clears edit state FIRST so
    // a subsequent blur is a no-op. Assert the new value persists.
    await topicInput.press('Enter');

    // After commit, the static button re-appears with the new topic.
    await expect(topicStatic).toBeVisible({ timeout: 5000 });
    await expect(topicStatic).toContainText('updated topic via Enter');

    // P-3 dual-coverage: API round-trip confirms the topic landed in
    // meta.json (via the /api/conversations payload).
    await appPage.waitForTimeout(800);
    const res = await fetch(`${daemon.apiURL}/api/conversations?all=true`);
    const json = await res.json() as { conversations: Array<{ id?: string; name?: string; topic?: string }> };
    const dev = json.conversations.find((c) => (c.id ?? c.name) === 'dev-chat');
    expect(dev?.topic).toBe('updated topic via Enter');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Topic inline edit: Escape cancels without saving', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);

    const topicStatic = appPage.locator('[data-testid="chat-header-topic-static"]');
    const originalText = (await topicStatic.textContent()) ?? '';
    await topicStatic.click();

    const topicInput = appPage.locator('[data-testid="chat-header-topic-input"]');
    await expect(topicInput).toBeVisible();
    await topicInput.fill('typed-then-abandoned');
    await topicInput.press('Escape');

    // Static button re-appears with the ORIGINAL text (not the typed-then-
    // abandoned draft).
    await expect(topicStatic).toBeVisible({ timeout: 5000 });
    const finalText = (await topicStatic.textContent()) ?? '';
    expect(finalText.trim()).toBe(originalText.trim());

    assertNoConsoleErrors(consoleErrors);
  });

  test('No state_unsafe_mutation thrown across every panel toggle sequence', async ({ appPage, consoleErrors }) => {
    // The load-bearing cascade-prevent. If Agent 1's getChannelRole pure-
    // read regresses, switching channels + opening panels would re-trigger
    // the throw and abort ChatHeader's render mid-flight. Exercise the
    // full button row in sequence + flip channels to surface any cascade.
    // Panels that overlay the chat-header on dismissal (artifact, search)
    // get closed via their own close-buttons so we don't fight pointer-
    // intercept overlaps across the click path.
    await switchToDevChat(appPage);
    await appPage.locator('[data-testid="chat-header-search-btn"]').click();
    await expect(appPage.locator('[data-testid="search-panel"]')).toBeVisible();
    await appPage.locator('[data-testid="search-panel-close"]').click();
    await expect(appPage.locator('[data-testid="search-panel"]')).toHaveCount(0);
    await appPage.locator('[data-testid="chat-header-pinned-btn"]').click();
    await expect(appPage.locator('[data-testid="pinned-panel"]')).toBeVisible();
    await appPage.locator('[data-testid="pinned-panel-close"]').click();
    await expect(appPage.locator('[data-testid="pinned-panel"]')).toHaveCount(0);
    await appPage.locator('[data-testid="chat-header-artifacts-btn"]').click();
    await expect(appPage.locator('[data-testid="artifact-panel"]')).toBeVisible();
    await appPage.locator('[data-testid="artifact-panel-close"]').first().click();
    await expect(appPage.locator('[data-testid="artifact-panel"]')).toHaveCount(0);
    await appPage.locator('[data-testid="chat-header-settings-btn"]').click();
    await expect(appPage.locator('[data-testid="settings-panel"]')).toBeVisible();
    await appPage.locator('[data-testid="settings-panel-close"]').click();
    await expect(appPage.locator('[data-testid="settings-panel"]')).toHaveCount(0);
    // Switch channels to re-run getChannelRole on a different id.
    await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
    await expect(appPage.locator('[data-testid="chat-header-new"]')).toBeVisible();
    await appPage.locator('[data-testid="sidebar-channel-row-dev-chat"]').click();
    await expect(appPage.locator('[data-testid="chat-header-new"]')).toBeVisible();

    // Belt-and-braces: explicitly enumerate state_unsafe_mutation occurrences.
    const cascades = consoleErrors.filter((e) => e.includes('state_unsafe_mutation'));
    expect(cascades).toEqual([]);
    assertNoConsoleErrors(consoleErrors);
  });

  test('Chat-header continues to render after rapid channel switches (regression-prevent)', async ({ appPage, consoleErrors }) => {
    await switchToDevChat(appPage);
    // Rapid alternation; if Bug 1 returns, the second render would abort.
    for (let i = 0; i < 3; i++) {
      await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
      await expect(appPage.locator('[data-testid="chat-header-new"]')).toBeVisible();
      await appPage.locator('[data-testid="sidebar-channel-row-dev-chat"]').click();
      await expect(appPage.locator('[data-testid="chat-header-new"]')).toBeVisible();
    }
    // Final state: all 5 wide-viewport buttons still visible.
    await expect(appPage.locator('[data-testid="chat-header-search-btn"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="chat-header-pinned-btn"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="chat-header-artifacts-btn"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="chat-header-theme-toggle-btn"]')).toBeVisible();
    await expect(appPage.locator('[data-testid="chat-header-settings-btn"]')).toBeVisible();

    assertNoConsoleErrors(consoleErrors);
  });

  // -------------------------------------------------------------------------
  // Screenshot baselines
  // -------------------------------------------------------------------------

  test('screenshot: chat-header-with-all-6-buttons', async ({ appPage }) => {
    await switchToDevChat(appPage);
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'chat-header-with-all-6-buttons', {
      locator: appPage.locator('[data-testid="chat-header-new"]'),
      fullPage: false,
    });
  });

  test('screenshot: chat-header-after-search-toggle', async ({ appPage }) => {
    await switchToDevChat(appPage);
    await appPage.locator('[data-testid="chat-header-search-btn"]').click();
    await expect(appPage.locator('[data-testid="search-panel"]')).toBeVisible();
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'chat-header-after-search-toggle', {
      locator: appPage.locator('[data-testid="chat-view"]'),
      fullPage: false,
    });
  });

  test('screenshot: chat-header-light-theme', async ({ appPage }) => {
    await switchToDevChat(appPage);
    await appPage.locator('[data-testid="chat-header-theme-toggle-btn"]').click();
    await expect.poll(
      () => appPage.evaluate(() => document.documentElement.getAttribute('data-theme')),
      { timeout: 5000 },
    ).toBe('light');
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'chat-header-light-theme', {
      locator: appPage.locator('[data-testid="chat-header-new"]'),
      fullPage: false,
    });
  });
});

// -------------------------------------------------------------------------
// Source-level invariants (Pattern P-1 + P-2).
// -------------------------------------------------------------------------

test.describe('source-level invariants: ChatHeader button row', () => {
  test('ChatHeader pins all 6 button testids', () => {
    const src = readFileSync(CHAT_HEADER_PATH, 'utf-8');
    // P-1 testid surface. The Phase 2 tests + the Agent 1 vitest spec
    // (web/tests/chat-header-buttons-visibility.spec.js) BOTH depend on
    // these exact testids. Pin them at source.
    expect(src).toMatch(/data-testid="chat-header-search-btn"/);
    expect(src).toMatch(/data-testid="chat-header-pinned-btn"/);
    expect(src).toMatch(/data-testid="chat-header-artifacts-btn"/);
    expect(src).toMatch(/data-testid="chat-header-settings-btn"/);
    expect(src).toMatch(/data-testid="chat-header-theme-toggle-btn"/);
    expect(src).toMatch(/data-testid="chat-header-mobile-menu-btn"/);
    expect(src).toMatch(/data-testid="chat-header-new"/);
  });

  test('ChatHeader gates each button on its callback prop being a function', () => {
    const src = readFileSync(CHAT_HEADER_PATH, 'utf-8');
    // P-1: each button is wrapped in {#if typeof onToggle... === 'function'}
    // so consumers that omit a callback simply don't render the button.
    // Pin the contract for all 6.
    expect(src).toMatch(/typeof\s+onToggleSearch\s*===\s*['"]function['"]/);
    expect(src).toMatch(/typeof\s+onTogglePinned\s*===\s*['"]function['"]/);
    expect(src).toMatch(/typeof\s+onToggleArtifacts\s*===\s*['"]function['"]/);
    expect(src).toMatch(/typeof\s+onToggleSettings\s*===\s*['"]function['"]/);
    expect(src).toMatch(/typeof\s+onToggleTheme\s*===\s*['"]function['"]/);
    expect(src).toMatch(/typeof\s+onToggleMobileMenu\s*===\s*['"]function['"]/);
  });

  test('ChatView forwards all 6 onToggle... props through to ChatHeader', () => {
    const src = readFileSync(CHAT_VIEW_PATH, 'utf-8');
    // P-2 cross-component invariant. App.svelte -> ChatView -> ChatHeader
    // is the prop-drill the buttons depend on. If the forwarder loses any
    // prop, that button silently disappears from the rendered header.
    expect(src).toMatch(/onToggleSearch/);
    expect(src).toMatch(/onTogglePinned/);
    expect(src).toMatch(/onToggleArtifacts/);
    expect(src).toMatch(/onToggleSettings/);
    expect(src).toMatch(/onToggleTheme/);
    expect(src).toMatch(/onToggleMobileMenu/);
    expect(src).toMatch(/themeMode/);
  });

  test('App.svelte supplies all 6 callbacks + themeMode to ChatView', () => {
    const src = readFileSync(APP_SVELTE_PATH, 'utf-8');
    // P-2 the consumer side. App.svelte owns the panel-open state + the
    // toggleTheme function; it MUST hand them all to ChatView.
    expect(src).toMatch(/onToggleSearch=\{[^}]*showSearchPanel/);
    expect(src).toMatch(/onTogglePinned=\{[^}]*showPinnedPanel/);
    expect(src).toMatch(/onToggleArtifacts=\{[^}]*showArtifactPanel/);
    expect(src).toMatch(/onToggleSettings=\{[^}]*showSettingsPanel/);
    expect(src).toMatch(/onToggleTheme=\{toggleTheme\}/);
    expect(src).toMatch(/onToggleMobileMenu=\{[^}]*showMobileSidebar/);
    expect(src).toMatch(/themeMode=\{theme\}/);
  });

  test('getChannelRole stays a pure read (cascade-fix regression-prevent)', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-1 + P-5 source-pin. Mirrors Agent 1's pattern from the original
    // bug fix. If a future refactor re-introduces the lazy-write
    // (`this.channelRoles[channelId] = ...`) inside getChannelRole, the
    // Bug 1 cascade returns and the ChatHeader buttons disappear again.
    // This test bites at edit-time.
    const fnMatch = src.match(/getChannelRole\(channelId\)\s*{([\s\S]*?)\n  }/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![1]).not.toMatch(/this\.channelRoles\[\w+\]\s*=/);
  });

  test('ChatHeader pins the mobile-menu media-query CSS rule', () => {
    const src = readFileSync(CHAT_HEADER_PATH, 'utf-8');
    // P-1 the responsive visibility rule. The button is always in the DOM
    // (when its callback is provided) but hidden by default; the @media
    // (max-width: 768px) clause flips display to inline-flex. Pin both
    // the default display: none and the breakpoint.
    expect(src).toMatch(/\.header-btn-mobile\s*{\s*display:\s*none/);
    expect(src).toMatch(/@media\s*\(max-width:\s*768px\)/);
  });
});
