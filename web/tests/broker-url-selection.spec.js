// Robust broker-URL selection.
//
// The web client used to hardcode `ws://<page-host>:9001/mqtt`, which loops on
// "Reconnecting to broker" when the page host can't reach the broker (the WSL2
// case: localhost on Windows doesn't reach the in-WSL broker). The daemon now
// advertises its broker WebSocket coordinates via /api/capabilities and the
// client prefers them, with same-origin (HTTPS proxy) and page-host fallbacks.
//
// These tests exercise the pure selection helpers without a live broker.

import { describe, it, expect } from 'vitest';
import {
  resolveBrokerUrl,
  defaultBrokerUrl,
  sameOriginBrokerUrl,
} from '../src/lib/mqtt-store.svelte.js';

const HTTP = (hostname) => ({ hostname, protocol: 'http:' });
const HTTPS = (hostname) => ({ hostname, protocol: 'https:' });

describe('resolveBrokerUrl — daemon advertisement wins', () => {
  it('uses the advertised broker_ws_url verbatim when present', () => {
    const caps = { broker_ws_url: 'ws://host.tailnet.ts.net:9001/mqtt' };
    expect(resolveBrokerUrl(caps, HTTP('localhost'))).toBe('ws://host.tailnet.ts.net:9001/mqtt');
  });

  it('advertised url wins even over a non-loopback page host', () => {
    const caps = { broker_ws_url: 'ws://canonical:9001/mqtt' };
    expect(resolveBrokerUrl(caps, HTTP('192.168.1.10'))).toBe('ws://canonical:9001/mqtt');
  });

  it('advertised url wins even over an HTTPS page (no same-origin override)', () => {
    const caps = { broker_ws_url: 'wss://explicit.ts.net:9001/mqtt' };
    expect(resolveBrokerUrl(caps, HTTPS('explicit.ts.net'))).toBe('wss://explicit.ts.net:9001/mqtt');
  });
});

describe('resolveBrokerUrl — same-origin (HTTPS proxy)', () => {
  it('uses wss same-origin path (no port) when page is https', () => {
    expect(resolveBrokerUrl({}, HTTPS('box.ts.net'))).toBe('wss://box.ts.net/mqtt');
  });

  it('uses wss same-origin when daemon flags broker_ws_same_origin', () => {
    const caps = { broker_ws_same_origin: true };
    // http page but daemon insists on same-origin → ws same-origin path.
    expect(resolveBrokerUrl(caps, HTTP('proxy.local'))).toBe('ws://proxy.local/mqtt');
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
  it('omits the port and follows the page protocol', () => {
    expect(sameOriginBrokerUrl({ host: 'box.ts.net', protocol: 'https:' }))
      .toBe('wss://box.ts.net/mqtt');
    expect(sameOriginBrokerUrl({ host: 'box', protocol: 'http:' }))
      .toBe('ws://box/mqtt');
  });
});
