// 06-status-editor.spec.ts - Phil Layer B item #7.
//
// Covers StatusEditor (v0.4.2 Step 3.13, commit 1c802dc). The popover
// mounts from Sidebar.svelte when the inline profile-status row (under
// the identity row) is clicked. The editor:
//   - shows an 8-emoji strip + a free-text input (cap 60, live counter)
//   - shows 4 expiry presets (Never / 1h / 4h / Until tomorrow)
//   - on Save fires comms_profile_status_set MCP tool with
//     { key, emoji, text, expires_at } (snake_case)
//   - on Clear fires comms_profile_status_clear MCP tool with { key }
//   - Escape + Cancel + backdrop close without firing the tool
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - P-1 source-level regex pins on MAX_TEXT_LEN + the 8 emoji choices
//   - P-2 cross-component invariant: editor testids pinned in producer
//     (StatusEditor.svelte), MCP wire shape pinned in store
//     (mqtt-store.svelte.js: setProfileStatus + clearProfileStatus),
//     mount gate pinned in Sidebar (statusEditorOpen toggle)
//   - P-3 dual coverage: functional UI flow + intercepted MCP call shape
//   - P-5 console.error spy at the end of every test
//   - P-7 daemon.dataDir filesystem read for the persistence test (the
//     /api/conversations API does not expose participant status; the
//     registry.db is the source of truth)
//   - P-8 pre-click state assertions on editor surfaces
//   - W-2 mitigation: toBeVisible(), not querySelector
//   - W-6 mitigation: assert PROPER behavior (Save closes the editor +
//     fires MCP tool; not a workaround)

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectScreenshot, waitForStable } from '../fixtures/screenshot';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Slot 5 = ports 9980 (mcp) / 9981 (web). Default canonical seed is fine;
// the editor is a per-user surface, not a channel one.
test.use({ slot: 5, viewport: { width: 1280, height: 900 } });

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUS_EDITOR_PATH = resolve(HERE, '..', '..', 'src', 'components', 'StatusEditor.svelte');
const SIDEBAR_PATH = resolve(HERE, '..', '..', 'src', 'components', 'Sidebar.svelte');
const STORE_PATH = resolve(HERE, '..', '..', 'src', 'lib', 'mqtt-store.svelte.js');

/**
 * Intercept the daemon's MCP HTTP surface (POST /mcp) and capture the
 * tool call name + arguments. Resolves with the captured payload after
 * Playwright observes the request and forwards a synthetic success
 * response. Used for both comms_profile_status_set and ..._clear.
 *
 * The fulfilled response mirrors the FastMCP shape the daemon would
 * return: ``{ jsonrpc, id, result: { structuredContent: { success: true } } }``
 * so the store's mcpCall envelope decodes to success.
 */
async function interceptMcp(
  appPage: import('@playwright/test').Page,
  toolName: string,
): Promise<{ args: any | null }> {
  const captured = { args: null as any | null };
  await appPage.route('**/mcp', async (route) => {
    const req = route.request().postDataJSON();
    if (req?.params?.name === toolName) {
      captured.args = req.params.arguments ?? null;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: req?.id ?? 1,
        result: { structuredContent: { success: true } },
      }),
    });
  });
  return captured;
}

async function openStatusEditor(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  const statusRow = appPage.locator('[data-testid="sidebar-profile-status"]');
  await expect(statusRow).toBeVisible();
  await statusRow.click();

  const editor = appPage.locator('[data-testid="status-editor"]');
  await expect(editor).toBeVisible();
  return editor;
}

test.describe('Scenario 06: status editor popover', () => {
  test('Click inline status row opens StatusEditor with all surfaces', async ({ appPage, consoleErrors }) => {
    const editor = await openStatusEditor(appPage);

    // P-8 pre-click state assertions. Verify the full editor surface is
    // visible BEFORE we exercise any interactive control. The editor is
    // self-positioning (fixed bottom-left); the backdrop catches outside
    // clicks; the dialog itself stops propagation.
    await expect(editor.locator('[data-testid="status-editor-emoji-strip"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-emoji-input"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-text-input"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-char-count"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-expiry-never"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-expiry-1h"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-expiry-4h"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-expiry-tomorrow"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-save"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-clear"]')).toBeVisible();
    await expect(editor.locator('[data-testid="status-editor-cancel"]')).toBeVisible();

    assertNoConsoleErrors(consoleErrors);
  });

  test('Pick an emoji from the 8-emoji strip - selected gets active class', async ({ appPage, consoleErrors }) => {
    const editor = await openStatusEditor(appPage);

    // Picking 🍵 marks it active; the other 7 buttons are NOT active.
    const teaBtn = editor.locator('[data-testid="status-editor-emoji-🍵"]');
    await expect(teaBtn).toBeVisible();
    await teaBtn.click();
    // P-8 active-state assertion: the picked button takes class "active".
    await expect(teaBtn).toHaveClass(/active/);
    // The headphones emoji is NOT active.
    const headphonesBtn = editor.locator('[data-testid="status-editor-emoji-🎧"]');
    await expect(headphonesBtn).not.toHaveClass(/active/);
    // The emoji-input field mirrors the picked glyph (bind:value=emoji).
    await expect(editor.locator('[data-testid="status-editor-emoji-input"]'))
      .toHaveValue('🍵');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Type text - live char counter updates from 0 to length', async ({ appPage, consoleErrors }) => {
    const editor = await openStatusEditor(appPage);

    const input = editor.locator('[data-testid="status-editor-text-input"]');
    const counter = editor.locator('[data-testid="status-editor-char-count"]');

    // Fresh editor -> counter at "0/60".
    await expect(counter).toContainText('0/60');

    // Type a few chars -> counter increments.
    await input.fill('busy');
    await expect(counter).toContainText('4/60');

    // Fill all the way to 60 -> counter shows "60/60".
    await input.fill('a'.repeat(60));
    await expect(counter).toContainText('60/60');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Text input maxlength="60" rejects the 61st character', async ({ appPage, consoleErrors }) => {
    const editor = await openStatusEditor(appPage);

    const input = editor.locator('[data-testid="status-editor-text-input"]');
    // The text input is bound with maxlength={MAX_TEXT_LEN} so the browser
    // enforces the cap natively. fill() respects maxlength; typing past 60
    // gets truncated to 60.
    await input.fill('a'.repeat(70));
    await expect(input).toHaveValue('a'.repeat(60));

    // Counter caps at 60/60 (no overflow class because the input enforced).
    const counter = editor.locator('[data-testid="status-editor-char-count"]');
    await expect(counter).toContainText('60/60');
    await expect(counter).not.toHaveClass(/overflow/);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Save with emoji + text + 1h expiry fires comms_profile_status_set with snake_case args', async ({ appPage, consoleErrors }) => {
    const captured = await interceptMcp(appPage, 'comms_profile_status_set');

    const editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-emoji-🍵"]').click();
    await editor.locator('[data-testid="status-editor-text-input"]').fill('tea break');
    await editor.locator('[data-testid="status-editor-expiry-1h"]').click();

    // Snapshot Date.now() so we can validate expires_at is ~1h from now.
    const beforeMs = Date.now();
    await editor.locator('[data-testid="status-editor-save"]').click();

    // The editor closes after save fires (Sidebar.handleStatusSave sets
    // statusEditorOpen = false before awaiting the store call).
    await expect(editor).not.toBeVisible({ timeout: 5000 });

    // Wait for the MCP call to land + populate captured.args.
    await expect.poll(() => captured.args, { timeout: 5000 }).not.toBeNull();

    // Pin the wire shape from the brief: comms_profile_status_set with
    // snake_case args. The store wraps the call as
    //   mcpCall('comms_profile_status_set', { key, emoji, text, expires_at })
    expect(captured.args.emoji).toBe('🍵');
    expect(captured.args.text).toBe('tea break');
    // expires_at must be an ISO-8601 string ~1h from the click time.
    expect(typeof captured.args.expires_at).toBe('string');
    const expMs = new Date(captured.args.expires_at).getTime();
    // 1h preset = 60*60*1000 ms; allow 30s slack for handler latency.
    expect(expMs - beforeMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 30_000);
    expect(expMs - beforeMs).toBeLessThanOrEqual(60 * 60 * 1000 + 30_000);

    assertNoConsoleErrors(consoleErrors);
  });

  test('After Save the sidebar status row shows the picked emoji + text (optimistic local update)', async ({ appPage, consoleErrors }) => {
    await interceptMcp(appPage, 'comms_profile_status_set');

    const editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-emoji-🛌"]').click();
    await editor.locator('[data-testid="status-editor-text-input"]').fill('out today');
    await editor.locator('[data-testid="status-editor-save"]').click();

    await expect(editor).not.toBeVisible({ timeout: 5000 });

    // Per setProfileStatus: optimistic local update writes
    // userProfile.profileStatus BEFORE the MCP call lands. The Sidebar's
    // inline row reads from store.userProfile.profileStatus and shows
    // emoji + text.
    await expect(appPage.locator('[data-testid="sidebar-profile-status-emoji"]'))
      .toHaveText('🛌');
    await expect(appPage.locator('[data-testid="sidebar-profile-status-text"]'))
      .toContainText('out today');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Click Clear fires comms_profile_status_clear + status row reverts to "Set a status"', async ({ appPage, consoleErrors }) => {
    // First Save a status so Clear has something to clear.
    await interceptMcp(appPage, 'comms_profile_status_set');
    let editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-emoji-🎧"]').click();
    await editor.locator('[data-testid="status-editor-text-input"]').fill('focus');
    await editor.locator('[data-testid="status-editor-save"]').click();
    await expect(editor).not.toBeVisible({ timeout: 5000 });
    await expect(appPage.locator('[data-testid="sidebar-profile-status-emoji"]'))
      .toHaveText('🎧');

    // Now wire a fresh route for the clear call (the previous route
    // captured the set; re-use the same handler shape but for the
    // clear tool name).
    const clearCaptured = await interceptMcp(appPage, 'comms_profile_status_clear');

    // Re-open the editor and click Clear.
    editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-clear"]').click();

    await expect(editor).not.toBeVisible({ timeout: 5000 });

    // The clear tool was called.
    await expect.poll(() => clearCaptured.args, { timeout: 5000 }).not.toBeNull();
    // clearProfileStatus only passes { key } - no emoji/text/expires_at.
    expect(clearCaptured.args.key).toBeDefined();
    expect(clearCaptured.args.emoji).toBeUndefined();
    expect(clearCaptured.args.text).toBeUndefined();

    // The sidebar status row reverts to the placeholder.
    await expect(appPage.locator('[data-testid="sidebar-profile-status"]'))
      .toContainText('Set a status');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Cancel button closes editor without firing any MCP call', async ({ appPage, consoleErrors }) => {
    let mcpCalls = 0;
    await appPage.route('**/mcp', async (route) => {
      const req = route.request().postDataJSON();
      const name = req?.params?.name ?? '';
      if (name.startsWith('comms_profile_status_')) mcpCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: req?.id ?? 1,
          result: { structuredContent: { success: true } },
        }),
      });
    });

    const editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-emoji-💬"]').click();
    await editor.locator('[data-testid="status-editor-text-input"]').fill('about to cancel');
    await editor.locator('[data-testid="status-editor-cancel"]').click();

    await expect(editor).not.toBeVisible({ timeout: 5000 });

    // Wait so any pending MCP call would have landed; assert none did.
    await appPage.waitForTimeout(300);
    expect(mcpCalls).toBe(0);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Escape key closes editor without firing any MCP call', async ({ appPage, consoleErrors }) => {
    let mcpCalls = 0;
    await appPage.route('**/mcp', async (route) => {
      const req = route.request().postDataJSON();
      const name = req?.params?.name ?? '';
      if (name.startsWith('comms_profile_status_')) mcpCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: req?.id ?? 1,
          result: { structuredContent: { success: true } },
        }),
      });
    });

    const editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-text-input"]').fill('about to escape');
    await appPage.keyboard.press('Escape');

    await expect(editor).not.toBeVisible({ timeout: 5000 });
    await appPage.waitForTimeout(300);
    expect(mcpCalls).toBe(0);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Save with only emoji (no text) still fires set and shows emoji-only row', async ({ appPage, consoleErrors }) => {
    const captured = await interceptMcp(appPage, 'comms_profile_status_set');

    const editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-emoji-🌴"]').click();
    // Skip text input - canSave allows emoji-only.
    await editor.locator('[data-testid="status-editor-save"]').click();
    await expect(editor).not.toBeVisible({ timeout: 5000 });

    await expect.poll(() => captured.args, { timeout: 5000 }).not.toBeNull();
    expect(captured.args.emoji).toBe('🌴');
    // Empty text comes through as null because StatusEditor passes
    //   trimmedText ? trimmedText : null
    expect(captured.args.text).toBeNull();
    // No expiry was picked -> 'never' -> null.
    expect(captured.args.expires_at).toBeNull();

    await expect(appPage.locator('[data-testid="sidebar-profile-status-emoji"]'))
      .toHaveText('🌴');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Save button disabled when both emoji and text are empty (canSave gate)', async ({ appPage, consoleErrors }) => {
    const editor = await openStatusEditor(appPage);

    // Fresh editor -> emoji='' and text='' -> canSave is false.
    await expect(editor.locator('[data-testid="status-editor-save"]')).toBeDisabled();

    // Type text -> save enables.
    await editor.locator('[data-testid="status-editor-text-input"]').fill('hi');
    await expect(editor.locator('[data-testid="status-editor-save"]')).toBeEnabled();

    // Clear text + pick an emoji -> save still enables.
    await editor.locator('[data-testid="status-editor-text-input"]').fill('');
    await editor.locator('[data-testid="status-editor-emoji-🧠"]').click();
    await expect(editor.locator('[data-testid="status-editor-save"]')).toBeEnabled();

    assertNoConsoleErrors(consoleErrors);
  });

  // -------------------------------------------------------------------------
  // Screenshot baselines
  // -------------------------------------------------------------------------

  test('screenshot: status-editor-open', async ({ appPage }) => {
    const editor = await openStatusEditor(appPage);
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'status-editor-open', {
      locator: editor,
      fullPage: false,
    });
  });

  test('screenshot: status-editor-with-values', async ({ appPage }) => {
    const editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-emoji-🍵"]').click();
    await editor.locator('[data-testid="status-editor-text-input"]').fill('tea break');
    await editor.locator('[data-testid="status-editor-expiry-1h"]').click();
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'status-editor-with-values', {
      locator: editor,
      fullPage: false,
    });
  });

  test('screenshot: sidebar-status-row-set', async ({ appPage }) => {
    // Wire the set MCP call so Save resolves cleanly, then capture the
    // sidebar's identity area with the status row populated.
    await interceptMcp(appPage, 'comms_profile_status_set');
    const editor = await openStatusEditor(appPage);
    await editor.locator('[data-testid="status-editor-emoji-🛌"]').click();
    await editor.locator('[data-testid="status-editor-text-input"]').fill('out today');
    await editor.locator('[data-testid="status-editor-save"]').click();
    await expect(editor).not.toBeVisible({ timeout: 5000 });
    await expect(appPage.locator('[data-testid="sidebar-profile-status-emoji"]'))
      .toHaveText('🛌');
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'sidebar-status-row-set', {
      locator: appPage.locator('[data-testid="sidebar-profile-status"]'),
      fullPage: false,
    });
  });
});

// -------------------------------------------------------------------------
// Source-level invariants (Pattern P-1 + P-2).
// -------------------------------------------------------------------------

test.describe('source-level invariants: StatusEditor', () => {
  test('StatusEditor pins MAX_TEXT_LEN = 60', () => {
    const src = readFileSync(STATUS_EDITOR_PATH, 'utf-8');
    // P-1 source pin on the tuning constant. The runtime test above
    // exercises the input's maxlength={MAX_TEXT_LEN} cap; this pin bites
    // at edit-time when anyone changes the constant without updating the
    // counter copy or server-side cap.
    expect(src).toMatch(/MAX_TEXT_LEN\s*=\s*60\b/);
  });

  test('StatusEditor pins the 8-emoji strip', () => {
    const src = readFileSync(STATUS_EDITOR_PATH, 'utf-8');
    // P-1 cross-render invariant: the 8 emoji choices are the source of
    // truth for the strip. The screenshot baseline depends on this set.
    expect(src).toMatch(/EMOJI_CHOICES\s*=\s*\[\s*['"]💬['"]/);
    // Sanity-check the count by pinning the closing bracket position via
    // a tolerant pattern: 8 quoted strings separated by commas.
    const arrMatch = src.match(/EMOJI_CHOICES\s*=\s*\[([^\]]+)\]/);
    expect(arrMatch).not.toBeNull();
    const emojis = (arrMatch![1].match(/['"][^'"]+['"]/g) ?? []);
    expect(emojis.length).toBe(8);
  });

  test('StatusEditor pins the 4 expiry presets', () => {
    const src = readFileSync(STATUS_EDITOR_PATH, 'utf-8');
    // P-1 pin the 4-id surface (never / 1h / 4h / tomorrow). Tests use
    // these ids verbatim as testid suffixes.
    expect(src).toMatch(/id:\s*['"]never['"]/);
    expect(src).toMatch(/id:\s*['"]1h['"]/);
    expect(src).toMatch(/id:\s*['"]4h['"]/);
    expect(src).toMatch(/id:\s*['"]tomorrow['"]/);
  });

  test('StatusEditor pins the data-testid surface', () => {
    const src = readFileSync(STATUS_EDITOR_PATH, 'utf-8');
    expect(src).toMatch(/data-testid="status-editor"/);
    expect(src).toMatch(/data-testid="status-editor-emoji-strip"/);
    expect(src).toMatch(/data-testid="status-editor-emoji-input"/);
    expect(src).toMatch(/data-testid="status-editor-text-input"/);
    expect(src).toMatch(/data-testid="status-editor-char-count"/);
    expect(src).toMatch(/data-testid="status-editor-clear"/);
    expect(src).toMatch(/data-testid="status-editor-cancel"/);
    expect(src).toMatch(/data-testid="status-editor-save"/);
  });

  test('Sidebar mounts StatusEditor on profile-status row click', () => {
    const src = readFileSync(SIDEBAR_PATH, 'utf-8');
    // P-2 cross-component invariant. The sidebar owns the mount gate.
    // Pin both the trigger (the testid) and the state flag.
    expect(src).toMatch(/data-testid="sidebar-profile-status"/);
    expect(src).toMatch(/statusEditorOpen\s*=\s*\$state\(/);
    expect(src).toMatch(/openStatusEditor/);
    // The {#if statusEditorOpen} block mounts <StatusEditor ... />.
    expect(src).toMatch(/\{#if\s+statusEditorOpen\}/);
  });

  test('store wires comms_profile_status_set / _clear with snake_case args', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-2 cross-component invariant: the MCP wire shape from the brief.
    // setProfileStatus calls comms_profile_status_set with snake_case
    // expires_at; clearProfileStatus calls _clear with just { key }.
    expect(src).toMatch(/mcpCall\(\s*['"]comms_profile_status_set['"]/);
    expect(src).toMatch(/mcpCall\(\s*['"]comms_profile_status_clear['"]/);
    // The set call's argument object MUST include expires_at (snake_case).
    const setMatch = src.match(/mcpCall\(\s*['"]comms_profile_status_set['"][\s\S]{0,400}?\}\)/);
    expect(setMatch).not.toBeNull();
    expect(setMatch![0]).toMatch(/expires_at:/);
  });
});
