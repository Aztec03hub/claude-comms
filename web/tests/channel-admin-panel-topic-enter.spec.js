// v0.4.3 BUG-PHASE2A-2 regression suite - ChannelAdminPanel topic-input
// fires commitEditTopic TWICE on Enter (once via keydown, once via blur
// on the unmounting input), and the second fire wipes the topic.
//
// Surfaced by Phase 2 Agent A's E2E build (`.worklogs/v043-e2e-phase2a.md`
// item [VERIFY-PHASE2A-EDIT-TOPIC-DOUBLE-FIRE]).
//
// Repro sequence pre-fix:
//   1. User clicks "Edit topic" → editingTopic=true, topicDraft=channel.topic.
//   2. User types new value "Welcome to phoenix" → topicDraft updates.
//   3. User presses Enter → keydown calls commitEditTopic:
//        - editingTopic=false
//        - topicDraft=''
//        - store.setTopic(channelId, 'Welcome to phoenix') ✓ correct
//   4. Setting editingTopic=false unmounts the {#if editingTopic} input.
//   5. The unmounting input fires `blur` → onblur calls commitEditTopic
//      AGAIN:
//        - next = topicDraft = '' (already reset by step 3)
//        - editingTopic and topicDraft are no-op writes
//        - store.setTopic(channelId, '') ✗ WIPES THE TOPIC
//   6. User-visible result: topic appears briefly, then clears.
//
// FIX (this commit): guard at the top of commitEditTopic:
//   if (!editingTopic) return;
// The Enter-driven first call flips editingTopic to false BEFORE the
// blur fires, so the blur-driven second call short-circuits immediately
// without touching store.setTopic.
//
// What this suite pins (≥4 tests, P-1 + P-3 patterns):
//
//   1. Enter on the topic input fires store.setTopic EXACTLY ONCE
//      with the typed value (no empty-string overwrite).
//   2. The blur that immediately follows Enter does NOT call
//      store.setTopic a second time.
//   3. Blur alone (without Enter) still commits correctly when in
//      editing mode (commit-on-blur is a real UX path; we must not
//      break it while fixing the Enter double-fire).
//   4. Empty-string blur (i.e. blur after the input was already
//      committed) is a no-op.
//   5. (P-1 source-level regex pin) commitEditTopic's body starts
//      with `if (!editingTopic) return;` so a future refactor that
//      drops the guard gets caught at edit time.
//   6. (P-1 source-level regex pin) commitRename has the same
//      guard pattern (both inline-edit functions share the same
//      Enter+blur double-fire shape; both must be protected).
//
// Mutation-test invariants each protects:
//   - Test 1 fails if commitEditTopic is removed from the Enter path.
//   - Test 2 fails if the `if (!editingTopic) return;` guard is removed
//     (regression of BUG-PHASE2A-2).
//   - Test 3 fails if the blur path is broken / no longer commits.
//   - Test 4 fails if the guard is INVERTED (i.e. `if (editingTopic)
//     return;` would no-op the actual commit).
//   - Tests 5 + 6 fail at edit time if the guard line is removed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import ChannelAdminPanel from '../src/components/ChannelAdminPanel.svelte';

// Source-level regex pin helper (P-1). Mirrors getchannelrole-pure-bugfix
// to stay compatible with vitest's import.meta.url resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_PANEL_SRC = resolve(HERE, '..', 'src', 'components', 'ChannelAdminPanel.svelte');
const ADMIN_PANEL_SOURCE = readFileSync(ADMIN_PANEL_SRC, 'utf8');

afterEach(() => {
  cleanup();
});

function makeChannel(overrides = {}) {
  return {
    id: 'ch-1',
    name: 'general',
    topic: 'Old topic',
    mode: 'open',
    visibility: 'public',
    createdBy: 'me',
    archived: false,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    archiveChannel: vi.fn(),
    deleteChannel: vi.fn().mockResolvedValue({ success: true }),
    setTopic: overrides.setTopic ?? vi.fn().mockResolvedValue({ success: true }),
    renameChannel: overrides.renameChannel,
    setVisibility: overrides.setVisibility,
    setMode: overrides.setMode,
    transferOwnership: overrides.transferOwnership,
  };
}

function makeProps(overrides = {}) {
  return {
    channel: overrides.channel ?? makeChannel(),
    currentChannelRole: 'currentChannelRole' in overrides ? overrides.currentChannelRole : 'owner',
    store: overrides.store ?? makeStore(),
    onConfirmDestructive: overrides.onConfirmDestructive ?? vi.fn().mockResolvedValue(true),
    onClose: overrides.onClose ?? vi.fn(),
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

async function openTopicEditor(getByTestId) {
  await fireEvent.click(getByTestId('channel-admin-action-edit-topic'));
  await flush();
}

describe('ChannelAdminPanel: BUG-PHASE2A-2 topic Enter double-fire (v0.4.3)', () => {
  it('Enter on the topic input fires store.setTopic EXACTLY ONCE with the typed value (no empty-string overwrite)', async () => {
    const setTopic = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ setTopic });
    const props = makeProps({ store });
    const { getByTestId } = render(ChannelAdminPanel, { props });

    await openTopicEditor(getByTestId);

    const input = getByTestId('channel-admin-topic-input');
    expect(input).not.toBeNull();

    // User types a new topic.
    await fireEvent.input(input, { target: { value: 'Welcome to phoenix' } });
    await flush();

    // User presses Enter. The keydown handler commits the value.
    // Simulating Enter on a real input naturally also unmounts the
    // input (editingTopic flips false), which would fire blur on the
    // unmounting input in a real browser. We model that explicitly
    // below in test 2 with an explicit fireEvent.blur after Enter.
    await fireEvent.keyDown(input, { key: 'Enter' });
    await flush();

    // Exactly one call, with the typed value (NOT '').
    expect(setTopic).toHaveBeenCalledTimes(1);
    expect(setTopic).toHaveBeenCalledWith('ch-1', 'Welcome to phoenix');
  });

  it('Enter then blur (the real-browser sequence) still fires store.setTopic exactly once and with the correct value (the guard short-circuits the blur)', async () => {
    const setTopic = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ setTopic });
    const props = makeProps({ store });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });

    await openTopicEditor(getByTestId);
    const input = getByTestId('channel-admin-topic-input');

    await fireEvent.input(input, { target: { value: 'Welcome to phoenix' } });
    await flush();

    // Real browser path: Enter fires keydown, then because editingTopic
    // flips false the input unmounts, which fires blur on the way out.
    // Simulate explicitly: keydown Enter, then fire blur on the same
    // node (which is what bits-ui's blur-during-unmount path looks like).
    await fireEvent.keyDown(input, { key: 'Enter' });
    // Even though editingTopic is now false, the input element still
    // exists in the test until Svelte's next microtask flush; fire blur
    // BEFORE flush() to model the in-flight unmount blur.
    await fireEvent.blur(input);
    await flush();

    // The guard MUST short-circuit the blur. Exactly ONE setTopic call,
    // with the typed value (NOT an empty-string overwrite that would
    // wipe the topic per BUG-PHASE2A-2).
    expect(setTopic).toHaveBeenCalledTimes(1);
    expect(setTopic).toHaveBeenCalledWith('ch-1', 'Welcome to phoenix');
    // The empty-string call that would wipe the topic must NEVER happen.
    expect(setTopic).not.toHaveBeenCalledWith('ch-1', '');
    // Input is unmounted post-commit.
    expect(queryByTestId('channel-admin-topic-input')).toBeNull();
  });

  it('Blur alone (commit-on-blur, no Enter) still commits the typed value when editing - guard must not break the blur-commit UX path', async () => {
    const setTopic = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ setTopic });
    const props = makeProps({ store });
    const { getByTestId } = render(ChannelAdminPanel, { props });

    await openTopicEditor(getByTestId);
    const input = getByTestId('channel-admin-topic-input');

    await fireEvent.input(input, { target: { value: 'New topic from blur' } });
    await flush();

    // User clicks away (blur with no preceding Enter). This is a real
    // UX path: Tab-away, click-outside, focus another field.
    await fireEvent.blur(input);
    await flush();

    expect(setTopic).toHaveBeenCalledTimes(1);
    expect(setTopic).toHaveBeenCalledWith('ch-1', 'New topic from blur');
  });

  it('Direct subsequent invocation of the topic editor: open → blur with NO changes → reopen → still works (no stale-state lock)', async () => {
    // Tests that the guard logic doesn't leave editingTopic stuck false
    // such that subsequent edits never commit. This is the inverse
    // regression: the fix is `if (!editingTopic) return;` - a buggy
    // re-implementation as `if (editingTopic) return;` would lock the
    // function permanently. This test catches that inversion.
    const setTopic = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ setTopic });
    const props = makeProps({ store, channel: makeChannel({ topic: 'Original' }) });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });

    // Round 1: open editor, blur without changes - must close cleanly.
    await openTopicEditor(getByTestId);
    let input = getByTestId('channel-admin-topic-input');
    await fireEvent.blur(input);
    await flush();
    expect(queryByTestId('channel-admin-topic-input')).toBeNull();
    // No setTopic call: value unchanged (next === channel.topic).
    expect(setTopic).not.toHaveBeenCalled();

    // Round 2: reopen, type, press Enter. Must commit the new value.
    await openTopicEditor(getByTestId);
    input = getByTestId('channel-admin-topic-input');
    await fireEvent.input(input, { target: { value: 'Updated topic' } });
    await flush();
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.blur(input);
    await flush();

    expect(setTopic).toHaveBeenCalledTimes(1);
    expect(setTopic).toHaveBeenCalledWith('ch-1', 'Updated topic');
    expect(setTopic).not.toHaveBeenCalledWith('ch-1', '');
  });

  it('Escape during edit cancels without firing store.setTopic (must not regress while we patch commit paths)', async () => {
    const setTopic = vi.fn().mockResolvedValue({ success: true });
    const store = makeStore({ setTopic });
    const props = makeProps({ store });
    const { getByTestId, queryByTestId } = render(ChannelAdminPanel, { props });

    await openTopicEditor(getByTestId);
    const input = getByTestId('channel-admin-topic-input');

    await fireEvent.input(input, { target: { value: 'Should be cancelled' } });
    await flush();

    await fireEvent.keyDown(input, { key: 'Escape' });
    await flush();
    // Escape may or may not be followed by a blur in real browsers.
    // Either way, setTopic must not fire.
    await fireEvent.blur(input);
    await flush();

    expect(setTopic).not.toHaveBeenCalled();
    expect(queryByTestId('channel-admin-topic-input')).toBeNull();
  });

  it('P-1 source pin: commitEditTopic body starts with `if (!editingTopic) return;` guard', () => {
    // Mutation-tested 2026-05-20: removing the guard line flips this
    // test red AND flips the runtime tests (2, 4) red. Dual coverage.
    const fnMatch = ADMIN_PANEL_SOURCE.match(
      /async function commitEditTopic\(\) \{[\s\S]*?\n  \}/,
    );
    expect(fnMatch).not.toBeNull();
    const body = fnMatch[0];
    expect(body).toMatch(/if \(!editingTopic\) return;/);
    // The guard must appear BEFORE any state writes / store calls,
    // otherwise the blur-after-Enter would still wipe.
    const guardIdx = body.indexOf('if (!editingTopic) return;');
    const stateWriteIdx = body.indexOf('editingTopic = false;');
    const storeCallIdx = body.indexOf('store.setTopic');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stateWriteIdx).toBeGreaterThan(guardIdx);
    expect(storeCallIdx).toBeGreaterThan(guardIdx);
  });

  it('P-1 source pin: commitRename carries the same `if (!editingName) return;` guard (same Enter+blur double-fire shape)', () => {
    // commitRename has the IDENTICAL Enter+blur wiring as commitEditTopic
    // (see ChannelAdminPanel.svelte lines wiring `onkeydown=Enter` and
    // `onblur=commitRename`). Both must carry the same guard.
    const fnMatch = ADMIN_PANEL_SOURCE.match(
      /async function commitRename\(\) \{[\s\S]*?\n  \}/,
    );
    expect(fnMatch).not.toBeNull();
    const body = fnMatch[0];
    expect(body).toMatch(/if \(!editingName\) return;/);
  });

  it('P-3 dual-coverage: topic input still wires BOTH onkeydown AND onblur to their respective commit/handler functions', () => {
    // Defends the wire shape. If someone "simplifies" by removing the
    // onblur path entirely (a tempting fix to the double-fire bug),
    // this pin catches it because the blur-commit UX is real (test 3
    // above exercises it functionally).
    expect(ADMIN_PANEL_SOURCE).toMatch(
      /onkeydown=\{handleTopicKeydown\}[^>]*onblur=\{commitEditTopic\}/,
    );
  });
});
