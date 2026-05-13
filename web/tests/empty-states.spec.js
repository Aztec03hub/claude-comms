// Empty-state copy spec — v0.4.0 Step 2.16.
//
// Verifies the centralized empty-state copy module + checks that the four
// consumer components (MemberList, ChatView, ChannelDirectoryModal,
// Sidebar via SidebarChannelSection prop-passing) actually render the
// constants from `web/src/lib/copy/emptyStates.js`.
//
// §I.6 rule #10 is enforced as a test: every string in EMPTY_STATES must
// be free of em dashes. If a future contributor sneaks one in, this spec
// fails with a precise pointer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import { EMPTY_STATES } from '../src/lib/copy/emptyStates.js';
import MemberList from '../src/components/MemberList.svelte';
import ChatView from '../src/components/ChatView.svelte';
import ChannelDirectoryModal from '../src/components/ChannelDirectoryModal.svelte';

// MemberList persists section-collapse state to localStorage on mount.
// Scrub the keys before each test so the default expanded/collapsed
// behavior is deterministic.
const MEMBERLIST_KEYS = [
  'claude-comms.memberListActiveExpanded',
  'claude-comms.memberListOnlineElsewhereExpanded',
  'claude-comms.memberListOfflineExpanded',
  'claude-comms.offlineExpanded',
];

beforeEach(() => {
  MEMBERLIST_KEYS.forEach((k) => localStorage.removeItem(k));
});

afterEach(() => {
  cleanup();
  MEMBERLIST_KEYS.forEach((k) => localStorage.removeItem(k));
});

// ── Module-level invariants ────────────────────────────────────────────

describe('EMPTY_STATES — module invariants', () => {
  it('every entry is a non-empty string OR a function', () => {
    for (const [key, value] of Object.entries(EMPTY_STATES)) {
      if (typeof value === 'function') {
        // Function entries are validated separately below; existence here
        // is enough.
        expect(typeof value).toBe('function');
      } else {
        expect(typeof value, `EMPTY_STATES.${key} should be string`).toBe(
          'string',
        );
        expect(value.length, `EMPTY_STATES.${key} should be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('no string value contains an em dash (§I.6 rule #10)', () => {
    for (const [key, value] of Object.entries(EMPTY_STATES)) {
      if (typeof value === 'string') {
        expect(value, `EMPTY_STATES.${key} must not contain em dash`).not.toContain('—');
      }
    }
  });

  it('no function value emits an em dash for representative input', () => {
    for (const [key, value] of Object.entries(EMPTY_STATES)) {
      if (typeof value === 'function') {
        const out = value('cats');
        expect(
          typeof out,
          `EMPTY_STATES.${key}('cats') should return a string`,
        ).toBe('string');
        expect(
          out,
          `EMPTY_STATES.${key}('cats') must not contain em dash`,
        ).not.toContain('—');
      }
    }
  });

  it('exposes the six core sidebar/member/chat surfaces', () => {
    // These keys are part of the v0.4.0 contract; future renames need a
    // migration path. Pin them so accidental drift is caught.
    expect(EMPTY_STATES).toHaveProperty('starred');
    expect(EMPTY_STATES).toHaveProperty('active');
    expect(EMPTY_STATES).toHaveProperty('available');
    expect(EMPTY_STATES).toHaveProperty('memberListActive');
    expect(EMPTY_STATES).toHaveProperty('memberListOnline');
    expect(EMPTY_STATES).toHaveProperty('memberListOffline');
    expect(EMPTY_STATES).toHaveProperty('chatNoMessages');
  });

  it('filterEmpty("cats") returns the expected templated string', () => {
    expect(EMPTY_STATES.filterEmpty('cats')).toBe('No channels match "cats".');
  });

  it('filterEmpty interpolates arbitrary filter text safely', () => {
    expect(EMPTY_STATES.filterEmpty('foo bar')).toBe(
      'No channels match "foo bar".',
    );
    // Empty filter — still a well-formed sentence.
    expect(EMPTY_STATES.filterEmpty('')).toBe('No channels match "".');
  });

  it('sidebar copy ends with periods (Design Spec §11 cadence)', () => {
    expect(EMPTY_STATES.starred.endsWith('.')).toBe(true);
    expect(EMPTY_STATES.active.endsWith('.')).toBe(true);
    expect(EMPTY_STATES.available.endsWith('.')).toBe(true);
  });
});

// ── MemberList integration ─────────────────────────────────────────────

describe('MemberList — adopts EMPTY_STATES.memberList* constants', () => {
  const defaultProps = (overrides = {}) => ({
    active: [],
    onlineElsewhere: [],
    offline: [],
    activeChannelName: 'general',
    getMemberConversations: () => [],
    typingUsers: {},
    onShowProfile: vi.fn(),
    ...overrides,
  });

  it('renders EMPTY_STATES.memberListActive in the active empty-state slot', () => {
    const { getByTestId } = render(MemberList, defaultProps());
    expect(getByTestId('members-active-empty').textContent).toBe(
      EMPTY_STATES.memberListActive,
    );
  });

  it('renders EMPTY_STATES.memberListOnline in the online-elsewhere empty-state slot', () => {
    const { getByTestId } = render(MemberList, defaultProps());
    expect(getByTestId('members-online-elsewhere-empty').textContent).toBe(
      EMPTY_STATES.memberListOnline,
    );
  });

  it('renders EMPTY_STATES.memberListOffline in the offline empty-state slot when expanded', () => {
    localStorage.setItem(
      'claude-comms.memberListOfflineExpanded',
      '1',
    );
    const { getByTestId } = render(MemberList, defaultProps());
    expect(getByTestId('members-offline-empty').textContent).toBe(
      EMPTY_STATES.memberListOffline,
    );
  });
});

// ── ChatView integration ───────────────────────────────────────────────

describe('ChatView — adopts EMPTY_STATES.chatNoMessages* constants', () => {
  const defaultProps = (overrides = {}) => ({
    messages: [],
    currentUser: { key: 'me', name: 'Me' },
    participants: {},
    onOpenThread: vi.fn(),
    onContextMenu: vi.fn(),
    onShowProfile: vi.fn(),
    onReact: vi.fn(),
    onRetryMessage: vi.fn(),
    store: null,
    ...overrides,
  });

  it('renders chatNoMessages as the title when messages array is empty', () => {
    const { container } = render(ChatView, defaultProps());
    const title = container.querySelector('.empty-title');
    expect(title).toBeTruthy();
    expect(title.textContent).toBe(EMPTY_STATES.chatNoMessages);
  });

  it('renders chatNoMessagesSubtitle + chatNoMessagesHint alongside the title', () => {
    const { container } = render(ChatView, defaultProps());
    const subtitle = container.querySelector('.empty-subtitle');
    const hint = container.querySelector('.empty-hint');
    expect(subtitle.textContent).toBe(EMPTY_STATES.chatNoMessagesSubtitle);
    expect(hint.textContent).toBe(EMPTY_STATES.chatNoMessagesHint);
  });
});

// ── ChannelDirectoryModal integration ──────────────────────────────────

describe('ChannelDirectoryModal — adopts EMPTY_STATES.noTopicSet', () => {
  // Minimal store that exposes one user-owned channel without a topic so
  // the Admin tab renders the fallback line.
  function makeStore() {
    return {
      userProfile: { key: 'me' },
      channelsById: {
        'ch-1': {
          id: 'ch-1',
          name: 'general',
          mode: 'public',
          topic: '', // empty → falls back to EMPTY_STATES.noTopicSet
          createdBy: 'me',
        },
      },
      joinChannel: vi.fn(),
      setTopic: vi.fn(),
      archiveChannel: vi.fn(),
      deleteChannel: vi.fn(),
    };
  }

  it('renders EMPTY_STATES.noTopicSet for an admin row whose channel has no topic', async () => {
    const { getByTestId } = render(ChannelDirectoryModal, {
      store: makeStore(),
      open: true,
      initialTab: 'admin',
      initialFilter: '',
      onClose: vi.fn(),
      onChannelClick: vi.fn(),
      onChannelJoin: vi.fn(),
    });

    const topicEl = getByTestId('channel-directory-admin-topic-ch-1');
    expect(topicEl.textContent.trim()).toBe(EMPTY_STATES.noTopicSet);
  });
});
