import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateUUID } from '../src/lib/utils.js';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateUUID', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a valid v4 via crypto.randomUUID when available', () => {
    expect(generateUUID()).toMatch(V4);
  });

  it('falls back to a valid v4 in an insecure context (no crypto.randomUUID)', () => {
    // Over plain HTTP on a remote host crypto.randomUUID is undefined but
    // crypto.getRandomValues still exists. This is the case that broke sending.
    vi.stubGlobal('crypto', {
      getRandomValues: (a) => {
        for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
        return a;
      },
    });
    expect(typeof crypto.randomUUID).toBe('undefined');
    expect(generateUUID()).toMatch(V4);
  });

  it('falls back even with no Web Crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(generateUUID()).toMatch(V4);
  });
});
