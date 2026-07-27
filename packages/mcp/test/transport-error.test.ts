import { describe, it, expect } from 'vitest';

import { isRetryableMcpTransportError, parseMcpErrorCode } from '../src/transport-error.js';

describe('parseMcpErrorCode', () => {
  it('parses the numeric code from the standard adapter-wrapped message', () => {
    expect(parseMcpErrorCode(new Error('MCP error -32000: Connection closed'))).toBe(-32000);
  });

  it('returns undefined for a message with no MCP error prefix', () => {
    expect(parseMcpErrorCode(new Error('random failure'))).toBeUndefined();
  });

  it('handles non-Error thrown values via String() coercion', () => {
    expect(parseMcpErrorCode('MCP error -32001: Request timed out')).toBe(-32001);
  });
});

describe('isRetryableMcpTransportError', () => {
  it('parses MCP error codes from the standard adapter-wrapped message', () => {
    expect(isRetryableMcpTransportError(new Error('MCP error -32000: Connection closed'))).toBe(
      true
    );
    expect(isRetryableMcpTransportError(new Error('MCP error -32001: Request timed out'))).toBe(
      true
    );
    expect(isRetryableMcpTransportError(new Error('MCP error -32602: Invalid params'))).toBe(false);
    expect(isRetryableMcpTransportError(new Error('random failure'))).toBe(false);
  });
});
