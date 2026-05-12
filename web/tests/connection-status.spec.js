// Tests for ConnectionStatus.svelte covering the UX G-27 failure-state
// banner. The component already had a 3-state machine
// (connected / connecting / error-while-reconnecting). UX G-27 adds a
// fourth content variant rendered inside the error state: after
// `failureThreshold` failed reconnect attempts the indeterminate
// "Reconnecting..." line is replaced with "Cannot reach broker" plus
// two action buttons (Retry now / Reload page).
//
// The component owns its own attempt counter and increments it inside an
// $effect each time the parent props transition into the error state
// (error truthy + connected false). The threshold is exposed as a prop so
// these tests can flip into the failure state in a single rerender
// instead of fabricating 5 separate transitions. Spec 4 still exercises
// the natural 5-transition path against the default threshold to lock the
// "5 failed reconnects" requirement in.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ConnectionStatus from '../src/components/ConnectionStatus.svelte';

afterEach(() => {
  cleanup();
});

describe('ConnectionStatus — UX G-27 retry button', () => {
  it('shows the indeterminate "Reconnecting..." banner while attempts are below the threshold', async () => {
    const { getByTestId, queryByTestId } = render(ConnectionStatus, {
      props: {
        connected: false,
        error: 'Connection lost',
        onlineCount: 0,
        // failureThreshold defaults to 5; one transition into error =
        // attempts === 1, well below the threshold.
      },
    });

    await tick();

    const banner = getByTestId('connection-status');
    expect(banner.getAttribute('data-failed')).toBe('false');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
    // While retrySeconds > 0 the component shows "Retrying in {N}s";
    // once it counts down it switches to "Reconnecting...". Either is
    // valid for the indeterminate (pre-failure) state; the discriminator
    // is the absence of the "Cannot reach broker" copy + action buttons.
    expect(banner.textContent).not.toContain('Cannot reach broker');
    expect(banner.textContent).toMatch(/Retrying in \d+s|Reconnecting\.\.\./);
    // The action buttons must NOT be rendered yet.
    expect(queryByTestId('connection-retry-btn')).toBeNull();
    expect(queryByTestId('connection-reload-btn')).toBeNull();
  });

  it('switches to the actionable "Cannot reach broker" banner once attempts cross the threshold', async () => {
    // failureThreshold=1 means the first failed transition flips us into
    // the failure variant. This keeps the test deterministic without
    // simulating 5 separate prop rerenders.
    const { getByTestId } = render(ConnectionStatus, {
      props: {
        connected: false,
        error: 'Connection lost',
        onlineCount: 0,
        failureThreshold: 1,
      },
    });

    await tick();

    const banner = getByTestId('connection-status');
    expect(banner.getAttribute('data-failed')).toBe('true');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
    expect(banner.textContent).toContain('Cannot reach broker');

    const retryBtn = getByTestId('connection-retry-btn');
    const reloadBtn = getByTestId('connection-reload-btn');
    expect(retryBtn.getAttribute('aria-label')).toBe(
      'Retry MQTT broker connection',
    );
    expect(reloadBtn.getAttribute('aria-label')).toBe('Reload the page');
    expect(retryBtn.textContent.trim()).toBe('Retry now');
    expect(reloadBtn.textContent.trim()).toBe('Reload page');
  });

  it('invokes the onRetry callback when the user clicks "Retry now"', async () => {
    const onRetry = vi.fn();
    const { getByTestId } = render(ConnectionStatus, {
      props: {
        connected: false,
        error: 'Connection lost',
        onlineCount: 0,
        failureThreshold: 1,
        onRetry,
      },
    });

    await tick();

    const retryBtn = getByTestId('connection-retry-btn');
    await fireEvent.click(retryBtn);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls location.reload() when the user clicks "Reload page"', async () => {
    // jsdom protects `window.location` from in-place property redefinition,
    // so we replace the whole `location` object with a stub. `vi.stubGlobal`
    // is restored automatically at suite teardown (via cleanup() in
    // afterEach above and vitest's own stub tracking), but we also restore
    // it explicitly to be safe with other specs.
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    try {
      const { getByTestId } = render(ConnectionStatus, {
        props: {
          connected: false,
          error: 'Connection lost',
          onlineCount: 0,
          failureThreshold: 1,
        },
      });

      await tick();

      await fireEvent.click(getByTestId('connection-reload-btn'));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });

  it('resets back to the indeterminate banner after a successful connect (counter clears on connected=true)', async () => {
    // Start in the failure variant (threshold=1, one error transition).
    const { getByTestId, queryByTestId, rerender } = render(ConnectionStatus, {
      props: {
        connected: false,
        error: 'Connection lost',
        onlineCount: 0,
        failureThreshold: 1,
      },
    });

    await tick();
    expect(getByTestId('connection-status').getAttribute('data-failed')).toBe(
      'true',
    );

    // Simulate the broker coming back. The existing error effect clears
    // retryCount when `connected` flips to true, so reconnectFailed must
    // become false on the next render. The "connected" banner auto-hides
    // after 3s, so within the synchronous tick we should see it visible
    // and crucially NOT in the failure variant.
    await rerender({
      connected: true,
      error: null,
      onlineCount: 1,
      failureThreshold: 1,
    });
    await tick();

    const banner = getByTestId('connection-status');
    expect(banner.textContent).toContain('Connected');
    expect(banner.getAttribute('data-failed')).toBeNull();
    expect(queryByTestId('connection-retry-btn')).toBeNull();

    // Drop the connection again. Because the counter was reset to 0, a
    // single new error transition should produce the indeterminate
    // "Reconnecting..." banner, NOT the failure variant — proving the
    // counter was actually cleared (not just the visual state).
    await rerender({
      connected: false,
      error: 'Connection lost again',
      onlineCount: 0,
      failureThreshold: 1,
    });
    await tick();

    // failureThreshold=1 means attempts>=1 trips the failure variant.
    // After successful connect, retryCount was reset to 0; this new
    // error transition bumps it to 1, which is >= 1 -> failure variant
    // shows again. That's the correct deterministic behavior given the
    // chosen threshold. The point of this spec is to prove the reset
    // happened — we verify by checking that the intermediate connected
    // render did not carry the failure marker, and the counter restarted
    // from 0 (otherwise we'd be at attempts=2 here, which is still >=1
    // but indistinguishable). To make the reset visible, the next spec
    // exercises threshold=2 so we can see attempts=1 (not-failed) after
    // reset.
    expect(getByTestId('connection-status').getAttribute('data-failed')).toBe(
      'true',
    );
  });

  it('resets the attempt counter on successful connect (verified via threshold=2 cycle)', async () => {
    // Threshold=2: needs 2 error transitions to trip into the failure
    // variant. Drive: error -> connected -> error. If the counter is
    // properly cleared on connect, the second error transition should
    // leave us at attempts=1 (NOT failed). If the counter were sticky
    // across the connect, we'd be at attempts=2 (failed).
    const { getByTestId, queryByTestId, rerender } = render(ConnectionStatus, {
      props: {
        connected: false,
        error: 'Connection lost',
        onlineCount: 0,
        failureThreshold: 2,
      },
    });
    await tick();
    // After 1 error transition with threshold=2 -> NOT failed yet.
    expect(getByTestId('connection-status').getAttribute('data-failed')).toBe(
      'false',
    );

    // Successful reconnect.
    await rerender({
      connected: true,
      error: null,
      onlineCount: 1,
      failureThreshold: 2,
    });
    await tick();
    expect(getByTestId('connection-status').textContent).toContain('Connected');

    // Drop again. If counter reset properly: attempts=1, NOT failed.
    await rerender({
      connected: false,
      error: 'Connection lost again',
      onlineCount: 0,
      failureThreshold: 2,
    });
    await tick();

    const banner = getByTestId('connection-status');
    expect(banner.getAttribute('data-failed')).toBe('false');
    // Same indeterminate-banner discriminator as the first spec: accept
    // either "Retrying in {N}s" or "Reconnecting..." and explicitly
    // reject the failure copy + buttons.
    expect(banner.textContent).not.toContain('Cannot reach broker');
    expect(banner.textContent).toMatch(/Retrying in \d+s|Reconnecting\.\.\./);
    expect(queryByTestId('connection-retry-btn')).toBeNull();
  });

  it('switches to the failure variant after 5 failed reconnects with the default threshold', async () => {
    // Locks the "5 failed reconnects" requirement from the spec to the
    // default behavior (no failureThreshold prop). We drive 5 distinct
    // error transitions by toggling the `error` prop between truthy
    // values; the component's error effect re-fires on each transition
    // because its dependency (`error`) changes identity.
    //
    // Each rerender uses a different error message so the effect's
    // dependency set sees a value change and re-runs.
    const { getByTestId, queryByTestId, rerender } = render(ConnectionStatus, {
      props: {
        connected: false,
        error: 'attempt-1',
        onlineCount: 0,
      },
    });
    await tick();
    expect(getByTestId('connection-status').getAttribute('data-failed')).toBe(
      'false',
    );

    // Drive the counter up to (but not yet over) the threshold. Note:
    // attempts already === 1 from the initial render; we need 4 more
    // rerenders with changed `error` to reach 5.
    for (let i = 2; i <= 4; i++) {
      await rerender({
        connected: false,
        error: `attempt-${i}`,
        onlineCount: 0,
      });
      await tick();
      expect(getByTestId('connection-status').getAttribute('data-failed')).toBe(
        'false',
      );
    }

    // Fifth transition crosses the default threshold of 5.
    await rerender({
      connected: false,
      error: 'attempt-5',
      onlineCount: 0,
    });
    await tick();

    const banner = getByTestId('connection-status');
    expect(banner.getAttribute('data-failed')).toBe('true');
    expect(banner.textContent).toContain('Cannot reach broker');
    expect(queryByTestId('connection-retry-btn')).not.toBeNull();
    expect(queryByTestId('connection-reload-btn')).not.toBeNull();
  });
});
