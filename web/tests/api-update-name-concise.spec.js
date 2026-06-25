// Regression: api.updateName must parse the concise-output framing that
// mcp_server._concise (PR #28) applies to `comms_update_name`. That change
// dropped `structuredContent` and started framing the text block as
// "<summary>\n(ctrl+o for full)\n---\n<full JSON>". updateName had kept a
// naive `JSON.parse(text)` that failed on the frame, so EVERY rename surfaced
// as "Server returned an empty response." (the e2e settings test caught it,
// but unit tests had mocked updateName itself so the real fetch+parse path was
// never exercised). The fix routes updateName through the shared parseToolText
// helper. These tests pin the real fetch+parse path against the framed body.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { updateName } from '../src/lib/api.js';

function framed(payload) {
  return `Renamed\n(ctrl+o for full)\n---\n${JSON.stringify(payload, null, 2)}`;
}

function mockMcpResponse(payload) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      // Text-only CallToolResult: NO structuredContent, framed text body.
      result: { content: [{ type: 'text', text: framed(payload) }] },
    }),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateName — concise-framed MCP response', () => {
  it('parses the framed success body and reports success', async () => {
    vi.stubGlobal('fetch', mockMcpResponse({
      status: 'updated',
      name: 'phil-renamed',
      key: 'me-key',
    }));

    const result = await updateName('me-key', 'phil-renamed');
    expect(result).toEqual({ success: true, name: 'phil-renamed', key: 'me-key' });
  });

  it('surfaces a framed error payload as a failure (not "empty response")', async () => {
    vi.stubGlobal('fetch', mockMcpResponse({
      status: 'error',
      error: 'Name already taken.',
    }));

    const result = await updateName('me-key', 'taken');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Name already taken.');
  });
});
