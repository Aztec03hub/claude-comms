// Page-relative API base derivation (single-origin, Phase 3).
//
// The SPA is now served ONLY from the web port, and the REST/MCP API (/api,
// /mcp) is co-mounted on that SAME origin (Phase 1). So the normal case is
// always same-origin (''): apiGet/apiPost/mcpCall hit page-relative /api + /mcp.
// The old 9921→9920 cross-port heuristic is gone.
//
// The `<meta name="claude-comms-api-base">` override is KEPT but honored only
// when its hostname matches the page hostname — back-compat for an operator who
// still pins `web.api_base`. A mismatched meta (the desktop-on-localhost case)
// is ignored to avoid the Tailscale-IP hairpin (ERR_CONNECTION_TIMED_OUT).
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

describe('deriveApiBase — same-origin (no meta)', () => {
  it('desktop localhost:9921 → same-origin ()', () => {
    setLocation({ hostname: 'localhost', port: '9921' });
    expect(deriveApiBase()).toBe('');
  });

  it('tailscale host:9921 → same-origin ()', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '9921' });
    expect(deriveApiBase()).toBe('');
  });

  it('https page on 9921 → same-origin ()', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '9921', protocol: 'https:' });
    expect(deriveApiBase()).toBe('');
  });

  it('vite dev ports → same-origin (vite proxies /api)', () => {
    setLocation({ hostname: 'localhost', port: '5173' });
    expect(deriveApiBase()).toBe('');
    setLocation({ hostname: 'localhost', port: '5174' });
    expect(deriveApiBase()).toBe('');
  });

  it('reverse-proxy origin (443, no port) → same-origin ()', () => {
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

  it('meta host != page host (desktop hairpin) → IGNORED, same-origin wins', () => {
    setLocation({ hostname: 'localhost', port: '9921' });
    setMeta('http://phil-desktop.tail.ts.net:9920');
    expect(deriveApiBase()).toBe('');
  });

  it('malformed meta content → ignored, same-origin wins', () => {
    setLocation({ hostname: 'localhost', port: '9921' });
    setMeta('not a url');
    expect(deriveApiBase()).toBe('');
  });

  it('meta trailing slash is stripped when honored', () => {
    setLocation({ hostname: 'box.tail.ts.net', port: '9921', protocol: 'https:' });
    setMeta('https://box.tail.ts.net/');
    expect(deriveApiBase()).toBe('https://box.tail.ts.net');
  });
});
