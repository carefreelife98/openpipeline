import { describe, it, expect } from 'vitest';

import { getRawSchemas } from '../src/client-factory.js';

describe('getRawSchemas — cursor pagination', () => {
  it('passes nextCursor into subsequent listTools calls (no infinite loop)', async () => {
    const calls: Array<{ cursor?: string } | undefined> = [];
    const rawClient = {
      listTools: (params?: { cursor?: string }) => {
        calls.push(params);
        if (!params?.cursor)
          return Promise.resolve({ tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'c2' });
        return Promise.resolve({ tools: [{ name: 'b', inputSchema: {} }] }); // 마지막 페이지
      },
    };
    const client = { getClient: () => Promise.resolve(rawClient) };
    const { inputSchemas } = await getRawSchemas(client as never, 'srv');
    expect(calls).toEqual([undefined, { cursor: 'c2' }]);
    expect([...inputSchemas.keys()]).toEqual(['a', 'b']);
  });
});
