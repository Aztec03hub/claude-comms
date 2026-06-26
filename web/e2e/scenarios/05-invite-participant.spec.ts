// 05-invite-participant.spec.ts - Phil Layer B item #6.
//
// Covers InviteParticipantDialog (v0.4.2 Step 3.3, Wave F, commit d680439).
// The right-click-on-a-channel ChannelContextMenu "Invite participant..."
// action emits a window CustomEvent (claude-comms:invite-participant)
// that App.svelte listens for and mounts the dialog from. Submit fires
// POST /api/invite with { conversation_id, invitee_key, note? }; success
// closes the dialog + surfaces a toast; failures branch on HTTP status:
//   400 = malformed       (server-side validation rejection)
//   403 = not-a-member    ("You do not have permission...")
//   404 = unknown channel ("Channel no longer exists.")
//   409 = already-member  ("That participant is already a member.")
//
// Pattern enforcement (per .worklogs/v043-iteration-log.md):
//   - P-1 source-level regex pins on the dialog's NOTE_MAX + testids
//   - P-2 cross-component invariant: dialog testid pinned in producer
//     (InviteParticipantDialog.svelte), wire shape pinned in store
//     (mqtt-store.svelte.js: inviteParticipant), bus dispatch pinned in
//     menu (ChannelContextMenu.svelte: 'claude-comms:invite-participant')
//   - P-3 dual coverage: functional flow via page.route() intercept +
//     source pins on wire shape
//   - P-5 console.error spy at the end of every test
//   - P-8 pre-click state assertion for the focus-trapped dialog
//   - W-2 mitigation: toBeVisible() never querySelector
//   - W-6 mitigation: tests assert PROPER behavior — context-menu opens via
//     right-click on the channel row in the sidebar (not a workaround path)

import { test, expect, assertNoConsoleErrors } from '../fixtures/browser';
import { expectScreenshot, waitForStable } from '../fixtures/screenshot';
import { expectLocatorOnTop } from '../fixtures/topLayer';
import { canonicalSeed, PHIL, CLAUDE, BOT, SeedSpec } from '../fixtures/seedData';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Slot 4 = ports 9970 (mcp) / 9971 (web). Viewport 1280x900 so the picker
// + note + footer fit inside the dialog without scroll-clipping (mirrors
// scenario 02's modal viewport bump).
//
// Seed override: invite-test-channel is owned by PHIL (key gate) and has
// only PHIL as a member so claude+bot show as invite candidates. Also
// adds a second human-only participant (sam) so the search-by-name filter
// has a 4th candidate to filter against. SAM must be a member of #general
// so the /api/participants/general fetch (run on phil's active channel)
// includes sam in store.participants — otherwise the invite dialog's
// picker (which reads store.participants directly) would never see him.
const baseSeed = canonicalSeed();
const SAM = { key: 'dddddddd', name: 'sam', type: 'human' as const };
const inviteSeed: SeedSpec = {
  ...baseSeed,
  participants: [...baseSeed.participants, SAM],
  channels: [
    ...baseSeed.channels.map((c) =>
      // Add SAM to #general so the participants endpoint surfaces him.
      c.name === 'general'
        ? { ...c, members: [...(c.members ?? []), SAM.key] }
        : c,
    ),
    {
      name: 'invite-test-channel',
      topic: 'Scenario 05 target',
      created_by: PHIL.key,
      visibility: 'public',
      mode: 'open',
      members: [PHIL.key],
    },
  ],
  roles: [
    ...baseSeed.roles,
    { conversation: 'general', participantKey: SAM.key, role: 'member' },
    { conversation: 'invite-test-channel', participantKey: PHIL.key, role: 'owner' },
  ],
};

test.use({ slot: 4, seedSpec: inviteSeed, viewport: { width: 1280, height: 900 } });

const HERE = dirname(fileURLToPath(import.meta.url));
const INVITE_DIALOG_PATH = resolve(HERE, '..', '..', 'src', 'components', 'InviteParticipantDialog.svelte');
const CHANNEL_CTX_MENU_PATH = resolve(HERE, '..', '..', 'src', 'components', 'ChannelContextMenu.svelte');
const STORE_PATH = resolve(HERE, '..', '..', 'src', 'lib', 'mqtt-store.svelte.js');

const TARGET_CHANNEL = 'invite-test-channel';

async function openInviteDialog(appPage: import('@playwright/test').Page, channelId: string) {
  // Right-click the channel row in the sidebar to open the context menu,
  // then click the "Invite participant..." item. Mirrors Phil's manual flow.
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  const row = appPage.locator(`[data-testid="sidebar-channel-row-${channelId}"]`);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });

  const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
  await expect(menu).toBeVisible();
  // Channel context menu adds the invite item only when the caller is a member.
  // PHIL is owner of invite-test-channel so the item shows up.
  const inviteItem = menu.locator('[data-testid="channel-ctx-item-invite"]');
  await expect(inviteItem).toBeVisible();
  await inviteItem.click();

  // The InviteParticipantDialog mounts from App.svelte in response to the
  // window CustomEvent dispatched by the menu.
  const dialog = appPage.locator('[data-testid="invite-dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Scenario 05: invite participant dialog', () => {
  test('Right-click channel row to Invite participant... opens the dialog', async ({ appPage, consoleErrors }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);

    // P-8 pre-click state: the dialog has all its surfaces visible BEFORE
    // we exercise any interactive control. The focus-trap mounts after
    // first paint; we wait on the search input being visible because that
    // is the dialog's default-focus target.
    await expect(dialog.locator('[data-testid="invite-dialog-search"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="invite-dialog-picker"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="invite-dialog-note"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="invite-dialog-cancel"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="invite-dialog-submit"]')).toBeVisible();
    // Title carries the channel name slug.
    await expect(dialog.locator('[data-testid="invite-dialog-title"]')).toContainText(
      TARGET_CHANNEL,
    );

    assertNoConsoleErrors(consoleErrors);
  });

  test('Picker excludes the caller and existing channel members', async ({ appPage, consoleErrors }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);

    // PHIL is the caller AND the only existing member of invite-test-channel.
    // The dialog's exclude-set is { phil.key } so phil's row MUST NOT appear.
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${PHIL.key}"]`)).toHaveCount(0);
    // Claude, bot, and sam are eligible candidates.
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${BOT.key}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${SAM.key}"]`)).toBeVisible();

    assertNoConsoleErrors(consoleErrors);
  });

  test('Search-as-you-type filters the picker (case-insensitive substring on name)', async ({ appPage, consoleErrors }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);

    const search = dialog.locator('[data-testid="invite-dialog-search"]');
    // Type "CLA" -> matches "claude" (case-insensitive). bot + sam filtered out.
    await search.fill('CLA');
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${BOT.key}"]`)).toHaveCount(0);
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${SAM.key}"]`)).toHaveCount(0);

    // Clear, then type "am" -> matches "sam" (substring, not prefix).
    await search.fill('');
    await search.fill('am');
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${SAM.key}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`)).toHaveCount(0);

    // Non-matching query -> empty state.
    await search.fill('zzzzzz');
    await expect(dialog.locator('[data-testid="invite-dialog-empty"]')).toBeVisible();

    assertNoConsoleErrors(consoleErrors);
  });

  test('Submit fires POST /api/invite with conversation_id + invitee_key + note', async ({ appPage, consoleErrors }) => {
    // P-3 dual-coverage: intercept the network call so we can pin the wire
    // shape end-to-end (not just trust the store's docstring). Use the
    // raw postData() text and JSON.parse it manually because some
    // Playwright versions return null from postDataJSON() when the body
    // is small + the content-type negotiation races with the handler.
    let capturedBody: any = null;
    await appPage.route('**/api/invite', async (route) => {
      const req = route.request();
      const raw = req.postData();
      try {
        capturedBody = raw ? JSON.parse(raw) : null;
      } catch {
        capturedBody = null;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          invited: true,
          invitee_key: CLAUDE.key,
          conversation_id: TARGET_CHANNEL,
        }),
      });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-note"]').fill('welcome aboard');
    await dialog.locator('[data-testid="invite-dialog-submit"]').click();

    // Dialog closes on success (App.svelte sets inviteDialog = null before
    // awaiting the store call).
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Wait for the route handler to have populated capturedBody.
    await expect.poll(() => capturedBody, { timeout: 5000 }).not.toBeNull();

    // Pin the exact wire shape the brief documents.
    expect(capturedBody.conversation_id).toBe(TARGET_CHANNEL);
    expect(capturedBody.invitee_key).toBe(CLAUDE.key);
    expect(capturedBody.note).toBe('welcome aboard');

    assertNoConsoleErrors(consoleErrors);
  });

  test('Success path: 200 closes dialog + shows success toast', async ({ appPage, consoleErrors }) => {
    await appPage.route('**/api/invite', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          invited: true,
          invitee_key: CLAUDE.key,
          conversation_id: TARGET_CHANNEL,
        }),
      });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-submit"]').click();

    // App.svelte's success branch enqueues a toast with text 'Invite sent.'
    // The toast surface is shared with the broader in-app notification
    // system. Verify the dialog closes and the success message surfaces
    // somewhere in the page text.
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    // Toast text "Invite sent." may flash and then dismiss; verify it appears.
    await expect(appPage.getByText('Invite sent.')).toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('403 path: caller-not-member surfaces permission error', async ({ appPage, consoleErrors }) => {
    await appPage.route('**/api/invite', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'forbidden' }),
      });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-submit"]').click();

    // App.svelte's 403 branch surfaces "You do not have permission..."
    await expect(appPage.getByText('You do not have permission to invite to this channel.'))
      .toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('404 path: conv-not-found surfaces channel-gone error', async ({ appPage, consoleErrors }) => {
    await appPage.route('**/api/invite', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not found' }),
      });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-submit"]').click();

    await expect(appPage.getByText('Channel no longer exists.'))
      .toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('400 path: malformed request surfaces invalid-input error', async ({ appPage, consoleErrors }) => {
    await appPage.route('**/api/invite', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Server returned HTTP 400.' }),
      });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-submit"]').click();

    // App.svelte 400 branch: surfaces either the server's error message OR
    // the generic 'Invalid invite request.' fallback. apiPost throws
    // ``Error('HTTP 400')`` (api.js:199); inviteParticipant passes the
    // .message through verbatim; App.svelte's 400 branch is
    //   msg = msg || 'Invalid invite request.'  (the || means a truthy
    //   msg is kept). The truthy msg is "HTTP 400" so that's what surfaces.
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    // Toast text contains "HTTP 400" (from apiPost) OR the generic fallback.
    const errorText = appPage.getByText(/HTTP 400|Invalid invite request/);
    await expect(errorText).toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('409 path: already-a-member surfaces idempotency error', async ({ appPage, consoleErrors }) => {
    await appPage.route('**/api/invite', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'already a member' }),
      });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-submit"]').click();

    await expect(appPage.getByText('That participant is already a member.'))
      .toBeVisible({ timeout: 5000 });

    assertNoConsoleErrors(consoleErrors);
  });

  test('Cancel button closes the dialog without firing /api/invite', async ({ appPage, consoleErrors }) => {
    let inviteCalled = false;
    await appPage.route('**/api/invite', async (route) => {
      inviteCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-cancel"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Wait a tick so any in-flight call would have landed.
    await appPage.waitForTimeout(300);
    expect(inviteCalled).toBe(false);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Escape key closes the dialog without firing /api/invite', async ({ appPage, consoleErrors }) => {
    let inviteCalled = false;
    await appPage.route('**/api/invite', async (route) => {
      inviteCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await appPage.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    await appPage.waitForTimeout(300);
    expect(inviteCalled).toBe(false);

    assertNoConsoleErrors(consoleErrors);
  });

  test('Note field counter increments + caps at 200 chars (NOTE_MAX)', async ({ appPage, consoleErrors }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    const note = dialog.locator('[data-testid="invite-dialog-note"]');
    const counter = dialog.locator('[data-testid="invite-dialog-note-counter"]');

    // Fresh dialog -> empty note + counter at 0.
    await expect(counter).toContainText('0 / 200');

    // Type 100 chars -> counter reads "100 / 200".
    await note.fill('a'.repeat(100));
    await expect(counter).toContainText('100 / 200');

    // Fill 200 chars -> counter reads "200 / 200" and the field is NOT in
    // overflow class (boundary is inclusive). Note: the dialog allows 50
    // extra chars via maxlength = NOTE_MAX + 50 to give a clear "over"
    // indication via the noteOver derived, but the submit button disables.
    await note.fill('a'.repeat(200));
    await expect(counter).toContainText('200 / 200');

    // Fill 201 -> counter shows "201 / 200" (the note ITSELF, but submit
    // disables via canSubmit && !noteOver gate).
    await note.fill('a'.repeat(201));
    await expect(counter).toContainText('201 / 200');
    // Pick a candidate so the canSubmit branch is the only blocker.
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await expect(dialog.locator('[data-testid="invite-dialog-submit"]')).toBeDisabled();

    assertNoConsoleErrors(consoleErrors);
  });

  test('Submit is disabled until a candidate is selected', async ({ appPage, consoleErrors }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    const submit = dialog.locator('[data-testid="invite-dialog-submit"]');

    // No selection yet -> disabled.
    await expect(submit).toBeDisabled();

    // Pick a candidate -> enables.
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await expect(submit).toBeEnabled();

    // The selected row carries aria-selected="true".
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`))
      .toHaveAttribute('aria-selected', 'true');

    assertNoConsoleErrors(consoleErrors);
  });

  // -------------------------------------------------------------------------
  // Screenshot baselines
  // -------------------------------------------------------------------------

  test('screenshot: invite-dialog-open', async ({ appPage }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'invite-dialog-open', {
      locator: dialog,
      fullPage: false,
    });
  });

  test('screenshot: invite-dialog-picker-filtered', async ({ appPage }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator('[data-testid="invite-dialog-search"]').fill('cla');
    await expect(dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`)).toBeVisible();
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'invite-dialog-picker-filtered', {
      locator: dialog,
      fullPage: false,
    });
  });

  test('screenshot: invite-dialog-with-selection', async ({ appPage }) => {
    // We screenshot the dialog with a candidate picked + a note typed so
    // the success-pre-submit state is captured. We do NOT actually fire
    // the submit here (the success-path is covered by its own functional
    // test above); the screenshot focuses on the pre-submit pixels.
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await dialog.locator(`[data-testid="invite-dialog-row-${CLAUDE.key}"]`).click();
    await dialog.locator('[data-testid="invite-dialog-note"]').fill('welcome aboard');
    await waitForStable(appPage);
    await expectScreenshot(appPage, 'invite-dialog-with-selection', {
      locator: dialog,
      fullPage: false,
    });
  });
});

// -------------------------------------------------------------------------
// Source-level invariants (Pattern P-1 + P-2).
// -------------------------------------------------------------------------

test.describe('source-level invariants: InviteParticipantDialog', () => {
  test('InviteParticipantDialog pins NOTE_MAX = 200', () => {
    const src = readFileSync(INVITE_DIALOG_PATH, 'utf-8');
    // P-1 source-level pin on the tuning constant. Bites at edit-time if
    // anyone tries to bump the cap without updating the user-facing copy +
    // the server-side validation in tandem.
    expect(src).toMatch(/NOTE_MAX\s*=\s*200\b/);
  });

  test('InviteParticipantDialog pins the data-testid surface', () => {
    const src = readFileSync(INVITE_DIALOG_PATH, 'utf-8');
    // P-1 testid surface the Phase 2 tests above depend on. Pin them at
    // source so a future refactor that renames any of these trips this
    // test BEFORE the runtime Playwright run.
    expect(src).toMatch(/data-testid="invite-dialog"/);
    expect(src).toMatch(/data-testid="invite-dialog-title"/);
    expect(src).toMatch(/data-testid="invite-dialog-search"/);
    expect(src).toMatch(/data-testid="invite-dialog-picker"/);
    expect(src).toMatch(/data-testid="invite-dialog-empty"/);
    expect(src).toMatch(/data-testid="invite-dialog-row-/);
    expect(src).toMatch(/data-testid="invite-dialog-note"/);
    expect(src).toMatch(/data-testid="invite-dialog-note-counter"/);
    expect(src).toMatch(/data-testid="invite-dialog-cancel"/);
    expect(src).toMatch(/data-testid="invite-dialog-submit"/);
  });

  test('InviteParticipantDialog filter is case-insensitive substring on name', () => {
    const src = readFileSync(INVITE_DIALOG_PATH, 'utf-8');
    // P-1 pin the canonical filter shape. A future refactor that switches
    // to prefix-match or case-sensitive search would silently change UX;
    // this test bites at edit-time. The shape is:
    //   const q = (query ?? '').trim().toLowerCase();
    //   ... name.toLowerCase().includes(q)
    expect(src).toMatch(/\.trim\(\)\.toLowerCase\(\)/);
    expect(src).toMatch(/name\.toLowerCase\(\)\.includes\(/);
  });

  test('ChannelContextMenu dispatches claude-comms:invite-participant bus event', () => {
    const src = readFileSync(CHANNEL_CTX_MENU_PATH, 'utf-8');
    // P-2 cross-component invariant. The dialog mounts in App.svelte ONLY
    // in response to this specific window CustomEvent. Pin the event name
    // here AND the listener registration in App.svelte (next test). Both
    // sides of the bus boundary covered.
    expect(src).toMatch(/['"]claude-comms:invite-participant['"]/);
    // The menu item id is 'invite' (testid is channel-ctx-item-invite).
    expect(src).toMatch(/id:\s*['"]invite['"]/);
  });

  test('App.svelte listens for claude-comms:invite-participant and mounts InviteParticipantDialog', () => {
    const appPath = resolve(HERE, '..', '..', 'src', 'App.svelte');
    const src = readFileSync(appPath, 'utf-8');
    // P-2 the consumer side of the bus boundary.
    expect(src).toMatch(/addEventListener\(\s*['"]claude-comms:invite-participant['"]/);
    // The mount uses ``inviteDialog = { channel: ... }`` to gate the
    // {#if inviteDialog} block. Pin that state shape.
    expect(src).toMatch(/inviteDialog\s*=\s*\{\s*channel/);
  });

  test('store.inviteParticipant uses POST /api/invite with snake_case wire shape', () => {
    const src = readFileSync(STORE_PATH, 'utf-8');
    // P-2 cross-component invariant. The brief's pinned wire shape:
    //   POST /api/invite with { conversation_id, invitee_key, note? }
    // is owned by the store. A future refactor that renames either field
    // would silently break the dialog's submit path; this test bites at
    // edit-time. apiPost('/api/invite', body) is the canonical call.
    expect(src).toMatch(/apiPost\(\s*['"]\/api\/invite['"]/);
    expect(src).toMatch(/conversation_id:\s*channelId/);
    expect(src).toMatch(/invitee_key:\s*inviteeKey/);
  });
});

// -------------------------------------------------------------------------
// v0.4.4 W-8 mitigation: top-layer assertions on the invite dialog.
//
// Phil's v0.4.3 manual Layer B re-pass caught Bug 1 (right-click menus
// behind other elements). The InviteParticipantDialog is a bits-ui Dialog
// + Portal so it sits in the top layer by default, but the channel-
// context-menu it opens FROM needs the same coverage (Bug 1 root cause).
// -------------------------------------------------------------------------

test.describe('Scenario 05 v0.4.4 enhancements: W-8 top-layer coverage', () => {
  test('Channel context menu paints on top when right-clicked from sidebar (W-8)', async ({ appPage, consoleErrors }) => {
    await appPage.waitForSelector('[data-testid="sidebar-sections"]');
    const row = appPage.locator(`[data-testid="sidebar-channel-row-${TARGET_CHANNEL}"]`);
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    const menu = appPage.locator('[data-testid="channel-ctx-menu"]');
    await expect(menu).toBeVisible();
    // W-8: hit-test the menu center to confirm it is on top. Phase 2 puts it
    // in the browser native top layer via use:topLayer (no portal/z-index).
    await expectLocatorOnTop(appPage, menu);
    await appPage.keyboard.press('Escape');
    assertNoConsoleErrors(consoleErrors);
  });

  test('Invite dialog paints on top (W-8)', async ({ appPage, consoleErrors }) => {
    const dialog = await openInviteDialog(appPage, TARGET_CHANNEL);
    await expectLocatorOnTop(appPage, dialog);
    // Cancel cleanly.
    await dialog.locator('[data-testid="invite-dialog-cancel"]').click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    assertNoConsoleErrors(consoleErrors);
  });

  test('source-level pin: ChannelContextMenu uses the top-layer primitive (W-8)', () => {
    const src = readFileSync(CHANNEL_CTX_MENU_PATH, 'utf-8');
    // Phase 2: the menu AND its submenu each promote into the native top
    // layer via use:topLayer (design §F.8) - no portal, no hardcoded z-index.
    const matches = src.match(/use:topLayer/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/\{@attach\s+portal\(\)\}/);
    expect(src).not.toMatch(/z-index:\s*\d/);
  });
});
