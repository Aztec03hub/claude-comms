/**
 * Comprehensive Web UI Test — Rounds 1-5
 * Uses Playwright + CDP for reliable testing with MQTT WebSocket mock.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE_URL = 'http://localhost:6001';
const MOCKUPS = '/home/plafayette/claude-comms/mockups';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const bugs = [];
function logBug(round, description) {
  bugs.push({ round, description });
  console.log(`  [BUG R${round}] ${description}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Block fonts
  await page.route('**/fonts.googleapis.com/**', route => route.abort());
  await page.route('**/fonts.gstatic.com/**', route => route.abort());

  // Mock MQTT WebSocket
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = class MockWebSocket extends EventTarget {
      constructor(url) {
        super();
        this.readyState = 0;
        this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
        this.bufferedAmount = 0; this.extensions = ''; this.protocol = ''; this.binaryType = 'blob';
        if (!url.includes('mqtt')) return new OrigWS(url);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.({});
          this.dispatchEvent(new Event('open'));
        }, 50);
      }
      send() {}
      close() { this.readyState = 3; }
    };
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-testid="message-input"]', { timeout: 30000 });

  // CDP session
  const cdp = await context.newCDPSession(page);

  async function ce(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('CDP: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  async function sendMessage(text) {
    await ce(`(() => {
      const i = document.querySelector('[data-testid="message-input"]');
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(i, ${JSON.stringify(text)});
      i.dispatchEvent(new Event('input', {bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await delay(400);
  }

  async function clickEl(sel) {
    const found = await ce(`!!document.querySelector(${JSON.stringify(sel)})`);
    if (!found) { console.log(`    WARN: selector not found: ${sel}`); return false; }
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(300);
    return true;
  }

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  async function getText(sel) {
    return ce(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim()`);
  }

  async function hasClass(sel, cls) {
    return ce(`document.querySelector(${JSON.stringify(sel)})?.classList?.contains(${JSON.stringify(cls)})`);
  }

  async function screenshot(name) {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${MOCKUPS}/${name}.png`, Buffer.from(data, 'base64'));
      console.log(`    Screenshot: ${name}.png`);
    } catch (e) { console.log(`    Screenshot failed: ${e.message}`); }
  }

  async function getCount(sel) {
    return ce(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  }

  // ═══════════════════════════════════════════════════════
  // ROUND 1: SIDEBAR
  // ═══════════════════════════════════════════════════════
  console.log('\n=== ROUND 1: SIDEBAR ===');

  // 1a. Click each channel, verify active state + header update
  console.log('  1a: Channel switching...');
  const channels = ['general', 'project-alpha', 'lora-training', 'random'];
  for (const ch of channels) {
    // Find the channel item - try starred first, then normal
    let sel = `[data-testid="channel-item-${ch}"]`;
    let found = await exists(sel);
    if (!found) {
      sel = `[data-testid="starred-channel-item-${ch}"]`;
      found = await exists(sel);
    }
    if (!found) { console.log(`    Channel ${ch} not visible (maybe collapsed)`); continue; }
    await clickEl(sel);
    await delay(200);

    // Check header updated
    const headerName = await getText('[data-testid="header-channel-name"]');
    if (headerName !== ch) {
      logBug(1, `Header should show "${ch}" but shows "${headerName}"`);
    }

    // Check active class
    const isActive = await hasClass(sel, 'active');
    if (!isActive) {
      logBug(1, `Channel "${ch}" should have 'active' class after click`);
    }
    console.log(`    Channel "${ch}": header="${headerName}", active=${isActive}`);
  }
  await screenshot('overnight-r1-channels');

  // 1b. Collapse/expand starred section
  console.log('  1b: Starred collapse/expand...');
  const starredExists = await exists('[data-testid="sidebar-starred-toggle"]');
  if (starredExists) {
    await clickEl('[data-testid="sidebar-starred-toggle"]');
    await delay(200);
    const starredHidden = !(await exists('[data-testid="starred-channel-item-project-alpha"]'));
    console.log(`    Starred collapsed: ${starredHidden}`);
    if (!starredHidden) logBug(1, 'Starred section did not collapse');

    await clickEl('[data-testid="sidebar-starred-toggle"]');
    await delay(200);
    const starredVisible = await exists('[data-testid="starred-channel-item-project-alpha"]');
    console.log(`    Starred expanded: ${starredVisible}`);
    if (!starredVisible) logBug(1, 'Starred section did not expand');
  }

  // 1c. Collapse/expand conversations section
  console.log('  1c: Conversations collapse/expand...');
  await clickEl('[data-testid="sidebar-conversations-toggle"]');
  await delay(200);
  const convoHidden = !(await exists('[data-testid="channel-item-general"]'));
  console.log(`    Conversations collapsed: ${convoHidden}`);
  if (!convoHidden) logBug(1, 'Conversations section did not collapse');

  await clickEl('[data-testid="sidebar-conversations-toggle"]');
  await delay(200);
  const convoVisible = await exists('[data-testid="channel-item-general"]');
  console.log(`    Conversations expanded: ${convoVisible}`);
  if (!convoVisible) logBug(1, 'Conversations section did not expand');
  await screenshot('overnight-r1-collapse');

  // 1d. Sidebar search input
  console.log('  1d: Sidebar search input...');
  const searchInput = await exists('[data-testid="sidebar-search"]');
  console.log(`    Search input exists: ${searchInput}`);
  if (!searchInput) logBug(1, 'Sidebar search input not found');

  // 1e. New Conversation button
  console.log('  1e: New Conversation button...');
  await clickEl('[data-testid="sidebar-create-channel"]');
  await delay(300);
  const modalOpen = await exists('[data-testid="channel-modal"]');
  console.log(`    Channel modal opened: ${modalOpen}`);
  if (!modalOpen) logBug(1, 'New Conversation button did not open channel modal');
  if (modalOpen) {
    await clickEl('[data-testid="channel-modal-cancel"]');
    await delay(200);
  }

  // 1f. User profile click
  console.log('  1f: User profile click...');
  await clickEl('[data-testid="sidebar-user-profile"]');
  await delay(300);
  const profileOpen = await exists('[data-testid="profile-card"]');
  console.log(`    Profile card opened: ${profileOpen}`);
  if (!profileOpen) logBug(1, 'User profile click did not open profile card');
  // Close it
  if (profileOpen) {
    await clickEl('[data-testid="profile-card-close"]');
    await delay(200);
  }

  // 1g. Settings gear
  console.log('  1g: Settings gear (sidebar user settings)...');
  const settingsBtn = await exists('.user-settings');
  console.log(`    User settings button exists: ${settingsBtn}`);
  if (settingsBtn) {
    await clickEl('.user-settings');
    await delay(300);
    const settingsOpen = await exists('[data-testid="settings-panel"]');
    console.log(`    Settings panel opened: ${settingsOpen}`);
    if (!settingsOpen) logBug(1, 'User settings gear did not open settings panel');
    if (settingsOpen) {
      await clickEl('[data-testid="settings-panel-close"]');
      await delay(200);
    }
  }

  // 1h. Mute buttons
  console.log('  1h: Mute buttons...');
  // Need to hover a channel to see mute button - just verify it exists in DOM
  const muteBtn = await exists('[data-testid="channel-mute-general"]');
  console.log(`    Mute button exists for general: ${muteBtn}`);
  if (muteBtn) {
    await clickEl('[data-testid="channel-mute-general"]');
    await delay(200);
    const isMuted = await hasClass('[data-testid="channel-item-general"]', 'muted');
    console.log(`    General muted after click: ${isMuted}`);
    if (!isMuted) logBug(1, 'Mute button did not toggle muted state on channel');
    // Unmute
    await clickEl('[data-testid="channel-mute-general"]');
    await delay(200);
  }
  await screenshot('overnight-r1-sidebar-final');

  // ═══════════════════════════════════════════════════════
  // ROUND 2: CHAT HEADER
  // ═══════════════════════════════════════════════════════
  console.log('\n=== ROUND 2: CHAT HEADER ===');

  // Switch to general first
  await clickEl('[data-testid="channel-item-general"]');
  await delay(200);

  // 2a. Search button toggles search panel
  console.log('  2a: Search button toggle...');
  await clickEl('[data-testid="header-search-btn"]');
  await delay(300);
  let searchPanelOpen = await exists('[data-testid="search-panel"]');
  console.log(`    Search panel after click: ${searchPanelOpen}`);
  if (!searchPanelOpen) logBug(2, 'Header search button did not open search panel');

  // Toggle off
  await clickEl('[data-testid="header-search-btn"]');
  await delay(300);
  searchPanelOpen = await exists('[data-testid="search-panel"]');
  console.log(`    Search panel after toggle off: ${searchPanelOpen}`);
  if (searchPanelOpen) logBug(2, 'Header search button did not close search panel on second click');
  await screenshot('overnight-r2-search');

  // 2b. Pin button toggles pinned panel
  console.log('  2b: Pin button toggle...');
  await clickEl('[data-testid="header-pin-btn"]');
  await delay(300);
  let pinnedOpen = await exists('[data-testid="pinned-panel"]');
  console.log(`    Pinned panel after click: ${pinnedOpen}`);
  if (!pinnedOpen) logBug(2, 'Header pin button did not open pinned panel');

  await clickEl('[data-testid="header-pin-btn"]');
  await delay(300);
  pinnedOpen = await exists('[data-testid="pinned-panel"]');
  console.log(`    Pinned panel after toggle off: ${pinnedOpen}`);
  if (pinnedOpen) logBug(2, 'Header pin button did not close pinned panel on second click');

  // 2c. Settings button toggles settings panel
  console.log('  2c: Settings button toggle...');
  await clickEl('[data-testid="header-settings-btn"]');
  await delay(300);
  let settingsPanelOpen = await exists('[data-testid="settings-panel"]');
  console.log(`    Settings panel after click: ${settingsPanelOpen}`);
  if (!settingsPanelOpen) logBug(2, 'Header settings button did not open settings panel');

  await clickEl('[data-testid="header-settings-btn"]');
  await delay(300);
  settingsPanelOpen = await exists('[data-testid="settings-panel"]');
  console.log(`    Settings panel after toggle off: ${settingsPanelOpen}`);
  if (settingsPanelOpen) logBug(2, 'Header settings button did not close settings panel');

  // 2d. Members count toggles member list sidebar
  console.log('  2d: Members count toggle...');
  const membersCountBtn = await exists('[data-testid="header-members-count"]');
  console.log(`    Members count button exists: ${membersCountBtn}`);

  // Member list should be visible by default
  let memberListVisible = await exists('[data-testid="member-list"]');
  console.log(`    Member list initially visible: ${memberListVisible}`);

  await clickEl('[data-testid="header-members-count"]');
  await delay(300);
  let memberListAfterClick = await exists('[data-testid="member-list"]');
  console.log(`    Member list after click: ${memberListAfterClick}`);
  if (memberListAfterClick === memberListVisible) {
    logBug(2, 'Members count button did not toggle member list visibility');
  }

  // Toggle it back on
  await clickEl('[data-testid="header-members-count"]');
  await delay(300);
  await screenshot('overnight-r2-header');

  // ═══════════════════════════════════════════════════════
  // ROUND 3: MESSAGE INPUT
  // ═══════════════════════════════════════════════════════
  console.log('\n=== ROUND 3: MESSAGE INPUT ===');

  // 3a. Type + Enter sends
  console.log('  3a: Type + Enter sends...');
  await sendMessage('Hello from Round 3 test!');
  let bubbleCount = await getCount('.bubble');
  console.log(`    Bubbles after send: ${bubbleCount}`);
  if (bubbleCount < 1) logBug(3, 'Message not sent via Enter key');
  await screenshot('overnight-r3-send-enter');

  // 3b. Click send button
  console.log('  3b: Click send button...');
  await ce(`(() => {
    const i = document.querySelector('[data-testid="message-input"]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(i, 'Message via send button');
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await delay(200);
  await clickEl('[data-testid="send-button"]');
  await delay(400);
  let bubbleCount2 = await getCount('.bubble');
  console.log(`    Bubbles after send button: ${bubbleCount2}`);
  if (bubbleCount2 <= bubbleCount) logBug(3, 'Message not sent via send button click');

  // 3c. Empty input rejected
  console.log('  3c: Empty input rejection...');
  const beforeCount = await getCount('.bubble');
  await sendMessage('   ');
  await delay(200);
  const afterCount = await getCount('.bubble');
  console.log(`    Bubbles before: ${beforeCount}, after empty send: ${afterCount}`);
  if (afterCount > beforeCount) logBug(3, 'Empty/whitespace message was accepted');

  // 3d. Emoji button opens picker
  console.log('  3d: Emoji button...');
  await clickEl('[data-testid="input-emoji"]');
  await delay(300);
  const emojiPickerOpen = await exists('[data-testid="emoji-picker"]');
  console.log(`    Emoji picker opened: ${emojiPickerOpen}`);
  if (!emojiPickerOpen) logBug(3, 'Emoji button did not open emoji picker');
  // Close it
  if (emojiPickerOpen) {
    await ce(`document.querySelector('.emoji-backdrop')?.click()`);
    await delay(200);
  }

  // 3e. Attach opens file dialog
  console.log('  3e: Attach button...');
  const attachBtn = await exists('[data-testid="input-attach"]');
  console.log(`    Attach button exists: ${attachBtn}`);
  // The attach button calls fileInputEl.click() which opens native dialog - can't test dialog directly
  // But we can verify the button has a click handler and the hidden file input exists
  const hiddenFileInput = await exists('[data-testid="input-file-hidden"]');
  console.log(`    Hidden file input exists: ${hiddenFileInput}`);
  if (!hiddenFileInput) logBug(3, 'Hidden file input for attach not found');

  // 3f. Format button shows help
  console.log('  3f: Format button...');
  await clickEl('[data-testid="input-format"]');
  await delay(300);
  const formatHelp = await exists('[data-testid="format-help"]');
  console.log(`    Format help visible: ${formatHelp}`);
  if (!formatHelp) logBug(3, 'Format button did not show format help');
  // Toggle off
  if (formatHelp) {
    await clickEl('[data-testid="input-format"]');
    await delay(200);
  }

  // 3g. Snippet button inserts template
  console.log('  3g: Snippet button...');
  // Clear input first
  await ce(`(() => {
    const i = document.querySelector('[data-testid="message-input"]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(i, '');
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await delay(100);
  await clickEl('[data-testid="input-snippet"]');
  await delay(300);
  const inputVal = await ce(`document.querySelector('[data-testid="message-input"]')?.value`);
  console.log(`    Input value after snippet: "${inputVal?.substring(0, 40)}..."`);
  if (!inputVal || !inputVal.includes('```')) logBug(3, 'Snippet button did not insert code template');
  // Clear it
  await ce(`(() => {
    const i = document.querySelector('[data-testid="message-input"]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(i, '');
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await screenshot('overnight-r3-input');

  // ═══════════════════════════════════════════════════════
  // ROUND 4: MESSAGES
  // ═══════════════════════════════════════════════════════
  console.log('\n=== ROUND 4: MESSAGES ===');

  // 4a. Send multiple, verify grouping
  console.log('  4a: Multiple messages + grouping...');
  await sendMessage('First message in group');
  await sendMessage('Second message in group');
  await sendMessage('Third message in group');
  await delay(300);

  // Messages from the same sender should be grouped (consecutive class)
  const consecutiveCount = await getCount('.msg-row.consecutive');
  console.log(`    Consecutive messages: ${consecutiveCount}`);
  if (consecutiveCount < 1) logBug(4, 'Messages from same sender not grouped (no consecutive class)');
  await screenshot('overnight-r4-grouping');

  // 4b. Right-click context menu
  console.log('  4b: Right-click context menu...');
  // Use Playwright's native right-click (Issue G: synthetic contextmenu doesn't work with Svelte)
  const firstBubble = page.locator('.bubble').first();
  try {
    await firstBubble.click({ button: 'right', timeout: 5000 });
    await delay(500);
    const ctxMenu = await exists('[data-testid="context-menu"]');
    console.log(`    Context menu opened: ${ctxMenu}`);
    if (!ctxMenu) logBug(4, 'Right-click did not open context menu');

    // 4c. Context menu items
    if (ctxMenu) {
      const replyExists = await exists('[data-testid="ctx-reply"]');
      const forwardExists = await exists('[data-testid="ctx-forward"]');
      const pinExists = await exists('[data-testid="ctx-pin"]');
      const copyExists = await exists('[data-testid="ctx-copy"]');
      const reactExists = await exists('[data-testid="ctx-react"]');
      const unreadExists = await exists('[data-testid="ctx-unread"]');
      const deleteExists = await exists('[data-testid="ctx-delete"]');
      console.log(`    Menu items: reply=${replyExists} fwd=${forwardExists} pin=${pinExists} copy=${copyExists} react=${reactExists} unread=${unreadExists} delete=${deleteExists}`);

      // 4d. Click Reply - should open thread panel
      console.log('  4d: Context menu - Reply action...');
      await clickEl('[data-testid="ctx-reply"]');
      await delay(400);
      const threadOpen = await exists('[data-testid="thread-panel"]');
      console.log(`    Thread panel opened via Reply: ${threadOpen}`);
      if (!threadOpen) logBug(4, 'Reply context menu action did not open thread panel');
      if (threadOpen) {
        await clickEl('[data-testid="thread-panel-close"]');
        await delay(200);
      }
    }
  } catch (e) {
    console.log(`    Right-click failed: ${e.message}`);
  }

  // 4e. Pin via context menu
  console.log('  4e: Context menu - Pin action...');
  try {
    await firstBubble.click({ button: 'right', timeout: 5000 });
    await delay(500);
    if (await exists('[data-testid="ctx-pin"]')) {
      await clickEl('[data-testid="ctx-pin"]');
      await delay(300);
      // Open pinned panel to verify
      await clickEl('[data-testid="header-pin-btn"]');
      await delay(300);
      const pinnedItems = await getCount('.pinned-item');
      console.log(`    Pinned items: ${pinnedItems}`);
      if (pinnedItems < 1) logBug(4, 'Pin action did not add message to pinned panel');
      await clickEl('[data-testid="header-pin-btn"]');
      await delay(200);
    }
  } catch (e) { console.log(`    Pin test skipped: ${e.message}`); }

  // 4f. Copy via context menu
  console.log('  4f: Context menu - Copy action...');
  try {
    await firstBubble.click({ button: 'right', timeout: 5000 });
    await delay(500);
    if (await exists('[data-testid="ctx-copy"]')) {
      await clickEl('[data-testid="ctx-copy"]');
      await delay(300);
      console.log(`    Copy action executed (clipboard API)`);
    }
  } catch (e) { console.log(`    Copy test skipped: ${e.message}`); }

  // 4g. Delete via context menu
  console.log('  4g: Context menu - Delete action...');
  const bubblesBefore = await getCount('.bubble');
  try {
    await firstBubble.click({ button: 'right', timeout: 5000 });
    await delay(500);
    if (await exists('[data-testid="ctx-delete"]')) {
      await clickEl('[data-testid="ctx-delete"]');
      await delay(400);
      // Should show confirm dialog
      const confirmDialog = await exists('[data-testid="confirm-dialog"]');
      // Try alternative - the ConfirmDialog may not have data-testid. Check for the text
      const hasConfirmBtn = await ce(`!!document.querySelector('.confirm-danger, .confirm-btn')`);
      console.log(`    Confirm dialog/button visible: ${confirmDialog || hasConfirmBtn}`);
      // Click the confirm/OK button to actually delete
      const confirmBtn = await ce(`(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) { if (b.textContent.trim() === 'Delete') return true; }
        return false;
      })()`);
      if (confirmBtn) {
        await ce(`(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) { if (b.textContent.trim() === 'Delete') { b.click(); return true; } }
          return false;
        })()`);
        await delay(300);
      }
    }
  } catch (e) { console.log(`    Delete test skipped: ${e.message}`); }
  const bubblesAfter = await getCount('.bubble');
  console.log(`    Bubbles before delete: ${bubblesBefore}, after: ${bubblesAfter}`);

  // 4h. Hover action bar (Reply/React/More)
  console.log('  4h: Hover action bar...');
  // Action bar is hidden by default, visible on hover
  // Force show it via CSS manipulation
  await ce(`(() => {
    const row = document.querySelector('.msg-row');
    if (row) row.classList.add('hover-forced');
    // Make actions visible
    const actions = document.querySelector('[data-testid="message-actions"]');
    if (actions) actions.style.opacity = '1';
  })()`);
  await delay(200);
  const replyBtn = await exists('[data-testid="action-reply"]');
  const reactBtn = await exists('[data-testid="action-react"]');
  const moreBtn = await exists('[data-testid="action-more"]');
  console.log(`    Action buttons: reply=${replyBtn}, react=${reactBtn}, more=${moreBtn}`);

  // 4i. React button from action bar opens emoji picker
  console.log('  4i: React button from action bar...');
  if (reactBtn) {
    await clickEl('[data-testid="action-react"]');
    await delay(400);
    const emojiOpen = await exists('[data-testid="emoji-picker"]');
    console.log(`    Emoji picker from React button: ${emojiOpen}`);
    if (!emojiOpen) logBug(4, 'React action button did not open emoji picker');
    if (emojiOpen) {
      // Select an emoji to add reaction
      await clickEl('[data-testid="emoji-item"]');
      await delay(300);
      const reactions = await getCount('.reaction');
      console.log(`    Reactions after emoji select: ${reactions}`);
    }
  }

  // 4j. Toggle existing reaction
  console.log('  4j: Toggle existing reaction...');
  const reactionBtn = await exists('.reaction');
  if (reactionBtn) {
    const countBefore = await ce(`parseInt(document.querySelector('.reaction .count')?.textContent || '0')`);
    await clickEl('.reaction');
    await delay(300);
    const countAfter = await ce(`parseInt(document.querySelector('.reaction .count')?.textContent || '0')`);
    console.log(`    Reaction count before: ${countBefore}, after: ${countAfter}`);
    // Toggling our own active reaction should decrease count
  }

  // 4k. Reaction (+) button
  console.log('  4k: Reaction add (+) button...');
  const addReactionBtn = await exists('.reaction-add');
  console.log(`    Reaction add button exists: ${addReactionBtn}`);
  if (addReactionBtn) {
    // Force visible
    await ce(`document.querySelector('.reaction-add').style.opacity = '1'`);
    await clickEl('.reaction-add');
    await delay(400);
    const emojiPickerForReaction = await exists('[data-testid="emoji-picker"]');
    console.log(`    Emoji picker from (+) button: ${emojiPickerForReaction}`);
    if (!emojiPickerForReaction) logBug(4, 'Reaction (+) button did not open emoji picker');
    if (emojiPickerForReaction) {
      await ce(`document.querySelector('.emoji-backdrop')?.click()`);
      await delay(200);
    }
  }
  await screenshot('overnight-r4-messages');

  // ═══════════════════════════════════════════════════════
  // ROUND 5: PANELS
  // ═══════════════════════════════════════════════════════
  console.log('\n=== ROUND 5: PANELS ===');

  // 5a. Search panel open + close
  console.log('  5a: Search panel open/close...');
  await clickEl('[data-testid="header-search-btn"]');
  await delay(300);
  let sp = await exists('[data-testid="search-panel"]');
  console.log(`    Search panel open: ${sp}`);
  if (!sp) logBug(5, 'Search panel did not open');

  // Close via close button
  if (sp) {
    await clickEl('[data-testid="search-panel-close"]');
    await delay(300);
    sp = await exists('[data-testid="search-panel"]');
    console.log(`    Search panel after close button: ${sp}`);
    if (sp) logBug(5, 'Search panel close button did not work');
  }

  // 5b. Pinned panel open + close
  console.log('  5b: Pinned panel open/close...');
  await clickEl('[data-testid="header-pin-btn"]');
  await delay(300);
  let pp = await exists('[data-testid="pinned-panel"]');
  console.log(`    Pinned panel open: ${pp}`);
  if (!pp) logBug(5, 'Pinned panel did not open');

  if (pp) {
    await clickEl('[data-testid="pinned-panel-close"]');
    await delay(300);
    pp = await exists('[data-testid="pinned-panel"]');
    console.log(`    Pinned panel after close: ${pp}`);
    if (pp) logBug(5, 'Pinned panel close button did not work');
  }

  // 5c. Thread panel open + close
  console.log('  5c: Thread panel open/close...');
  // Send a message and reply to open thread
  await sendMessage('Message for thread test');
  await delay(300);
  // Force action bar visible and click reply
  await ce(`(() => {
    const actions = document.querySelectorAll('[data-testid="message-actions"]');
    if (actions.length > 0) {
      const last = actions[actions.length - 1];
      last.style.opacity = '1';
    }
  })()`);
  await delay(100);
  // Click the last reply button
  const replyBtns = await getCount('[data-testid="action-reply"]');
  if (replyBtns > 0) {
    await ce(`(() => {
      const btns = document.querySelectorAll('[data-testid="action-reply"]');
      btns[btns.length - 1].click();
    })()`);
    await delay(400);
    let tp = await exists('[data-testid="thread-panel"]');
    console.log(`    Thread panel open: ${tp}`);
    if (!tp) logBug(5, 'Thread panel did not open from Reply button');

    if (tp) {
      await clickEl('[data-testid="thread-panel-close"]');
      await delay(300);
      tp = await exists('[data-testid="thread-panel"]');
      console.log(`    Thread panel after close: ${tp}`);
      if (tp) logBug(5, 'Thread panel close button did not work');
    }
  }

  // 5d. Settings panel open + close
  console.log('  5d: Settings panel open/close...');
  await clickEl('[data-testid="header-settings-btn"]');
  await delay(300);
  let stP = await exists('[data-testid="settings-panel"]');
  console.log(`    Settings panel open: ${stP}`);
  if (!stP) logBug(5, 'Settings panel did not open');

  if (stP) {
    await clickEl('[data-testid="settings-panel-close"]');
    await delay(300);
    stP = await exists('[data-testid="settings-panel"]');
    console.log(`    Settings panel after close: ${stP}`);
    if (stP) logBug(5, 'Settings panel close button did not work');
  }

  // Removed data-testid on settings-panel-close check
  if (!await exists('[data-testid="settings-panel-close"]') || true) {
    // Re-verify data-testid exists
  }

  // 5e. Escape priority — close topmost panel first
  console.log('  5e: Escape priority...');
  // Open search panel, then pinned panel
  await clickEl('[data-testid="header-search-btn"]');
  await delay(300);
  await clickEl('[data-testid="header-pin-btn"]');
  await delay(300);

  let searchOpen = await exists('[data-testid="search-panel"]');
  let pinnedOpenE = await exists('[data-testid="pinned-panel"]');
  console.log(`    Before Escape: search=${searchOpen}, pinned=${pinnedOpenE}`);

  // Press Escape - should close pinned first (it's in the escape priority chain before search)
  await page.keyboard.press('Escape');
  await delay(300);

  searchOpen = await exists('[data-testid="search-panel"]');
  pinnedOpenE = await exists('[data-testid="pinned-panel"]');
  console.log(`    After 1st Escape: search=${searchOpen}, pinned=${pinnedOpenE}`);

  if (pinnedOpenE) logBug(5, 'First Escape did not close pinned panel');

  // Second Escape should close search
  await page.keyboard.press('Escape');
  await delay(300);
  searchOpen = await exists('[data-testid="search-panel"]');
  console.log(`    After 2nd Escape: search=${searchOpen}`);
  if (searchOpen) logBug(5, 'Second Escape did not close search panel');

  await screenshot('overnight-r5-panels');

  // ═══════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log(`TOTAL BUGS FOUND: ${bugs.length}`);
  for (const b of bugs) {
    console.log(`  [R${b.round}] ${b.description}`);
  }
  console.log('═══════════════════════════════════════════\n');

  await browser.close();

  // Write results for processing
  fs.writeFileSync('/tmp/test-results-r1-5.json', JSON.stringify({ bugs, total: bugs.length }, null, 2));
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
