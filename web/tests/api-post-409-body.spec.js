// apiPost — error-body attachment (WEB-D finding #1).
//
// Regression: apiPost previously threw `Object.assign(new Error(...),
// { status })` and discarded the parsed JSON response body. The
// ArtifactPanel 409 save-conflict banner reads `err.body.latest_author`
// / `err.body.latest_version` to show WHO conflicted and at WHICH
// version; with no `.body` it always fell back to "Someone" / "v0".
//
// These tests pin that apiPost attaches the parsed error body (and that
// a non-JSON error body degrades to `body: null` rather than masking the
// real status with a parse throw).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiPost } from '../src/lib/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Build a fetch stub: any /api/web-token request mints a token (apiPost
 * awaits ensureToken first); every other request returns `postResponse`.
 */
function stubFetch(postResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (String(url).includes('/api/web-token')) {
        return { ok: true, status: 200, json: async () => ({ token: 'tok-1' }) };
      }
      return postResponse;
    }),
  );
}

describe('apiPost — 409 conflict body attachment', () => {
  it('attaches the parsed JSON error body (latest_author / latest_version) on a 409', async () => {
    stubFetch({
      ok: false,
      status: 409,
      json: async () => ({ latest_author: 'Bob', latest_version: 7 }),
    });

    await expect(
      apiPost('/api/artifacts/general/plan', { content: 'x', base_version: 6 }),
    ).rejects.toMatchObject({
      status: 409,
      body: { latest_author: 'Bob', latest_version: 7 },
    });
  });

  it('degrades to body: null when the error response is not JSON (status still attached)', async () => {
    stubFetch({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    const err = await apiPost('/api/artifacts/general/plan', { content: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
    expect(err.body).toBeNull();
  });
});
