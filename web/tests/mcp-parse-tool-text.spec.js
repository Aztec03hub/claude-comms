// parseToolText — tolerates the concise-output framing added by
// mcp_server._concise so the web client still extracts the tool's JSON
// payload (refusal reasons included) after PR #28 dropped
// structuredContent and started framing the text block as
// "<summary>\n(ctrl+o for full)\n---\n<full JSON>".

import { describe, it, expect } from 'vitest';
import { parseToolText } from '../src/lib/api.js';

describe('parseToolText', () => {
  it('parses a bare-JSON text block (legacy / unframed tools)', () => {
    const out = parseToolText('{"deleted":true,"conversation_id":"design"}');
    expect(out).toEqual({ deleted: true, conversation_id: 'design' });
  });

  it('parses the JSON after the concise-output --- marker', () => {
    const full = { error: true, reason: 'not_authorized', message: 'Only an admin may delete.' };
    const framed = `Refused\n(ctrl+o for full)\n---\n${JSON.stringify(full, null, 2)}`;
    expect(parseToolText(framed)).toEqual(full);
  });

  it('parses a concise-framed role payload (used by role hydration)', () => {
    const full = { role: 'admin', participant_key: '0123abcd', conversation: 'design' };
    const framed = `Role: admin\n(ctrl+o for full)\n---\n${JSON.stringify(full)}`;
    expect(parseToolText(framed).role).toBe('admin');
  });

  it('returns null for non-JSON / empty input', () => {
    expect(parseToolText('not json at all')).toBeNull();
    expect(parseToolText('')).toBeNull();
    expect(parseToolText(null)).toBeNull();
  });
});
