// Page-relative API base derivation.
//
// The web client must never bake an absolute REST host the current browser
// can't reach. The confirmed bug: a `<meta name="claude-comms-api-base">`
// pointing at the Tailscale name was honored even when the page was served
// from http://localhost:9921 (desktop), so /api/identity hairpinned to the
// daemon's own Tailscale IP → ERR_CONNECTION_TIMED_OUT.
//
// These tests pin deriveApiBase()'s precedence against a stubbed page origin.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { deriveApiBase } from '../src/lib/api.js';

/** Stub window.location with the given parts. */
function setLocation({ hostname, port, protocol = 'http:' }) {
  vi.stubGlobal('window', {
    ...globalThis.window,
    location: { hostname, port, protocol, href: `${protocol}//${hostname}:${port}/` },
  });
}

/** Install (or clear) the api-base meta tag in the jsdom document head. */
function setMeta(content) {
  document.querySelectorAll('meta[name="claude-comms-api-base"]').forEach((m) => m.remove());
  if (content != null) {
    const m = document.createElement('meta');
    m.setAttribute('name', 'claude-comms-api-base');
    m.setAttribute('content', content);
    document.head.appendChild(m);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  setMeta(null);
});

describe('deriveApiBase — page-relative (no meta)', () => {
  it('desktop localhost:9921 → cross-port localhost:9920', () => {
    setLocation({ hostname: 'localhost', port: '9921' });
    expect(deriveApiBase()).toBe('http://localhost:9920');
  });

  it('tailscale host:9921 → cross-port same host:9920', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '9921' });
    expect(deriveApiBase()).toBe('http://box.tail.ts.net:9920');
  });

  it('https page on 9921 keeps the https scheme', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '9921', protocol: 'https:' });
    expect(deriveApiBase()).toBe('https://box.tail.ts.net:9920');
  });

  it('vite dev ports → same-origin', () => {
    setLocation({ hostname: 'localhost', port: '5173' });
    expect(deriveApiBase()).toBe('');
    setLocation({ hostname: 'localhost', port: '5174' });
    expect(deriveApiBase()).toBe('');
  });

  it('reverse-proxy origin (443, no port heuristic) → same-origin', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '', protocol: 'https:' });
    expect(deriveApiBase()).toBe('');
  });
});

describe('deriveApiBase — meta override honored only when host matches', () => {
  it('meta host == page host → honored (canonical origin for this host)', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '9921', protocol: 'https:' });
    setMeta('https://box.tail.ts.net');
    expect(deriveApiBase()).toBe('https://box.tail.ts.net');
  });

  it('meta host != page host (desktop hairpin) → IGNORED, page-relative wins', () => {
    setLocation({ hostname: 'localhost', port: '9921' });
    setMeta('http://phil-desktop.tail.ts.net:9920');
    expect(deriveApiBase()).toBe('http://localhost:9920');
  });

  it('malformed meta content → ignored, page-relative wins', () => {
    setLocation({ hostname: 'localhost', port: '9921' });
    setMeta('not a url');
    expect(deriveApiBase()).toBe('http://localhost:9920');
  });

  it('meta trailing slash is stripped when honored', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '9921', protocol: 'https:' });
    setMeta('https://box.tail.ts.net/');
    expect(deriveApiBase()).toBe('https://box.tail.ts.net');
  });
});
