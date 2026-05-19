// Tests for InviteParticipantDialog.svelte + store.inviteParticipant —
// v0.4.2 Step 3.3 (Wave F).
//
// Coverage:
//   1. Picker filter behaviour (substring, case-insensitive)
//   2. Exclude existing channel members from the picker
//   3. Exclude the caller's own key from the picker
//   4. Selecting a row + clicking Invite fires onSubmit with the
//      correct payload shape
//   5. Note field is optional (empty submit works)
//   6. Note length cap surfaces over-counter + disables Invite
//   7. Cancel button calls onCancel without firing onSubmit
//   8. store.inviteParticipant happy path: POST /api/invite called with
//      correct body, returns success
//   9. store.inviteParticipant 403 → success:false with status=403
//  10. store.inviteParticipant 404 → success:false with status=404
//  11. store.inviteParticipant 400 → success:false with status=400
//  12. store.inviteParticipant 409 (already-member) → success:false with
//      status=409
//  13. store.inviteParticipant disconnected → direct-reject (no
//      apiPost call fires, error="Not connected.")
//
// Mocks: api.js's ``apiPost`` is mocked so we can both observe call
// shape and inject HTTP-status rejections without a daemon.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import InviteParticipantDialog from '../src/components/InviteParticipantDialog.svelte';

// ── Store-test mocks ────────────────────────────────────────────────────
//
// apiPost has to be hoisted so the import below sees the mocked version.

const apiPostMock = vi.fn();
const apiGetMock = vi.fn();
const mcpCallMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: (...args) => apiGetMock(...args),
  apiPost: (...args) => apiPostMock(...args),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
  mcpCall: (...args) => mcpCallMock(...args),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

function makeStore() {
  const store = new MqttChatStore();
  store.userProfile.key = '0123abcd';
  store.userProfile.name = 'test-user';
  store.userProfile.type = 'human';
  return store;
}

beforeEach(() => {
  apiPostMock.mockReset();
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  mcpCallMock.mockResolvedValue({ success: true, payload: {} });
});

afterEach(() => {
  cleanup();
});

// ── Dialog-component helpers ────────────────────────────────────────────

function makeProps(overrides = {}) {
  return {
    channel: { id: 'general', name: 'general' },
    participants: [
      { key: 'aaaaaaaa', name: 'Alice', type: 'human' },
      { key: 'bbbbbbbb', name: 'Bob', type: 'human' },
      { key: 'cccccccc', name: 'Carol', type: 'human' },
      { key: 'dddddddd', name: 'Dave', type: 'agent' },
    ],
    existingMemberKeys: [],
    currentUserKey: 'zzzzzzzz',
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

// ── 1. Picker filter behaviour ──────────────────────────────────────────

describe('InviteParticipantDialog — picker filter', () => {
  it('filters candidates by case-insensitive name substring', async () => {
    const props = makeProps();
    const { getByTestId, queryByTestId } = render(InviteParticipantDialog, { props });
    await flush();
    expect(getByTestId('invite-dialog-row-aaaaaaaa')).toBeTruthy();
    expect(getByTestId('invite-dialog-row-bbbbbbbb')).toBeTruthy();

    const search = getByTestId('invite-dialog-search');
    await fireEvent.input(search, { target: { value: 'CA' } });
    await flush();
    expect(getByTestId('invite-dialog-row-cccccccc')).toBeTruthy();
    expect(queryByTestId('invite-dialog-row-aaaaaaaa')).toBeNull();
    expect(queryByTestId('invite-dialog-row-bbbbbbbb')).toBeNull();
  });
});

// ── 2. Exclude existing members ─────────────────────────────────────────

describe('InviteParticipantDialog — exclude rules', () => {
  it('hides participants whose key is in existingMemberKeys', () => {
    const props = makeProps({
      existingMemberKeys: ['aaaaaaaa', 'cccccccc'],
    });
    const { queryByTestId, getByTestId } = render(InviteParticipantDialog, { props });
    expect(queryByTestId('invite-dialog-row-aaaaaaaa')).toBeNull();
    expect(queryByTestId('invite-dialog-row-cccccccc')).toBeNull();
    expect(getByTestId('invite-dialog-row-bbbbbbbb')).toBeTruthy();
    expect(getByTestId('invite-dialog-row-dddddddd')).toBeTruthy();
  });

  it('hides the caller (currentUserKey) even when not in existingMemberKeys', () => {
    const props = makeProps({
      currentUserKey: 'bbbbbbbb',
      existingMemberKeys: [],
    });
    const { queryByTestId, getByTestId } = render(InviteParticipantDialog, { props });
    expect(queryByTestId('invite-dialog-row-bbbbbbbb')).toBeNull();
    expect(getByTestId('invite-dialog-row-aaaaaaaa')).toBeTruthy();
  });
});

// ── 3. Submit wiring ────────────────────────────────────────────────────

describe('InviteParticipantDialog — submit wiring', () => {
  it('clicking Invite with a selected target fires onSubmit with {inviteeKey, note}', async () => {
    const onSubmit = vi.fn();
    const props = makeProps({ onSubmit });
    const { getByTestId } = render(InviteParticipantDialog, { props });
    await flush();

    await fireEvent.click(getByTestId('invite-dialog-row-aaaaaaaa'));
    const note = getByTestId('invite-dialog-note');
    await fireEvent.input(note, { target: { value: 'welcome!' } });
    await fireEvent.click(getByTestId('invite-dialog-submit'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      inviteeKey: 'aaaaaaaa',
      note: 'welcome!',
    });
  });

  it('submitting with an empty note still fires onSubmit (note is optional)', async () => {
    const onSubmit = vi.fn();
    const props = makeProps({ onSubmit });
    const { getByTestId } = render(InviteParticipantDialog, { props });
    await flush();

    await fireEvent.click(getByTestId('invite-dialog-row-bbbbbbbb'));
    await fireEvent.click(getByTestId('invite-dialog-submit'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      inviteeKey: 'bbbbbbbb',
      note: '',
    });
  });

  it('Invite button is disabled until a target is selected', async () => {
    const props = makeProps();
    const { getByTestId } = render(InviteParticipantDialog, { props });
    await flush();
    const submit = getByTestId('invite-dialog-submit');
    expect(submit.disabled).toBe(true);

    await fireEvent.click(getByTestId('invite-dialog-row-aaaaaaaa'));
    await flush();
    expect(submit.disabled).toBe(false);
  });

  it('Cancel button calls onCancel and never invokes onSubmit', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const props = makeProps({ onSubmit, onCancel });
    const { getByTestId } = render(InviteParticipantDialog, { props });
    await flush();
    await fireEvent.click(getByTestId('invite-dialog-row-aaaaaaaa'));
    await fireEvent.click(getByTestId('invite-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ── 4. Note-length surface ──────────────────────────────────────────────

describe('InviteParticipantDialog — note length cap', () => {
  it('surfaces over-counter and disables Invite when note exceeds 200 chars', async () => {
    const props = makeProps();
    const { getByTestId } = render(InviteParticipantDialog, { props });
    await flush();
    await fireEvent.click(getByTestId('invite-dialog-row-aaaaaaaa'));

    const note = getByTestId('invite-dialog-note');
    await fireEvent.input(note, { target: { value: 'x'.repeat(201) } });
    await flush();

    const counter = getByTestId('invite-dialog-note-counter');
    expect(counter.classList.contains('over')).toBe(true);
    expect(getByTestId('invite-dialog-submit').disabled).toBe(true);
  });
});

// ── 5. store.inviteParticipant — happy path + error mapping ─────────────

describe('store.inviteParticipant — happy + error paths', () => {
  it('happy path: POSTs /api/invite with the right body and returns success', async () => {
    apiPostMock.mockResolvedValueOnce({
      invited: true,
      invitee_key: 'aaaaaaaa',
      conversation_id: 'general',
    });
    const store = makeStore();
    store.connected = true;

    const result = await store.inviteParticipant('general', 'aaaaaaaa', 'welcome');

    expect(apiPostMock).toHaveBeenCalledWith('/api/invite', {
      conversation_id: 'general',
      invitee_key: 'aaaaaaaa',
      note: 'welcome',
    });
    expect(result.success).toBe(true);
    expect(result.invited).toBe(true);
    expect(result.invitee_key).toBe('aaaaaaaa');
    expect(result.conversation_id).toBe('general');
  });

  it('omits the note field on the wire when no note is supplied', async () => {
    apiPostMock.mockResolvedValueOnce({
      invited: true,
      invitee_key: 'aaaaaaaa',
      conversation_id: 'general',
    });
    const store = makeStore();
    store.connected = true;

    await store.inviteParticipant('general', 'aaaaaaaa');

    expect(apiPostMock).toHaveBeenCalledWith('/api/invite', {
      conversation_id: 'general',
      invitee_key: 'aaaaaaaa',
    });
  });

  it('403 (forbidden) → success:false with status=403', async () => {
    const err = Object.assign(new Error('HTTP 403'), { status: 403 });
    apiPostMock.mockRejectedValueOnce(err);
    const store = makeStore();
    store.connected = true;

    const result = await store.inviteParticipant('general', 'aaaaaaaa', '');

    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
  });

  it('404 (channel not found) → success:false with status=404', async () => {
    const err = Object.assign(new Error('HTTP 404'), { status: 404 });
    apiPostMock.mockRejectedValueOnce(err);
    const store = makeStore();
    store.connected = true;

    const result = await store.inviteParticipant('ghost-channel', 'aaaaaaaa');

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
  });

  it('400 (bad request) → success:false with status=400', async () => {
    const err = Object.assign(new Error('HTTP 400'), { status: 400 });
    apiPostMock.mockRejectedValueOnce(err);
    const store = makeStore();
    store.connected = true;

    const result = await store.inviteParticipant('general', 'aaaaaaaa');

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it('409 (already a member) → success:false with status=409', async () => {
    const err = Object.assign(new Error('HTTP 409'), { status: 409 });
    apiPostMock.mockRejectedValueOnce(err);
    const store = makeStore();
    store.connected = true;

    const result = await store.inviteParticipant('general', 'aaaaaaaa');

    expect(result.success).toBe(false);
    expect(result.status).toBe(409);
  });

  it('disconnected: rejects immediately, never calls apiPost', async () => {
    const store = makeStore();
    store.connected = false;

    const result = await store.inviteParticipant('general', 'aaaaaaaa');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected.');
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('rejects on missing channel id', async () => {
    const store = makeStore();
    store.connected = true;
    const result = await store.inviteParticipant('', 'aaaaaaaa');
    expect(result.success).toBe(false);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('rejects on missing invitee key', async () => {
    const store = makeStore();
    store.connected = true;
    const result = await store.inviteParticipant('general', '');
    expect(result.success).toBe(false);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
