import { chromium } from '@playwright/test';
import { writeFileSync } from 'fs';

const BASE_URL = 'http://localhost:5175';
const SCREENSHOT_DIR = '/home/plafayette/claude-comms/mockups';

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let cdpSession = null;
async function screenshot(page, name) {
  try {
    if (!cdpSession) cdpSession = await page.context().newCDPSession(page);
    const { data } = await cdpSession.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${SCREENSHOT_DIR}/test-channels-${name}.png`, Buffer.from(data, 'base64'));
    console.log(`  [screenshot] test-channels-${name}.png`);
  } catch (e) {
    console.log(`  [screenshot FAILED] ${name}: ${e.message}`);
  }
}

// All DOM interactions use page.evaluate to avoid Playwright locator timeouts
// caused by continuous MQTT reconnection re-renders
async function evalClick(page, selector) {
  await page.evaluate((sel) => {
    document.querySelectorAll('[data-testid="toast"], .toast').forEach(el => el.remove());
    const el = document.querySelector(sel);
    if (el) el.click();
  }, selector);
}

async function evalCount(page, selector) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
}

async function evalText(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() : null;
  }, selector);
}

async function evalClasses(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.className : null;
  }, selector);
}

function tid(testId) {
  return `[data-testid="${testId}"]`;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="channel-item-general"]') !== null, { timeout: 15000 });
  await delay(500);

  const results = [];

  // ── Test 1: Click each channel, verify header updates ──
  console.log('\n=== Test 1: Click each channel, verify header updates ===');
  await screenshot(page, '01-initial');

  const channelIds = ['general', 'project-alpha', 'lora-training', 'random'];
  const starredIds = ['project-alpha', 'lora-training'];
  let test1Pass = true;

  for (const chId of channelIds) {
    const testId = starredIds.includes(chId) ? `starred-channel-item-${chId}` : `channel-item-${chId}`;
    const count = await evalCount(page, tid(testId));
    if (count === 0) {
      console.log(`  WARN: ${testId} not found in DOM`);
      test1Pass = false;
      continue;
    }
    await evalClick(page, tid(testId));
    await delay(300);

    const headerName = await evalText(page, tid('header-channel-name'));
    if (headerName === chId) {
      console.log(`  PASS: clicked ${chId}, header shows "${headerName}"`);
    } else {
      console.log(`  FAIL: clicked ${chId}, header shows "${headerName}"`);
      test1Pass = false;
    }
  }
  await screenshot(page, '02-after-channel-clicks');
  results.push({ name: 'Click each channel updates header', pass: test1Pass });

  // ── Test 2: Verify active state highlighting ──
  console.log('\n=== Test 2: Verify active state highlighting ===');
  let test2Pass = true;

  await evalClick(page, tid('channel-item-general'));
  await delay(300);

  let generalClasses = await evalClasses(page, tid('channel-item-general'));
  let randomClasses = await evalClasses(page, tid('channel-item-random'));

  if (generalClasses?.includes('active')) {
    console.log('  PASS: general has active class');
  } else {
    console.log(`  FAIL: general missing active class, has: ${generalClasses}`);
    test2Pass = false;
  }

  if (!randomClasses?.includes('active')) {
    console.log('  PASS: random does NOT have active class');
  } else {
    console.log(`  FAIL: random should not be active`);
    test2Pass = false;
  }

  await evalClick(page, tid('channel-item-random'));
  await delay(300);

  generalClasses = await evalClasses(page, tid('channel-item-general'));
  randomClasses = await evalClasses(page, tid('channel-item-random'));

  if (randomClasses?.includes('active')) {
    console.log('  PASS: random now has active class');
  } else {
    console.log(`  FAIL: random missing active class`);
    test2Pass = false;
  }

  if (!generalClasses?.includes('active')) {
    console.log('  PASS: general lost active class');
  } else {
    console.log(`  FAIL: general still has active class`);
    test2Pass = false;
  }

  await screenshot(page, '03-active-state');
  results.push({ name: 'Active state highlighting', pass: test2Pass });

  // ── Test 3: Collapse starred section ──
  console.log('\n=== Test 3: Collapse starred section ===');
  let test3Pass = true;

  const starredToggleCount = await evalCount(page, tid('sidebar-starred-toggle'));
  if (starredToggleCount === 0) {
    console.log('  SKIP: No starred section toggle found');
    test3Pass = false;
  } else {
    const beforeCount = await evalCount(page, tid('starred-channel-item-project-alpha'));
    console.log(`  Before collapse: project-alpha count = ${beforeCount}`);

    await screenshot(page, '04-before-starred-collapse');
    await evalClick(page, tid('sidebar-starred-toggle'));
    await delay(500);

    const afterCount = await evalCount(page, tid('starred-channel-item-project-alpha'));
    console.log(`  After collapse: project-alpha count = ${afterCount}`);

    if (beforeCount > 0 && afterCount === 0) {
      console.log('  PASS: Starred section collapsed');
    } else {
      console.log('  FAIL: Collapse did not work');
      test3Pass = false;
    }
    await screenshot(page, '05-after-starred-collapse');
  }
  results.push({ name: 'Collapse starred section', pass: test3Pass });

  // ── Test 4: Expand starred section ──
  console.log('\n=== Test 4: Expand starred section ===');
  let test4Pass = true;

  if (starredToggleCount > 0) {
    await evalClick(page, tid('sidebar-starred-toggle'));
    await delay(500);

    const afterCount = await evalCount(page, tid('starred-channel-item-project-alpha'));
    console.log(`  After expand: project-alpha count = ${afterCount}`);

    if (afterCount > 0) {
      console.log('  PASS: Starred section expanded');
    } else {
      const sectionClasses = await evalClasses(page, tid('sidebar-starred-section'));
      console.log(`  FAIL: Element not in DOM. Section classes: ${sectionClasses}`);
      test4Pass = false;
    }
    await screenshot(page, '06-after-starred-expand');
  } else {
    console.log('  SKIP: No starred toggle');
    test4Pass = false;
  }
  results.push({ name: 'Expand starred section', pass: test4Pass });

  // ── Test 5: Collapse conversations section ──
  console.log('\n=== Test 5: Collapse/expand conversations section ===');
  let test5Pass = true;

  const convoToggleCount = await evalCount(page, tid('sidebar-conversations-toggle'));
  if (convoToggleCount === 0) {
    console.log('  FAIL: No conversations toggle found');
    test5Pass = false;
  } else {
    const beforeCount = await evalCount(page, tid('channel-item-general'));
    console.log(`  Before collapse: general count = ${beforeCount}`);

    await evalClick(page, tid('sidebar-conversations-toggle'));
    await delay(500);

    const afterCount = await evalCount(page, tid('channel-item-general'));
    console.log(`  After collapse: general count = ${afterCount}`);

    if (beforeCount > 0 && afterCount === 0) {
      console.log('  PASS: Conversations section collapsed');
    } else {
      const sectionClasses = await evalClasses(page, tid('sidebar-conversations-section'));
      console.log(`  FAIL: Collapse did not work. Section classes: ${sectionClasses}`);
      test5Pass = false;
    }

    await screenshot(page, '07-after-convo-collapse');

    // Re-expand
    await evalClick(page, tid('sidebar-conversations-toggle'));
    await delay(500);

    const afterExpandCount = await evalCount(page, tid('channel-item-general'));
    console.log(`  After re-expand: general count = ${afterExpandCount}`);
    if (afterExpandCount === 0) {
      console.log('  FAIL: Could not re-expand');
      test5Pass = false;
    }
    await screenshot(page, '08-after-convo-expand');
  }
  results.push({ name: 'Collapse/expand conversations section', pass: test5Pass });

  // ── Test 6: Click channel while search panel is open ──
  console.log('\n=== Test 6: Click channel while search panel is open ===');
  let test6Pass = true;

  await evalClick(page, tid('channel-item-random'));
  await delay(300);

  await evalClick(page, tid('header-search-btn'));
  await delay(500);
  await screenshot(page, '09-search-panel-open');

  await evalClick(page, tid('channel-item-general'));
  await delay(300);

  const headerAfterSwitch = await evalText(page, tid('header-channel-name'));
  if (headerAfterSwitch === 'general') {
    console.log('  PASS: Channel switched while search panel was open');
  } else {
    console.log(`  FAIL: Header shows "${headerAfterSwitch}" instead of "general"`);
    test6Pass = false;
  }
  await screenshot(page, '10-channel-switch-with-panel');
  results.push({ name: 'Channel switch with panel open', pass: test6Pass });

  // ── Test 7: Sidebar search input ──
  console.log('\n=== Test 7: Sidebar search input ===');
  let test7Pass = true;

  const searchExists = await evalCount(page, tid('sidebar-search'));
  if (searchExists === 0) {
    console.log('  FAIL: Sidebar search input not found');
    test7Pass = false;
  } else {
    // Focus and type using page.evaluate
    const focused = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="sidebar-search"]');
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    });

    if (focused) {
      console.log('  PASS: Search input is focusable');
    } else {
      console.log('  FAIL: Search input did not receive focus');
      test7Pass = false;
    }

    // Type using native input value setter
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="sidebar-search"]');
      if (!el) return;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(el, 'test query');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await delay(200);

    const value = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="sidebar-search"]');
      return el ? el.value : null;
    });

    if (value === 'test query') {
      console.log('  PASS: Can type in search input');
    } else {
      console.log(`  FAIL: Search input value is "${value}"`);
      test7Pass = false;
    }
    await screenshot(page, '11-search-input');
  }
  results.push({ name: 'Sidebar search input', pass: test7Pass });

  // ── Summary ──
  console.log('\n' + '='.repeat(50));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(50));
  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log('='.repeat(50));
  console.log(allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
  console.log('='.repeat(50));

  if (cdpSession) await cdpSession.detach().catch(() => {});
  await browser.close();
  return { results, allPass };
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
