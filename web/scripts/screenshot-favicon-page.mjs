// One-off: render mockups/favicons/index.html headlessly and capture
// (a) full page, (b) just card #26. Lets the orchestrator verify the
// channel-wave geometry isn't clipped at the canvas / viewBox edges.

import { chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const indexPath = path.join(repoRoot, 'mockups', 'favicons', 'index.html');
const url = 'file://' + indexPath;

const outDir = path.join(repoRoot, 'mockups', 'favicons');
const outFull = path.join(outDir, '_screenshot-full.png');
const outCard = path.join(outDir, '_screenshot-26.png');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1800 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });

// Full page
await page.screenshot({ path: outFull, fullPage: true });

// Just the 4th card (#26). The grid has 4 cards (01, 04, 12, 26).
const fourth = page.locator('.grid .card').nth(3);
await fourth.screenshot({ path: outCard });

console.log('Saved:', outFull);
console.log('Saved:', outCard);
await browser.close();
