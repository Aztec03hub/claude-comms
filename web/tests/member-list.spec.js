// MemberList M-FIX (v0.3.3): all-three-sections-always-render spec.
//
// Phil's hard constraint: the three section headers (Active /
// Online elsewhere / Offline) are stable UI surfaces. Their existence
// must never depend on row count. Even when totally empty, each
// header + chevron + count must render, and the body region must
// surface a one-line muted empty-state placeholder.
//
// Step 1.6 of the v0.3.3 release plan
// (.worklogs/architecture-and-orchestration-plan.md Part II §II.4).
//
// Mounted-component approach via @testing-library/svelte, mirroring
// composer-backtick.spec.js. The component reads localStorage at
// mount time, so each test scrubs the new + legacy keys in beforeEach.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import MemberList from '../src/components/MemberList.svelte';

const ACTIVE_KEY = 'claude-comms.memberListActiveExpanded';
const ONLINE_ELSEWHERE_KEY = 'claude-comms.memberListOnlineElsewhereExpanded';
const OFFLINE_KEY = 'claude-comms.memberListOfflineExpanded';
const LEGACY_OFFLINE_KEY = 'claude-comms.offlineExpanded';

function clearAllStorageKeys() {
  localStorage.removeItem(ACTIVE_KEY);
  localStorage.removeItem(ONLINE_ELSEWHERE_KEY);
  localStorage.removeItem(OFFLINE_KEY);
  localStorage.removeItem(LEGACY_OFFLINE_KEY);
}

/** Build a synthetic online member with a single web connection. */
function makeMember(key, name, type = 'agent') {
  return {
    key,
    name,
    type,
    connections: { [`${key}-web-1`]: { client: 'web' } },
  };
}

function defaultProps(overrides = {}) {
  return {
    active: [],
    onlineElsewhere: [],
    offline: [],
    activeChannelName: 'general',
    getMemberConversations: () => [],
    typingUsers: {},
    onShowProfile: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  clearAllStorageKeys();
});

afterEach(() => {
  cleanup();
  clearAllStorageKeys();
});

describe('MemberList — M-FIX always-three-sections', () => {
  it('renders all three section headers with count badges when state is empty', () => {
    const { getByTestId } = render(MemberList, defaultProps());

    // All three section header buttons present, regardless of row counts.
    expect(getByTestId('members-active-section')).toBeTruthy();
    expect(getByTestId('members-online-elsewhere-section')).toBeTruthy();
    expect(getByTestId('members-offline-section')).toBeTruthy();

    // All three count badges show "0".
    expect(getByTestId('members-active-count').textContent.trim()).toBe('0');
    expect(getByTestId('members-online-elsewhere-count').textContent.trim()).toBe('0');
    expect(getByTestId('members-offline-count').textContent.trim()).toBe('0');
  });

  it('renders inline empty-state placeholders for every empty section (active + online elsewhere expanded by default)', () => {
    const { getByTestId } = render(MemberList, defaultProps());

    // Active + Online elsewhere default-expanded → empty-state visible.
    expect(getByTestId('members-active-empty').textContent).toContain(
      'No one is here yet',
    );
    expect(getByTestId('members-online-elsewhere-empty').textContent).toContain(
      'No one is online elsewhere',
    );
    // Offline default-collapsed → body absent, but the header still shows.
    expect(() => getByTestId('members-offline-body')).toThrow();
  });

  it('Offline empty-state renders when section is expanded', async () => {
    localStorage.setItem(OFFLINE_KEY, '1');
    const { getByTestId } = render(MemberList, defaultProps());
    expect(getByTestId('members-offline-empty').textContent).toContain(
      'No one offline yet',
    );
  });

  it('count badges reflect array sizes when rows are present', () => {
    const props = defaultProps({
      active: [makeMember('a1', 'alpha'), makeMember('a2', 'beta')],
      onlineElsewhere: [makeMember('o1', 'gamma')],
      offline: [
        { key: 'd1', name: 'delta', type: 'agent' },
        { key: 'd2', name: 'epsilon', type: 'agent' },
        { key: 'd3', name: 'zeta', type: 'agent' },
      ],
    });
    const { getByTestId } = render(MemberList, props);

    expect(getByTestId('members-active-count').textContent.trim()).toBe('2');
    expect(getByTestId('members-online-elsewhere-count').textContent.trim()).toBe('1');
    expect(getByTestId('members-offline-count').textContent.trim()).toBe('3');
  });

  it('chevron toggles aria-expanded and persists collapse state to localStorage (Active section)', async () => {
    const { getByTestId } = render(MemberList, defaultProps());
    const btn = getByTestId('members-active-section');

    // Default: expanded (true) → empty-state body present.
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('members-active-empty')).toBeTruthy();

    // Click → collapsed → body region removed.
    await fireEvent.click(btn);
    await tick();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(() => getByTestId('members-active-body')).toThrow();
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('0');

    // Click again → re-expand → body returns.
    await fireEvent.click(btn);
    await tick();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('members-active-empty')).toBeTruthy();
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('1');
  });

  it('persists Online elsewhere + Offline collapse state independently', async () => {
    const { getByTestId } = render(MemberList, defaultProps());

    // Collapse Online elsewhere.
    await fireEvent.click(getByTestId('members-online-elsewhere-section'));
    await tick();
    expect(localStorage.getItem(ONLINE_ELSEWHERE_KEY)).toBe('0');

    // Expand Offline (defaults to collapsed).
    await fireEvent.click(getByTestId('members-offline-section'));
    await tick();
    expect(localStorage.getItem(OFFLINE_KEY)).toBe('1');

    // Active untouched → key written via mount-time effect to the default '1'.
    expect(localStorage.getItem(ACTIVE_KEY)).toBe('1');
  });

  it('rehydrates collapse state from localStorage on mount', () => {
    // Pre-seed: Active collapsed, Online elsewhere collapsed, Offline expanded.
    localStorage.setItem(ACTIVE_KEY, '0');
    localStorage.setItem(ONLINE_ELSEWHERE_KEY, '0');
    localStorage.setItem(OFFLINE_KEY, '1');

    const { getByTestId } = render(MemberList, defaultProps());

    expect(getByTestId('members-active-section').getAttribute('aria-expanded')).toBe('false');
    expect(getByTestId('members-online-elsewhere-section').getAttribute('aria-expanded')).toBe('false');
    expect(getByTestId('members-offline-section').getAttribute('aria-expanded')).toBe('true');
    // Offline body present now (expanded + empty).
    expect(getByTestId('members-offline-empty')).toBeTruthy();
  });

  it('migrates legacy claude-comms.offlineExpanded key to the namespaced key', () => {
    // Legacy v0.3.2 key set, new key absent.
    localStorage.setItem(LEGACY_OFFLINE_KEY, '1');
    expect(localStorage.getItem(OFFLINE_KEY)).toBeNull();

    const { getByTestId } = render(MemberList, defaultProps());

    // Migration runs at mount: legacy value copied to new key, legacy removed.
    expect(localStorage.getItem(OFFLINE_KEY)).toBe('1');
    expect(localStorage.getItem(LEGACY_OFFLINE_KEY)).toBeNull();
    expect(getByTestId('members-offline-section').getAttribute('aria-expanded')).toBe('true');
  });

  it('migration does not clobber a pre-existing new key', () => {
    // Both keys set; new key wins.
    localStorage.setItem(LEGACY_OFFLINE_KEY, '1');
    localStorage.setItem(OFFLINE_KEY, '0');

    render(MemberList, defaultProps());

    expect(localStorage.getItem(OFFLINE_KEY)).toBe('0');
    expect(localStorage.getItem(LEGACY_OFFLINE_KEY)).toBeNull();
  });

  it('expanded chevron carries the .expanded class for CSS rotation', async () => {
    const { getByTestId, container } = render(MemberList, defaultProps());
    const activeBtn = getByTestId('members-active-section');
    const chevron = activeBtn.querySelector('.members-section-chevron');

    // Default-expanded → .expanded class on chevron.
    expect(chevron.classList.contains('expanded')).toBe(true);

    await fireEvent.click(activeBtn);
    await tick();
    expect(chevron.classList.contains('expanded')).toBe(false);
  });

  it('uses aria-controls to link each header to its body region id', () => {
    localStorage.setItem(OFFLINE_KEY, '1'); // expand Offline so body renders
    const { getByTestId } = render(MemberList, defaultProps());

    expect(getByTestId('members-active-section').getAttribute('aria-controls')).toBe(
      'members-active-body',
    );
    expect(getByTestId('members-online-elsewhere-section').getAttribute('aria-controls')).toBe(
      'members-online-elsewhere-body',
    );
    expect(getByTestId('members-offline-section').getAttribute('aria-controls')).toBe(
      'members-offline-body',
    );

    // The bodies actually carry the matching id attrs.
    expect(getByTestId('members-active-body').id).toBe('members-active-body');
    expect(getByTestId('members-online-elsewhere-body').id).toBe(
      'members-online-elsewhere-body',
    );
    expect(getByTestId('members-offline-body').id).toBe('members-offline-body');
  });
});
