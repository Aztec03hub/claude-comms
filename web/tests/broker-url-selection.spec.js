// Robust broker-URL selection.
//
// The web client used to hardcode `ws://<page-host>:9001/mqtt`, which loops on
// "Reconnecting to broker" when the page host can't reach the broker. The daemon
// advertises its broker WebSocket coordinates via /api/capabilities, but the
// client is PAGE-ORIGIN-FIRST: it derives the broker from the host the page was
// loaded from, and only honors the advertised absolute URL when its host matches
// the page host (otherwise a localhost desktop page would hairpin onto a
// Tailscale IP — #17 regression — and be CSP-blocked). Same-origin (HTTPS proxy)
// and page-host fallbacks remain.
//
// These tests exercise the pure selection helpers without a live broker.

import { describe, it, expect } from 'vitest';
import {
  resolveBrokerUrl,
  defaultBrokerUrl,
  sameOriginBrokerUrl,
} from '../src/lib/mqtt-store.svelte.js';

// `host` mirrors window.location.host: it includes the port when a non-default
// one is present, and equals `hostname` on default ports (80/443). When a caller
// passes a bare hostname, `host` defaults to it (the no-explicit-port case).
const HTTP = (hostname, host = hostname) => ({ hostname, host, protocol: 'http:' });
const HTTPS = (hostname, host = hostname) => ({ hostname, host, protocol: 'https:' });

describe('resolveBrokerUrl — page-origin-first (advertised URL only when host matches)', () => {
  it('honors the advertised broker_ws_url when its host equals the page host', () => {
    const caps = { broker_ws_url: 'ws://host.tailnet.ts.net:9001/mqtt' };
    expect(resolveBrokerUrl(caps, HTTP('host.tailnet.ts.net')))
      .toBe('ws://host.tailnet.ts.net:9001/mqtt');
  });

  it('IGNORES an advertised Tailscale url when the page is on localhost (#17 hairpin)', () => {
    // The desktop console bug: page on localhost, daemon advertised the
    // Tailscale broker. Must derive ws://localhost:9001, NOT the Tailscale host.
    const caps = { broker_ws_url: 'ws://phil-desktop.tail16c27f6.ts.net:9001/mqtt' };
    expect(resolveBrokerUrl(caps, HTTP('localhost'))).toBe('ws://localhost:9001/mqtt');
  });

  it('IGNORES an advertised url when the page host differs (uses page host instead)', () => {
    const caps = { broker_ws_url: 'ws://canonical:9001/mqtt' };
    expect(resolveBrokerUrl(caps, HTTP('192.168.1.10'))).toBe('ws://192.168.1.10:9001/mqtt');
  });

  it('honors advertised port from caps even when ignoring the mismatched url', () => {
    const caps = { broker_ws_url: 'ws://other-host:9001/mqtt', broker_ws_port: 8001 };
    expect(resolveBrokerUrl(caps, HTTP('localhost'))).toBe('ws://localhost:8001/mqtt');
  });
});

describe('resolveBrokerUrl — same-origin (HTTPS proxy)', () => {
  it('uses wss same-origin path (no port) when page is https', () => {
    expect(resolveBrokerUrl({}, HTTPS('box.ts.net'))).toBe('wss://box.ts.net/mqtt');
  });

  it('same-origin wins over an advertised absolute url on an https page', () => {
    // tailscale-serve: page is https on the proxied origin; the broker rides
    // the same origin, so an advertised :9001 url must be ignored.
    const caps = { broker_ws_url: 'ws://phil-desktop.tail16c27f6.ts.net:9001/mqtt' };
    expect(resolveBrokerUrl(caps, HTTPS('box.ts.net'))).toBe('wss://box.ts.net/mqtt');
  });

  it('uses wss same-origin when daemon flags broker_ws_same_origin', () => {
    const caps = { broker_ws_same_origin: true };
    // http page but daemon insists on same-origin → ws same-origin path.
    expect(resolveBrokerUrl(caps, HTTP('proxy.local'))).toBe('ws://proxy.local/mqtt');
  });

  it('single-origin: broker_ws_same_origin true on http-localhost:9921 → ws://localhost:9921/mqtt (page port)', () => {
    // The single-origin daemon emits broker_ws_same_origin:true because it now
    // bridges the broker at /mqtt on the WEB port (e.g. 9921). The URL must use
    // the page's own host:port so it matches the page origin exactly and CSP
    // connect-src 'self' permits it. Dropping the port builds ws://localhost/mqtt
    // (port 80) — a DIFFERENT origin, which is blocked. broker_ws_port is
    // advertised for back-compat but the same-origin flag wins.
    const caps = {
      broker_ws_same_origin: true,
      broker_ws_port: 9001,
      broker_ws_path: '/mqtt',
    };
    const url = resolveBrokerUrl(caps, HTTP('localhost', 'localhost:9921'));
    expect(url).toBe('ws://localhost:9921/mqtt');
    expect(url).not.toContain(':9001');
  });

  it('single-origin: http page on a Tailscale host:port → ws://host:9921/mqtt (page port)', () => {
    const caps = { broker_ws_same_origin: true, broker_ws_path: '/mqtt' };
    const url = resolveBrokerUrl(
      caps,
      HTTP('phil-desktop.tail6c27f6.ts.net', 'phil-desktop.tail6c27f6.ts.net:9921'),
    );
    expect(url).toBe('ws://phil-desktop.tail6c27f6.ts.net:9921/mqtt');
  });

  it('https page on the default port (host has no :port) → wss://host/mqtt (no explicit port)', () => {
    // tailscale serve maps the origin onto 443, so window.location.host has no
    // port. The same-origin URL must therefore omit the port too.
    expect(resolveBrokerUrl({}, HTTPS('box.ts.net'))).toBe('wss://box.ts.net/mqtt');
  });

  it('honors a custom path on same-origin', () => {
    const caps = { broker_ws_path: '/broker' };
    expect(resolveBrokerUrl(caps, HTTPS('box.ts.net'))).toBe('wss://box.ts.net/broker');
  });
});

describe('resolveBrokerUrl — fallback to page host', () => {
  it('falls back to page host (ws) on http when nothing advertised', () => {
    expect(resolveBrokerUrl({}, HTTP('my-pc.tailnet.ts.net')))
      .toBe('ws://my-pc.tailnet.ts.net:9001/mqtt');
  });

  it('falls back when caps is null', () => {
    expect(resolveBrokerUrl(null, HTTP('localhost'))).toBe('ws://localhost:9001/mqtt');
  });

  it('honors advertised port + path on fallback', () => {
    const caps = { broker_ws_port: 8001, broker_ws_path: '/ws' };
    expect(resolveBrokerUrl(caps, HTTP('localhost'))).toBe('ws://localhost:8001/ws');
  });

  it('ignores an empty-string broker_ws_url and falls back', () => {
    expect(resolveBrokerUrl({ broker_ws_url: '', broker_ws_port: 9001 }, HTTP('box')))
      .toBe('ws://box:9001/mqtt');
  });
});

describe('defaultBrokerUrl', () => {
  it('builds the page-host fallback (http→ws)', () => {
    expect(defaultBrokerUrl({ host: 'localhost', protocol: 'http:' }))
      .toBe('ws://localhost:9001/mqtt');
  });

  it('uses wss when protocol is https', () => {
    expect(defaultBrokerUrl({ host: 'h', protocol: 'https:' }))
      .toBe('wss://h:9001/mqtt');
  });

  it('accepts custom port and path', () => {
    expect(defaultBrokerUrl({ host: 'h', protocol: 'http:', port: 1234, path: '/x' }))
      .toBe('ws://h:1234/x');
  });
});

describe('sameOriginBrokerUrl', () => {
  it('follows the page protocol and omits the port on default ports', () => {
    expect(sameOriginBrokerUrl({ host: 'box.ts.net', protocol: 'https:' }))
      .toBe('wss://box.ts.net/mqtt');
    expect(sameOriginBrokerUrl({ host: 'box', protocol: 'http:' }))
      .toBe('ws://box/mqtt');
  });

  it('preserves the port when the host includes one (host:port)', () => {
    expect(sameOriginBrokerUrl({ host: 'localhost:9921', protocol: 'http:' }))
      .toBe('ws://localhost:9921/mqtt');
    expect(sameOriginBrokerUrl({ host: 'phil-desktop.tail6c27f6.ts.net:9921', protocol: 'http:' }))
      .toBe('ws://phil-desktop.tail6c27f6.ts.net:9921/mqtt');
  });
});
