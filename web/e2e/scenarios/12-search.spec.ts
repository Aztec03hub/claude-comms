// 12-search.spec.ts - search panel + type filters.
//
// Ports the unique search coverage from the deleted legacy
// search-filters.spec.js: the All / Messages / Files / Code / Links type
// filters, <mark> match highlighting, and the empty state. searchMessages
// scans the ACTIVE channel's loaded messages, so we seed #general with one
// message per content type sharing a unique term (ztagx) and switch there,
// making the per-filter result counts deterministic.

import { test, expect } from '../fixtures/browser';
import { canonicalSeed, PHIL, SeedSpec } from '../fixtures/seedData';

// Rendering a message that contains a real URL makes the chat view fetch
// that link's favicon (google s2), which the app's own CSP (img-src 'self'
// data:) blocks -> an expected console.error in this seeded scenario. Filter
// only that known line; everything else (incl. state_unsafe_mutation) still
// fails the test, matching the shared assertNoConsoleErrors contract.
function assertNoUnexpectedConsoleErrors(consoleErrors: string[]) {
  const real = consoleErrors.filter(
    (e) =>
      !/Failed to load resource/.test(e)
      && !/s2\/favicons\?domain|img-src 'self' data:/.test(e),
  );
  expect(real, `Unexpected console errors:\n${real.join('\n')}`).toEqual([]);
  for (const e of consoleErrors) expect(e).not.toContain('state_unsafe_mutation');
}

const TERM = 'ztagx';
const base = canonicalSeed();
const searchSeed: SeedSpec = {
  ...base,
  messages: [
    ...base.messages,
    { conv: 'general', sender: PHIL, body: TERM + ' plain status note' },
    { conv: 'general', sender: PHIL, body: TERM + ' snippet: ```const a = 1;```' },
    { conv: 'general', sender: PHIL, body: TERM + ' docs at https://example.com/page' },
    { conv: 'general', sender: PHIL, body: TERM + ' see [file:report.pdf]' },
  ],
};

test.use({ slot: 11, seedSpec: searchSeed });

async function openSearch(appPage: import('@playwright/test').Page) {
  await appPage.waitForSelector('[data-testid="sidebar-sections"]');
  await appPage.locator('[data-testid="sidebar-channel-row-general"]').click();
  await appPage.waitForSelector('[data-testid="chat-view"]');
  await appPage.locator('[data-testid="chat-header-search-btn"]').click();
  const panel = appPage.locator('[data-testid="search-panel"]');
  await expect(panel).toBeVisible();
  return panel;
}

async function runSearch(appPage: import('@playwright/test').Page, term: string) {
  await appPage.locator('[data-testid="search-panel-input"]').fill(term);
}

test.describe('Scenario 12: search panel + type filters', () => {
  test('All returns every message containing the term', async ({ appPage, consoleErrors }) => {
    const panel = await openSearch(appPage);
    await runSearch(appPage, TERM);
    await expect(panel.locator('.search-result')).toHaveCount(4);
    await expect(panel.locator('.search-results-count')).toContainText('4 results');
    assertNoUnexpectedConsoleErrors(consoleErrors);
  });

  test('Code keeps only code-block messages', async ({ appPage, consoleErrors }) => {
    const panel = await openSearch(appPage);
    await runSearch(appPage, TERM);
    await panel.locator('[data-testid="search-filter-code"]').click();
    await expect(panel.locator('.search-result')).toHaveCount(1);
    await expect(panel.locator('.search-results')).toContainText('const a = 1');
    assertNoUnexpectedConsoleErrors(consoleErrors);
  });

  test('Links keeps only messages with URLs', async ({ appPage, consoleErrors }) => {
    const panel = await openSearch(appPage);
    await runSearch(appPage, TERM);
    await panel.locator('[data-testid="search-filter-links"]').click();
    await expect(panel.locator('.search-result')).toHaveCount(1);
    await expect(panel.locator('.search-results')).toContainText('https://example.com');
    assertNoUnexpectedConsoleErrors(consoleErrors);
  });

  test('Files keeps only messages with file markers', async ({ appPage, consoleErrors }) => {
    const panel = await openSearch(appPage);
    await runSearch(appPage, TERM);
    await panel.locator('[data-testid="search-filter-files"]').click();
    await expect(panel.locator('.search-result')).toHaveCount(1);
    await expect(panel.locator('.search-results')).toContainText('report.pdf');
    assertNoUnexpectedConsoleErrors(consoleErrors);
  });

  test('Messages excludes code-block and link messages', async ({ appPage, consoleErrors }) => {
    const panel = await openSearch(appPage);
    await runSearch(appPage, TERM);
    await panel.locator('[data-testid="search-filter-messages"]').click();
    // plain + file-marker pass (no code fence, no URL); code + link are excluded.
    await expect(panel.locator('.search-result')).toHaveCount(2);
    await expect(panel.locator('.search-results')).not.toContainText('const a = 1');
    await expect(panel.locator('.search-results')).not.toContainText('https://');
    assertNoUnexpectedConsoleErrors(consoleErrors);
  });

  test('matches are wrapped in <mark> for highlighting', async ({ appPage, consoleErrors }) => {
    const panel = await openSearch(appPage);
    await runSearch(appPage, TERM);
    const firstMark = panel.locator('.search-result-text').first().locator('mark').first();
    await expect(firstMark).toHaveText(TERM, { ignoreCase: true });
    assertNoUnexpectedConsoleErrors(consoleErrors);
  });

  test('empty state when nothing matches', async ({ appPage, consoleErrors }) => {
    const panel = await openSearch(appPage);
    await runSearch(appPage, 'zzzznotarealmatch');
    await expect(panel.locator('.search-empty-title')).toHaveText('No results found');
    assertNoUnexpectedConsoleErrors(consoleErrors);
  });
});
