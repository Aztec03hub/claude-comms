/**
 * csp-violations.spec.js — guard against the v0.2.0-v0.2.2 CSP bug where
 * the web UI loaded via http://localhost:9921 would have its broker
 * WebSocket (`ws://localhost:9001`) blocked because the daemon's CSP
 * only listed `ws://127.0.0.1:9001`. Banner stayed on
 * "Reconnecting to broker..." indefinitely.
 *
 * This test asserts:
 *   1. The Content-Security-Policy response header is present
 *      (NOT a <meta> tag — meta CSPs can't be parameterized per-deployment).
 *   2. The header contains BOTH `ws://localhost:9001` AND `ws://127.0.0.1:9001`.
 *   3. The header contains BOTH `http://localhost:9920` AND `http://127.0.0.1:9920`.
 *   4. No CSP violations fire on the console during normal page load.
 *
 * Runs against the live daemon at http://127.0.0.1:9921 — the same one the
 * other e2e tests target. If the daemon isn't running, the test errors out
 * with a useful message rather than hanging.
 */

import { test, expect } from '@playwright/test';

const DAEMON_BASE = 'http://127.0.0.1:9921';

// A console message is a CSP violation if it matches any of these. Keep
// strict — over-narrow patterns would let a real regression slip through.
const CSP_VIOLATION_MARKERS = [
  'Refused to connect',
  'Refused to load',
  'Refused to execute',
  'Content Security Policy',
  'violates the following Content Security Policy directive',
];

function isCspViolation(text) {
  return CSP_VIOLATION_MARKERS.some(p => text.includes(p));
}

test.describe('CSP regression guards', () => {
  test('CSP header includes both localhost and 127.0.0.1 broker/REST origins', async ({ request }) => {
    const res = await request.get(DAEMON_BASE + '/');
    expect(res.status()).toBe(200);

    const csp = res.headers()['content-security-policy'];
    expect(csp, 'Content-Security-Policy header must be set').toBeTruthy();

    // The bug: 0.2.0-0.2.2 only had ws://127.0.0.1:9001
    expect(csp).toContain('ws://localhost:9001');
    expect(csp).toContain('ws://127.0.0.1:9001');
    expect(csp).toContain('http://localhost:9920');
    expect(csp).toContain('http://127.0.0.1:9920');

    // Hardening — verify what should NOT be there.
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain('script-src *');
    expect(csp).not.toContain('connect-src *');
    expect(csp).not.toContain('default-src *');
  });

  test('CSP is delivered as a header, not a <meta> tag', async ({ request }) => {
    const res = await request.get(DAEMON_BASE + '/');
    const body = await res.text();
    // Meta CSPs get baked into the static bundle at build time and can't
    // be parameterized per-deployment. Reject them in source HTML.
    expect(body).not.toMatch(/<meta[^>]+http-equiv=["']Content-Security-Policy/i);
  });

  test('No CSP violations fire on page load', async ({ page }) => {
    const violations = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && isCspViolation(msg.text())) {
        violations.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      if (isCspViolation(err.message)) violations.push(err.message);
    });

    await page.goto(DAEMON_BASE + '/', { waitUntil: 'domcontentloaded' });
    // Wait for the MQTT client to attempt its first connection. The
    // pre-fix bug would surface here as a CSP violation on the
    // `new WebSocket(ws://localhost:9001/mqtt)` call.
    await page.waitForTimeout(3000);

    expect(
      violations,
      `Got ${violations.length} CSP violation(s):\n` + violations.join('\n'),
    ).toEqual([]);
  });
});
