import { describe, it, expect } from 'vitest';

import { parseMcpKey } from '../src/node-resolver.js';

describe('parseMcpKey', () => {
  it('parses a plain mcp:<provider>:<tool> key', () => {
    expect(parseMcpKey('mcp:github:create_issue')).toEqual({
      providerKey: 'github',
      toolName: 'create_issue',
    });
  });

  it('keeps colons in the tool name (splits only on the first colon after the prefix)', () => {
    // The provider key is the first segment after `mcp:`; everything after the
    // next colon is the tool name verbatim, so tool names may contain colons.
    expect(parseMcpKey('mcp:srv:tool:with:colons')).toEqual({
      providerKey: 'srv',
      toolName: 'tool:with:colons',
    });
  });

  it('preserves a namespaced tool name (single embedded colon)', () => {
    expect(parseMcpKey('mcp:atlassian:jira:search')).toEqual({
      providerKey: 'atlassian',
      toolName: 'jira:search',
    });
  });

  it('yields an empty tool name when the key ends right after the separator', () => {
    expect(parseMcpKey('mcp:srv:')).toEqual({ providerKey: 'srv', toolName: '' });
  });

  it('yields an empty provider key when the separator is immediate', () => {
    expect(parseMcpKey('mcp::tool')).toEqual({ providerKey: '', toolName: 'tool' });
  });

  it('throws when the key does not start with the mcp: prefix', () => {
    expect(() => parseMcpKey('notmcp:x:y')).toThrow(/not an mcp key/);
  });

  it('throws when the prefix is present but there is no provider/tool separator', () => {
    expect(() => parseMcpKey('mcp:srv')).toThrow(/malformed key/);
  });

  it('throws on a bare "mcp:" with nothing after it', () => {
    expect(() => parseMcpKey('mcp:')).toThrow(/malformed key/);
  });

  it('includes the offending key in the error message', () => {
    expect(() => parseMcpKey('mcp:lonely')).toThrow('mcp:lonely');
  });
});
