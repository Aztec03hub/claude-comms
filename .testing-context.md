# Testing Context -- Claude Comms Web Client

**Last Updated:** 2026-03-29

---

## 1. Known Infrastructure Issues

### Issue A: mqtt.js Event Loop Blocking

**Problem:** The mqtt.js library's WebSocket reconnection cycle (every ~3s) blocks the browser event loop, causing Playwright's `page.click()`, `page.fill()`, and `page.evaluate()` to hang indefinitely.

**Workaround -- WebSocket Mock via `addInitScript`:**

```javascript
// Add BEFORE page.goto() to prevent MQTT from actually connecting
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
```

**Workaround -- CDP `Runtime.evaluate` (bypasses actionability waits):**

```javascript
// Set up CDP session for fast DOM evaluation
const cdp = await page.context().newCDPSession(page);

async function ce(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('CDP eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

// Send a message without Playwright locators
async function sendMessage(text) {
  await ce(`(() => {
    const i = document.querySelector('[data-testid="message-input"]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(i, ${JSON.stringify(text)});
    i.dispatchEvent(new Event('input', {bubbles:true}));
    i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  })()`);
  await delay(500);
}

// Click an element without Playwright locators
async function clickEl(sel) {
  await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
  await delay(300);
}
```

### Issue B: WSL2 Slow Page Loads

**Problem:** Vite dev server under WSL2 has intermittent slow page loads (10-40s), causing `waitForSelector` timeouts. Multiple concurrent Vite servers make this worse.

**Workaround -- Timeout Settings:**

```javascript
// playwright.config.js
export default defineConfig({
  timeout: 60000,            // 60s per test
  retries: 2,                // retry flaky tests
  use: {
    navigationTimeout: 30000, // 30s for page.goto()
  },
  webServer: {
    timeout: 30000,           // 30s for vite startup
  },
});

// Per-test override for especially slow tests
test.setTimeout(300000); // 5 minutes
```

**Also:** Use `waitUntil: 'domcontentloaded'` instead of default `'load'` for faster navigation:
```javascript
await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
```

### Issue C: Phantom Participant Accumulation

**Problem:** Every page load generates a new unique key via `generateKey()` and publishes a retained presence message to the MQTT broker. These are never cleaned up. Over time, participant count can grow to 1000+ entries, causing slow rendering and test timeouts.

**Root Cause:** `generateKey()` creates a new random key each session. Each browser tab/reload creates a new "phantom" participant persisted as a retained MQTT message.

**Workaround (testing):** Use the WebSocket mock (Issue A) to prevent MQTT connections entirely during tests. The local echo feature means messages still work without a broker.

**Recommended Permanent Fix:**
1. Store a deterministic user key in `localStorage`
2. Add TTL/expiry to presence messages
3. Periodically clean stale participants (> 24h)
4. Virtualize the member list DOM

### Issue D: Port Allocation

**Problem:** Multiple concurrent agents/dev servers fighting over ports causes failures.

**Solution:**
- Agents get ports 6001-6010 (one port per agent)
- The main Playwright config uses port 5175
- Use `reuseExistingServer: true` in webServer config
- For manual testing, ports 5173, 5175, 5176 have been used

```javascript
// playwright.config.js
webServer: {
  command: 'npx vite --port 5175',
  port: 5175,
  reuseExistingServer: true,
  timeout: 30000,
},
```

### Issue E: Google Fonts Blocking Screenshots

**Problem:** Google Fonts loading causes `page.screenshot()` to hang indefinitely in headless mode.

**Workaround:**
```javascript
await page.route('**/fonts.googleapis.com/**', route => route.abort());
await page.route('**/fonts.gstatic.com/**', route => route.abort());
```

### Issue F: CSS Animations Blocking CDP Screenshots

**Problem:** Infinite CSS animations (`brandBreath`, `badgePulse`, `connPulse`) cause `page.screenshot()` to hang.

**Workaround -- Use CDP screenshot instead:**
```javascript
const cdpSession = await page.context().newCDPSession(page);
const { data } = await cdpSession.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('screenshot.png', Buffer.from(data, 'base64'));
```

### Issue G: Synthetic contextmenu Events

**Problem:** `element.dispatchEvent(new MouseEvent('contextmenu'))` is NOT captured by Svelte's `oncontextmenu` handler. Only real browser right-clicks work.

**Workaround:** Use Playwright's native `page.click({ button: 'right' })`:
```javascript
await page.locator('.bubble').first().click({ button: 'right' });
```

### Issue H: MQTT Toast Notifications Intercepting Clicks

**Problem:** MQTT reconnection cycles generate toast notifications that overlay and intercept Playwright clicks.

**Workaround:** Use `page.evaluate(el => el.click())` instead of Playwright locator clicks, or use the WebSocket mock from Issue A.

---

## 2. data-testid Inventory

### Static IDs

| data-testid | Component | Element |
|---|---|---|
| `sidebar` | Sidebar.svelte | `<aside>` root |
| `sidebar-search` | Sidebar.svelte | Search input |
| `sidebar-starred-section` | Sidebar.svelte | Starred section label |
| `sidebar-starred-toggle` | Sidebar.svelte | Starred collapse button |
| `sidebar-conversations-section` | Sidebar.svelte | Conversations section label |
| `sidebar-conversations-toggle` | Sidebar.svelte | Conversations collapse button |
| `sidebar-create-channel` | Sidebar.svelte | "New Conversation" button |
| `sidebar-user-profile` | Sidebar.svelte | User profile area |
| `chat-header` | App.svelte | Chat header bar |
| `header-channel-name` | App.svelte | Channel name in header |
| `header-members-count` | App.svelte | Members count button |
| `header-search-btn` | App.svelte | Search toggle button |
| `header-pin-btn` | App.svelte | Pinned messages toggle button |
| `header-settings-btn` | App.svelte | Settings button (no handler) |
| `theme-toggle` | ThemeToggle.svelte | Theme toggle button |
| `chat-view` | ChatView.svelte | Messages container |
| `message-input` | MessageInput.svelte | Main text input |
| `send-button` | MessageInput.svelte | Send message button |
| `input-attach` | MessageInput.svelte | Attach file button |
| `input-emoji` | MessageInput.svelte | Emoji picker toggle button |
| `typing-indicator` | MessageInput.svelte | Typing indicator bar |
| `message-actions` | MessageActions.svelte | Action bar container |
| `action-reply` | MessageActions.svelte | Reply button |
| `action-react` | MessageActions.svelte | React button |
| `action-more` | MessageActions.svelte | More button (no handler) |
| `scroll-to-bottom` | ScrollToBottom.svelte | Scroll-to-bottom FAB |
| `channel-modal` | ChannelModal.svelte | Modal overlay |
| `channel-modal-close` | ChannelModal.svelte | Close (X) button |
| `channel-modal-name-input` | ChannelModal.svelte | Channel name input |
| `channel-modal-description` | ChannelModal.svelte | Description textarea |
| `channel-modal-private-toggle` | ChannelModal.svelte | Private toggle switch |
| `channel-modal-cancel` | ChannelModal.svelte | Cancel button |
| `channel-modal-create` | ChannelModal.svelte | Create button |
| `emoji-picker` | EmojiPicker.svelte | Picker container |
| `emoji-search` | EmojiPicker.svelte | Emoji search input |
| `emoji-item` | EmojiPicker.svelte | Individual emoji button (shared ID!) |
| `context-menu` | ContextMenu.svelte | Context menu container |
| `ctx-reply` | ContextMenu.svelte | Reply item |
| `ctx-forward` | ContextMenu.svelte | Forward item |
| `ctx-pin` | ContextMenu.svelte | Pin item |
| `ctx-copy` | ContextMenu.svelte | Copy item |
| `ctx-react` | ContextMenu.svelte | React item |
| `ctx-unread` | ContextMenu.svelte | Mark unread item |
| `ctx-delete` | ContextMenu.svelte | Delete item |
| `profile-card` | ProfileCard.svelte | Card container |
| `profile-card-close` | ProfileCard.svelte | Backdrop (click to close) |
| `profile-card-name` | ProfileCard.svelte | Name display |
| `search-panel` | SearchPanel.svelte | Panel container |
| `search-panel-close` | SearchPanel.svelte | Close button |
| `search-panel-input` | SearchPanel.svelte | Search input |
| `pinned-panel` | PinnedPanel.svelte | Panel container |
| `pinned-panel-close` | PinnedPanel.svelte | Close button |
| `thread-panel` | ThreadPanel.svelte | Panel container |
| `thread-panel-close` | ThreadPanel.svelte | Close button |
| `thread-reply-input` | ThreadPanel.svelte | Reply text input |
| `thread-send` | ThreadPanel.svelte | Send reply button |
| `toast` | NotificationToast.svelte | Toast container |
| `toast-close` | NotificationToast.svelte | Dismiss button |
| `connection-status` | ConnectionStatus.svelte | Status banner |
| `member-list` | MemberList.svelte | `<aside>` root |
| `members-online-section` | MemberList.svelte | Online section header |
| `members-offline-section` | MemberList.svelte | Offline section header |
| `date-separator` | DateSeparator.svelte | Date separator row |
| `avatar` | Avatar.svelte | Avatar circle (both variants) |

### Dynamic IDs

| Pattern | Component | Resolves To |
|---|---|---|
| `channel-item-{channel.id}` | Sidebar.svelte | e.g. `channel-item-general` |
| `starred-channel-item-{channel.id}` | Sidebar.svelte | e.g. `starred-channel-item-lora-training` |
| `member-{member.key}` | MemberList.svelte | e.g. `member-abc123` |
| `message-{message.id}` | MessageBubble.svelte | e.g. `message-msg_1234` |
| `message-sender-{message.sender.key}` | MessageBubble.svelte | e.g. `message-sender-abc123` |
| `emoji-category-{cat.id}` | EmojiPicker.svelte | e.g. `emoji-category-smileys` |
| `search-filter-{filter}` | SearchPanel.svelte | e.g. `search-filter-messages` |

---

## 3. Port Allocation Scheme

| Port | Assignment |
|---|---|
| 5173 | Vite default (manual dev) |
| 5175 | Playwright config default |
| 5176 | Overflow/manual testing |
| 6001-6010 | Agent-assigned (one per concurrent agent) |

---

## 4. Standard Test Template

```javascript
import { test, expect } from '@playwright/test';

test.describe('Feature Name', () => {
  test.setTimeout(60000);

  /** @type {import('playwright').CDPSession} */
  let cdp;

  test.beforeEach(async ({ page }) => {
    // Block Google Fonts to prevent screenshot/font-loading hangs
    await page.route('**/fonts.googleapis.com/**', route => route.abort());
    await page.route('**/fonts.gstatic.com/**', route => route.abort());

    // Mock MQTT WebSocket to prevent event loop blocking
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

    // Set up CDP session for fast DOM evaluation
    cdp = await page.context().newCDPSession(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Wait for app to render
    await expect(page.locator('[data-testid="message-input"]')).toBeAttached({ timeout: 30000 });
  });

  // ── Helpers ──

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function ce(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('CDP eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
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
    await delay(500);
  }

  async function clickEl(sel) {
    await ce(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    await delay(300);
  }

  async function exists(sel) {
    return ce(`!!document.querySelector(${JSON.stringify(sel)})`);
  }

  async function screenshot(page, name) {
    try {
      await page.screenshot({ path: `/home/plafayette/claude-comms/mockups/${name}.png`, timeout: 5000 });
    } catch { /* font loading may hang -- skip */ }
  }

  // ── Tests ──

  test('example test', async ({ page }) => {
    await sendMessage('Hello from test');
    const bubbleCount = await ce(`document.querySelectorAll('.bubble').length`);
    expect(bubbleCount).toBe(1);
  });
});
```

---

## 5. What's Been Tested

### Test Suites and Coverage

| Suite | File | Tests | What It Covers |
|---|---|---|---|
| App Loads | `app-loads.spec.js` | 5 | Page load, 3-column layout, header channel name, input placeholder, no console errors |
| Sidebar | `sidebar.spec.js` | 8 | Channel list, active highlight, header update, starred/conversations collapse/expand, new conversation button, search input, user profile |
| Chat | `chat.spec.js` | 6 | Input accepts text, Enter sends/clears, send button click, messages container, sent message as bubble, hover action bar (Reply/React/More) |
| Panels | `panels.spec.js` | 11 | Search open/close, pinned open/close, escape priority, search auto-focus, button toggle, chat visible with panel, channel switch with panel |
| Modals | `modals.spec.js` | 7 | Channel modal open, form fields, cancel, backdrop close, escape close, create button, toggle switch |
| Member List | `member-list.spec.js` | 6 | Sidebar visible, header count, section headers, profile card from member click, profile card contents, close on outside click |
| Context Menu | `context-menu.spec.js` | 5 | Right-click shows menu, menu items, clicking item closes, outside click closes, escape closes |
| Console Errors | `console-errors.spec.js` | 3 | Navigate all interactions without JS errors, rapid message sending, rapid channel switching |
| Emoji Picker | `emoji-picker.spec.js` | 10 | Send messages, hover action bar, React button opens picker, picker content (search/categories/grid), click emoji adds reaction + closes, input emoji button, click outside closes, escape closes, emoji search, category tab switching |
| Keyboard | `keyboard.spec.js` | 10 | Ctrl+K opens search, escape closes topmost, escape priority order, Enter sends, Shift+Enter doesn't send, tab navigation, focus ring, Enter on button, Ctrl+K while typing, focus return after escape |
| Messages | `messages.spec.js` | 10 | Type in input, Enter to send, click send, multiple message grouping, long message wrapping, @mention rendering, empty input rejection, human message alignment, timestamp format, auto-scroll |
| Channel Modal Flow | `channel-modal-flow.spec.js` | 11 | Full flow: open, fields, type name, type description, toggle private, cancel, backdrop, escape, create channel + appears in sidebar, new channel active, empty name validation |
| Test Members | `test-members.spec.js` | 11 | Member list visible, avatars, presence dots, click opens profile, profile card content, positioning, click outside closes, escape closes, different member updates card, role badges, mobile hidden |
| Theme/Responsive | `theme-responsive.spec.js` | 7 | Default dark mode, theme toggle dark/light/dark, 1920x1080, 1024x768, 768x1024, 480x800, 320x568 |
| Smoke Test | `smoke-test-all-interactions.spec.js` | 1 | All 18+ interaction types in one flow, console error monitoring |
| Channel Switching | manual script | 7 | Click each channel, active state, collapse/expand starred/conversations, channel switch with panel, search input |

| Comprehensive | `overnight-comprehensive.spec.js` | 60 | All 9 rounds: sidebar (8), header (5), input (8), messages (12), panels (6), modals (5), member list (4), theme/responsive (3), keyboard (4) |

**Total: ~180 tests across 17 files**

### Tested Interactions Summary

- Sidebar: channel click, collapse/expand sections, search focus/type, create channel button, user avatar click
- Chat: message input, Enter send, send button click, message grouping, @mentions, auto-scroll, hover action bar
- Panels: search open/close/toggle/auto-focus, pinned open/close/toggle, thread open/close
- Modals: channel modal open/close/create/validate, backdrop dismiss, escape dismiss
- Context Menu: right-click, all 7 items, close methods (item click, backdrop, escape), viewport clamping
- Emoji: picker open (from input button and React button), emoji select adds reaction, search, category tabs, close methods
- Keyboard: Ctrl+K, Escape priority chain, Enter/Shift+Enter, Tab navigation, focus ring, focus return
- Profile Card: open from member click, close methods, content display
- Theme: toggle dark/light
- Responsive: 5 viewport sizes, member list/sidebar hiding

---

## 6. What HASN'T Been Tested

**Updated 2026-03-29:** Many items previously listed as "dead" or "untested" were verified working by the overnight comprehensive test suite (`overnight-comprehensive.spec.js`).

### Buttons/Interactions with NO Test Coverage

| Component | Element | data-testid | Why Untested |
|---|---|---|---|
| ProfileCard | Message button | none | Calls `onClose` but doesn't actually send a message |
| ProfileCard | View Profile button | none | Calls `onClose` but doesn't navigate anywhere |
| SearchPanel | Filter pills (Messages/Files/Code/Links) | `search-filter-*` | Filters set state but **don't actually filter results** |
| SearchPanel | Search result click | none | Results are clickable (hover style) but **no click handler** |
| CodeBlock | Copy button | none | Works but **no test** |
| FileAttachment | Download button | none | Has hover style but **no download handler** |
| FileAttachment | Whole attachment click | none | Has cursor:pointer but **no click handler** |
| ScrollToBottom | Button click | `scroll-to-bottom` | Button works but **no dedicated test** (tested indirectly via auto-scroll) |
| NotificationToast | Toast click | `toast` | Toast renders but **no click-to-navigate handler** |
| MentionDropdown | Arrow key navigation | none | Has keyboard handler but **no test** |
| MentionDropdown | Click to select mention | none | Works but **no test** |
| ConnectionStatus | Banner display states | `connection-status` | Renders but **no test for error/connecting states** |

### Now Tested (Verified 2026-03-29 by overnight-comprehensive.spec.js)

The following were previously listed as untested but are now covered:
- `header-settings-btn` -- toggles SettingsPanel (Round 2)
- `header-members-count` -- toggles MemberList (Round 2)
- `action-more` -- opens ContextMenu (Round 4)
- Sidebar mute button -- toggles muted state (Round 1)
- Sidebar user settings button -- opens SettingsPanel (Round 1)
- MemberList search members button -- toggles search bar (has data-testid now)
- MessageInput format button -- toggles formatting help (Round 3)
- MessageInput snippet button -- inserts code template (Round 3)
- MessageInput attach file button -- opens file dialog (Round 3)
- ContextMenu Forward action -- copies body + shows toast (Round 4)
- ContextMenu Mark Unread -- marks channel unread (Round 4)
- ContextMenu Delete -- opens ConfirmDialog (Round 4)
- ReactionBar existing reaction click -- toggles via onToggleReaction (Round 4)
- ReactionBar add reaction (+) -- opens emoji picker via onAddReaction (Round 4)
- ThreadPanel send reply + input (Round 5)
- NotificationToast dismiss (Round 4, via Forward toast)
- Toast notification via Forward (Round 4)

### Untested Functional Flows

1. **@mention autocomplete** -- typing `@`, seeing dropdown, selecting a mention, mention rendering
2. **Local storage persistence** -- theme preference surviving page reload
3. **Multiple emoji reactions** -- adding multiple different reactions to one message
4. **Code block rendering** -- sending a message with triple backticks, code block display, copy button
5. **File attachment display** -- (FileAttachment component exists but no integration)
6. **Link preview display** -- (LinkPreview component exists but no integration)
7. **Member list with real participants** -- currently tested with empty list (MQTT mocked)
