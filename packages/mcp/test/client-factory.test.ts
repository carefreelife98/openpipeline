import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { describe, it, expect } from 'vitest';

import {
  createClient,
  getRawSchemas,
  PreObtainedTokenAuthProvider,
} from '../src/client-factory.js';
import type { McpServerConfig } from '../src/types.js';

const HTTP: McpServerConfig = { key: 'gh', transportType: 'http', url: 'https://mcp.example/sse' };

// minimal fake provider — implements required OAuthClientProvider methods
const fakeProvider = {
  redirectUrl: 'http://localhost:0/callback',
  clientMetadata: { redirect_uris: [] },
  clientInformation: () => undefined,
  tokens: () => ({ access_token: 'fake', token_type: 'bearer' }),
  saveTokens: () => {},
  saveClientInformation: () => {},
  redirectToAuthorization: () => {},
  saveCodeVerifier: () => {},
  codeVerifier: () => '',
} as unknown as OAuthClientProvider;

describe('createClient auth argument', () => {
  it('accepts a string token (legacy) and constructs a client', () => {
    const c = createClient(HTTP, 'tok');
    expect(c).toBeTruthy();
  });
  it('accepts an OAuthClientProvider instance and constructs a client', () => {
    const c = createClient(HTTP, fakeProvider);
    expect(c).toBeTruthy();
  });
  it('PreObtainedTokenAuthProvider still wraps a bare string token', () => {
    const p = new PreObtainedTokenAuthProvider('tok');
    expect(p.tokens()).toEqual({ access_token: 'tok', token_type: 'bearer' });
  });
});

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
