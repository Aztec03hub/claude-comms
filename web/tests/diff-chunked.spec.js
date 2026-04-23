// Chunked-read safety tests for `fetchFullVersion` (R2-9 fix).
//
// The helper iterates `/api/artifacts/...?offset=N` until `has_more=false`,
// assembling a full artifact-version string. Four failure modes MUST be
// bounded so a misbehaving daemon cannot hang the UI:
//
//   1. Legitimate multi-chunk assembly (happy path).
//   2. Non-advancing `next_offset` → throws immediately.
//   3. Ever-growing content → throws at MAX_TOTAL_CHARS breach.
//   4. AbortController mid-fetch → DOMException AbortError; no further calls.
//
// We stub `fetch` globally (jsdom provides a bound `fetch`) per-test so the
// helper's real `apiGet` call-site exercises the signal plumbing end-to-end.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchFullVersion,
  MAX_CHUNKS,
  MAX_TOTAL_CHARS,
} from '../src/lib/fetchFullVersion.js';

// Build a Response-like object that `apiGet` (which calls `res.json()`) can
// consume. We don't need full Response semantics — just `.ok` and `.json()`.
function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchFullVersion — chunked reads', () => {
  it('assembles a legitimate multi-chunk response', async () => {
    // Three chunks: 50K + 50K + final (small). has_more flips to false on #3.
    const c1 = 'a'.repeat(50_000);
    const c2 = 'b'.repeat(50_000);
    const c3 = 'c'.repeat(1_234);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ content: c1, has_more: true, next_offset: 50_000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: c2, has_more: true, next_offset: 100_000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: c3,
          has_more: false,
          total_chars: 101_234,
          version: 3,
        }),
      );

    const { content, meta } = await fetchFullVersion('general', 'plan.md', 3);

    expect(content).toBe(c1 + c2 + c3);
    expect(content.length).toBe(101_234);
    expect(meta.total_chars).toBe(101_234);
    expect(meta.has_more).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Verify each request used the cumulative `offset` (0, 50000, 100000).
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=50000');
    expect(urls[2]).toContain('offset=100000');
  });

  it('throws immediately on non-advancing next_offset', async () => {
    // Server bug: reports has_more=true but next_offset stays at 0.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      jsonResponse({
        content: 'x'.repeat(1000),
        has_more: true,
        next_offset: 0, // <= current offset (0) → non-advancing.
      }),
    );

    await expect(
      fetchFullVersion('general', 'plan.md', 1),
    ).rejects.toThrow(/non-advancing next_offset/);

    // Critical: exactly ONE call — we MUST NOT loop on a bad offset.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when content grows beyond MAX_TOTAL_CHARS', async () => {
    // Each chunk is 60K; helper keeps asking for more because has_more=true
    // indefinitely. Content length grows 60K, 120K, 180K, 240K → 300K which
    // breaches MAX_TOTAL_CHARS (250K). The breach fires on the 5th response
    // (5 × 60K = 300K) — verify the helper aborts via the running-total check
    // BEFORE the MAX_CHUNKS bound kicks in.
    const chunk = 'z'.repeat(60_000);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (url) => {
      const match = String(url).match(/offset=(\d+)/);
      const offset = match ? Number(match[1]) : 0;
      return jsonResponse({
        content: chunk,
        has_more: true,
        next_offset: offset + 60_000,
      });
    });

    await expect(
      fetchFullVersion('general', 'plan.md', 1),
    ).rejects.toThrow(new RegExp(`${MAX_TOTAL_CHARS} char limit`));

    // Safety: fewer than MAX_CHUNKS calls — the running-total guard fired first.
    expect(fetchSpy.mock.calls.length).toBeLessThan(MAX_CHUNKS);
  });

  it('aborts mid-fetch when AbortController signals', async () => {
    const ctrl = new AbortController();

    // First chunk resolves fine; second would resolve but we'll abort before
    // it's even requested by aborting synchronously after the first chunk
    // assembles. The helper checks signal.aborted at the TOP of each loop,
    // so iteration #2 must throw AbortError without dispatching fetch #2.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementationOnce(async () => {
      // Abort BEFORE returning, so by the time the helper starts iteration 2
      // the signal is already aborted.
      ctrl.abort();
      return jsonResponse({
        content: 'chunk1',
        has_more: true,
        next_offset: 50_000,
      });
    });

    let error;
    try {
      await fetchFullVersion('general', 'plan.md', 1, { signal: ctrl.signal });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.name).toBe('AbortError');
    // Only ONE fetch dispatched — the second iteration bailed at the
    // top-of-loop `signal.aborted` check before hitting fetch again.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates AbortSignal into the in-flight fetch call', async () => {
    // Independent of the early-abort guard: the signal itself must be passed
    // to `fetch` so an already-in-progress request is cancelled by the browser
    // abort plumbing (not just the outer loop).
    const ctrl = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ content: 'done', has_more: false, total_chars: 4 }),
    );

    await fetchFullVersion('general', 'plan.md', 1, { signal: ctrl.signal });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const opts = fetchSpy.mock.calls[0][1];
    expect(opts?.signal).toBe(ctrl.signal);
  });
});
