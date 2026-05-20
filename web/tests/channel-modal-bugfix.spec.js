// v0.4.3 BUG-PHASE2A-1 regression suite - ChannelModal Create button
// intermittently swallowed under bits-ui Dialog focus-trap.
//
// Surfaced by Phase 2 Agent A's E2E build (`.worklogs/v043-e2e-phase2a.md`
// item [VERIFY-PHASE2A-3]). In WSL2 headless Chromium under bits-ui
// Dialog's focus-trap, the Create button's onclick was intermittently
// swallowed across .click(), .click({force:true}),
// dispatchEvent('click'), and Enter-from-input - i.e. every synthetic
// click path Playwright exposes. The likely cause (per bits-ui's
// focus-trap internals) is that the trap re-focuses the closest tabbable
// when an interactive element's `disabled` flips inside the same micro-
// task as the click resolves, and the focus event preempts the click.
//
// FIX (this commit): the Create button now wires BOTH `onpointerdown`
// (primary buttons only) AND `onclick`, with a `submitting` latch so
// double-fire is impossible. pointerdown fires BEFORE the focus-trap's
// synthetic-event interception, so the create wire reliably runs.
//
// What this suite pins (≥4 tests, P-3 + P-8 patterns):
//
//   1. (P-8 pre-click state assertion) Create button is enabled,
//      visible, has data-testid='channel-modal-create' BEFORE we
//      attempt any activation. This is the load-bearing assertion
//      that proves the bug is not just "button is missing" - it
//      WAS reachable; the click was swallowed.
//   2. pointerdown (primary button) fires onCreate exactly once.
//   3. click (legacy / keyboard activation path) fires onCreate
//      exactly once when pointerdown did NOT fire (covers
//      keyboard Enter / Space activation).
//   4. pointerdown + click in the same gesture fires onCreate
//      EXACTLY ONCE (the submitting latch dedupes; this protects
//      against a regression that drops the latch).
//   5. pointerdown with a non-primary button (right-click) does
//      NOT fire onCreate.
//   6. (P-1 source-level regex pin) ChannelModal source carries
//      both onpointerdown AND onclick on the create button so a
//      future "simplification" that drops one or the other gets
//      caught at edit time.
//   7. (P-1 source-level regex pin) ChannelModal source declares
//      the `submitting` latch so a future refactor that removes
//      the dedup gets caught at edit time.
//
// Mutation-test invariants each protects:
//   - Test 1 fails if the Create button's testid is renamed.
//   - Test 2 fails if onpointerdown is removed from the Create button.
//   - Test 3 fails if onclick is removed from the Create button.
//   - Test 4 fails if the `submitting` latch is removed (double-fire).
//   - Test 5 fails if `e.button !== 0` guard is removed (right-click
//     would create a channel).
//   - Tests 6 + 7 fail at edit time if the surface shape regresses.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import ChannelModal from '../src/components/ChannelModal.svelte';

// Source-level regex pin helper (P-1). Mirrors getchannelrole-pure-bugfix
// to stay compatible with vitest's import.meta.url resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const CHANNEL_MODAL_SRC = resolve(HERE, '..', 'src', 'components', 'ChannelModal.svelte');
const CHANNEL_MODAL_SOURCE = readFileSync(CHANNEL_MODAL_SRC, 'utf8');

afterEach(() => {
  cleanup();
});

function makeProps(overrides = {}) {
  return {
    onClose: overrides.onClose ?? vi.fn(),
    onCreate: overrides.onCreate ?? vi.fn(),
  };
}

function findCreateButton() {
  return document.querySelector('[data-testid="channel-modal-create"]');
}

function findNameInput() {
  return document.querySelector('[data-testid="channel-modal-name-input"]');
}

async function fillName(value) {
  const input = findNameInput();
  expect(input).not.toBeNull();
  await fireEvent.input(input, { target: { value } });
  await tick();
}

describe('ChannelModal: BUG-PHASE2A-1 Create button activation (v0.4.3)', () => {
  it('P-8 pre-click state: Create button is mounted, visible, has the canonical testid, and is enabled after typing a valid name', async () => {
    const props = makeProps();
    render(ChannelModal, { props });
    await tick();

    await fillName('phoenix');
    const btn = findCreateButton();
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('data-testid')).toBe('channel-modal-create');
    // The button must actually be in the DOM hierarchy (bits-ui Dialog
    // renders into a portal; document.body is fine). This is the load-
    // bearing P-8 assertion: state was correct before we tried to fire.
    expect(document.body.contains(btn)).toBe(true);
  });

  it('pointerdown (primary button) fires onCreate exactly once with sanitized name + description', async () => {
    const onCreate = vi.fn();
    const props = makeProps({ onCreate });
    render(ChannelModal, { props });
    await tick();

    await fillName('phoenix');
    const btn = findCreateButton();
    expect(btn.disabled).toBe(false);

    // pointerdown with button=0 (primary) is the focus-trap bypass.
    await fireEvent.pointerDown(btn, { button: 0 });
    await tick();

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('phoenix', '');
  });

  it('click (keyboard activation path) fires onCreate exactly once when pointerdown did not fire', async () => {
    const onCreate = vi.fn();
    const props = makeProps({ onCreate });
    render(ChannelModal, { props });
    await tick();

    await fillName('phoenix');
    const btn = findCreateButton();
    expect(btn.disabled).toBe(false);

    // Use fireEvent.click directly (no preceding pointerdown). This
    // simulates Enter/Space activation on a focused button, which the
    // browser maps directly to a synthetic click without pointerdown.
    await fireEvent.click(btn);
    await tick();

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('phoenix', '');
  });

  it('pointerdown + click in the same gesture fires onCreate EXACTLY ONCE (submitting latch dedupes)', async () => {
    const onCreate = vi.fn();
    const props = makeProps({ onCreate });
    render(ChannelModal, { props });
    await tick();

    await fillName('phoenix');
    const btn = findCreateButton();
    expect(btn.disabled).toBe(false);

    // Normal mouse activation: pointerdown immediately followed by click.
    await fireEvent.pointerDown(btn, { button: 0 });
    await fireEvent.click(btn);
    await tick();

    // The submitting latch must dedupe these two paths. If it doesn't,
    // store.createChannel runs twice and the user gets two channels.
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith('phoenix', '');
  });

  it('pointerdown with a non-primary button (right-click) does NOT fire onCreate', async () => {
    const onCreate = vi.fn();
    const props = makeProps({ onCreate });
    render(ChannelModal, { props });
    await tick();

    await fillName('phoenix');
    const btn = findCreateButton();
    expect(btn.disabled).toBe(false);

    // Right-click should never create a channel. Right-click button=2.
    await fireEvent.pointerDown(btn, { button: 2 });
    await tick();

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('pointerdown is ignored when name is invalid (button disabled gate must hold)', async () => {
    const onCreate = vi.fn();
    const props = makeProps({ onCreate });
    render(ChannelModal, { props });
    await tick();

    // Empty name → button disabled, pointerdown must not fire onCreate
    // even though our handler runs before click. The handlePointerDown
    // guard `!nameIsValid` MUST hold.
    const btn = findCreateButton();
    expect(btn.disabled).toBe(true);
    await fireEvent.pointerDown(btn, { button: 0 });
    await tick();

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('P-1 source pin: Create button wires BOTH onpointerdown AND onclick (and the submitting latch is declared)', () => {
    // Single source-level regex pin that catches three regressions
    // simultaneously:
    //   (a) Removing `onpointerdown=` from the Create button.
    //   (b) Removing `onclick=` from the Create button.
    //   (c) Removing the `submitting` latch declaration.
    // Mutation-tested 2026-05-20: removing any of the three flips this
    // test red.
    expect(CHANNEL_MODAL_SOURCE).toMatch(
      /onpointerdown=\{handlePrimaryPointerDown\}[^>]*onclick=\{handleCreate\}[^>]*data-testid="channel-modal-create"/,
    );
    expect(CHANNEL_MODAL_SOURCE).toMatch(/let submitting = \$state\(false\);/);
    // Latch must be CHECKED in handleCreate (the actual dedupe site).
    expect(CHANNEL_MODAL_SOURCE).toMatch(/if \(!nameIsValid \|\| submitting\) return;/);
    // Primary-button gate must be present so right-click can't submit.
    expect(CHANNEL_MODAL_SOURCE).toMatch(/if \(e\.button !== 0\) return;/);
  });

  it('P-1 source pin: handlePrimaryPointerDown stays a pure activation handler (no state writes other than via handleCreate)', () => {
    // Mutation-test invariant: the pointerdown handler must NOT mutate
    // `submitting` directly or anywhere outside handleCreate. If a
    // future refactor inlines the latch flip into handlePrimaryPointerDown
    // (bypassing handleCreate's nameIsValid gate), this pin trips.
    const handlerMatch = CHANNEL_MODAL_SOURCE.match(
      /function handlePrimaryPointerDown\(e\) \{[\s\S]*?\n  \}/,
    );
    expect(handlerMatch).not.toBeNull();
    const body = handlerMatch[0];
    // Body must call handleCreate and not assign to submitting directly.
    expect(body).toMatch(/handleCreate\(\);/);
    expect(body).not.toMatch(/submitting\s*=/);
  });
});
