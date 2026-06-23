import { DynamicStructuredTool, type StructuredTool } from '@langchain/core/tools';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CatalogPolicy } from '../src/catalog-policy.js';
import type { McpServerConfig } from '../src/types.js';

// ── Mock the genuine external boundary: client-factory opens real network/stdio
// MCP transports. We replace it with controllable fakes so the loader's pure
// orchestration (policy filtering, token resolution, allowlists, error handling,
// cleanup, result-unwrapping) is exercised against real loader code. ─────────────
const createClient = vi.fn();
const getFilteredTools = vi.fn();
const getRawSchemas = vi.fn();

vi.mock('../src/client-factory.js', () => ({
  createClient: (...args: unknown[]): unknown => createClient(...args),
  getFilteredTools: (...args: unknown[]): unknown => getFilteredTools(...args),
  getRawSchemas: (...args: unknown[]): unknown => getRawSchemas(...args),
}));

// Imported AFTER the mock registration above (vi.mock is hoisted, so order is safe).
const { createEnvCatalogLoader } = await import('../src/env-catalog-loader.js');

/** A fake MultiServerMCPClient — the loader only ever calls `.close()` on it. */
function fakeClient(): { close: () => Promise<void> } {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

/** Build a real LangChain tool (the loader reads `.name`/`.description`/`.invoke`). */
function tool(name: string, invokeResult: unknown = `${name}-result`): StructuredTool {
  return new DynamicStructuredTool({
    name,
    description: `${name} description`,
    schema: z.looseObject({}),
    func: () => Promise.resolve(invokeResult),
  });
}

const HTTP_SERVER: McpServerConfig = {
  key: 'srvA',
  displayName: 'Server A',
  transportType: 'http',
  url: 'http://example.test/mcp',
  accessToken: 'tok-A',
};

beforeEach(() => {
  createClient.mockReset();
  getFilteredTools.mockReset();
  getRawSchemas.mockReset();
  // Sensible defaults: a working client, one tool, no raw schemas.
  createClient.mockImplementation(() => fakeClient());
  getFilteredTools.mockResolvedValue([tool('alpha')]);
  getRawSchemas.mockResolvedValue({ inputSchemas: new Map(), outputSchemas: new Map() });
});

describe('createEnvCatalogLoader — single-tenant default (no policy)', () => {
  it('loads every configured server and exposes its tools', async () => {
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER] });
    const result = await loader.load({});
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.key).toBe('srvA');
    expect(result.providers[0]?.displayName).toBe('Server A');
    expect(result.providers[0]?.tools.map((t) => t.name)).toEqual(['alpha']);
  });

  it('falls back to the server key when no displayName is configured', async () => {
    const loader = createEnvCatalogLoader({
      servers: [{ key: 'bare', transportType: 'http', url: 'http://x.test' }],
    });
    const result = await loader.load({});
    expect(result.providers[0]?.displayName).toBe('bare');
  });

  it("passes the server's configured accessToken to createClient", async () => {
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER] });
    await loader.load({});
    expect(createClient).toHaveBeenCalledWith(HTTP_SERVER, 'tok-A');
  });

  it("suppresses the token (undefined) when authType is 'none'", async () => {
    const server: McpServerConfig = { ...HTTP_SERVER, authType: 'none', accessToken: 'ignored' };
    const loader = createEnvCatalogLoader({ servers: [server] });
    await loader.load({});
    expect(createClient).toHaveBeenCalledWith(server, undefined);
  });
});

describe('createEnvCatalogLoader — CatalogPolicy hooks', () => {
  it('narrows the server set via filterProviders', async () => {
    const serverB: McpServerConfig = { key: 'srvB', transportType: 'http', url: 'http://b.test' };
    const policy: CatalogPolicy = {
      filterProviders: (servers) => servers.filter((s) => s.key === 'srvA'),
    };
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER, serverB], policy });
    const result = await loader.load({});
    expect(result.providers.map((p) => p.key)).toEqual(['srvA']);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('overrides the token via resolveToken', async () => {
    const policy: CatalogPolicy = { resolveToken: () => 'per-user-token' };
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER], policy });
    await loader.load({});
    expect(createClient).toHaveBeenCalledWith(HTTP_SERVER, 'per-user-token');
  });

  it('falls back to server.accessToken when resolveToken returns undefined', async () => {
    const policy: CatalogPolicy = { resolveToken: () => undefined };
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER], policy });
    await loader.load({});
    expect(createClient).toHaveBeenCalledWith(HTTP_SERVER, 'tok-A');
  });

  it('forwards run context (userId/tenantId) to policy hooks', async () => {
    const filterProviders = vi.fn((servers: readonly McpServerConfig[]) => [...servers]);
    const policy: CatalogPolicy = { filterProviders };
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER], policy });
    await loader.load({ userId: 'u1', tenantId: 't1' });
    expect(filterProviders).toHaveBeenCalledWith([HTTP_SERVER], { userId: 'u1', tenantId: 't1' });
  });

  it('applies the tool allowlist via filterTools', async () => {
    getFilteredTools.mockResolvedValue([tool('keep'), tool('drop')]);
    const policy: CatalogPolicy = {
      filterTools: (tools) => tools.filter((t) => t.name === 'keep'),
    };
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER], policy });
    const result = await loader.load({});
    expect(result.providers[0]?.tools.map((t) => t.name)).toEqual(['keep']);
  });
});

describe('createEnvCatalogLoader — error resilience', () => {
  it('skips a server whose client creation throws, keeping the others', async () => {
    const serverB: McpServerConfig = { key: 'srvB', transportType: 'http', url: 'http://b.test' };
    createClient.mockImplementation((cfg: McpServerConfig) => {
      if (cfg.key === 'srvA') throw new Error('boom');
      return fakeClient();
    });
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER, serverB] });
    const result = await loader.load({});
    expect(result.providers.map((p) => p.key)).toEqual(['srvB']);
  });

  it('skips a server whose tool listing rejects', async () => {
    getFilteredTools.mockRejectedValue(new Error('listTools failed'));
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER] });
    const result = await loader.load({});
    expect(result.providers).toHaveLength(0);
  });
});

describe('createEnvCatalogLoader — resolved tool invocation', () => {
  it('unwraps a tool result, preferring structuredContent', async () => {
    getFilteredTools.mockResolvedValue([
      tool('struct', { structuredContent: { value: 42 }, content: ['ignored'] }),
    ]);
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER] });
    const result = await loader.load({});
    const invoked = await result.providers[0]?.tools[0]?.invoke({});
    expect(invoked).toEqual({ value: 42 });
  });

  it('returns the raw result when there is no structuredContent', async () => {
    getFilteredTools.mockResolvedValue([tool('plain', { content: 'hi' })]);
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER] });
    const result = await loader.load({});
    const invoked = await result.providers[0]?.tools[0]?.invoke({});
    expect(invoked).toEqual({ content: 'hi' });
  });

  it('attaches raw input/output schemas to the resolved tool', async () => {
    const inputSchemas = new Map<string, unknown>([['alpha', { type: 'object' }]]);
    const outputSchemas = new Map<string, unknown>([['alpha', { type: 'string' }]]);
    getRawSchemas.mockResolvedValue({ inputSchemas, outputSchemas });
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER] });
    const result = await loader.load({});
    const t = result.providers[0]?.tools[0];
    expect(t?.inputSchema).toEqual({ type: 'object' });
    expect(t?.outputSchema).toEqual({ type: 'string' });
  });
});

describe('createEnvCatalogLoader — cleanup', () => {
  it('closes every opened client on cleanup', async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    const queue = [clientA, clientB];
    createClient.mockImplementation(() => queue.shift());
    const serverB: McpServerConfig = { key: 'srvB', transportType: 'http', url: 'http://b.test' };
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER, serverB] });
    const result = await loader.load({});
    await result.cleanup();
    expect(clientA.close).toHaveBeenCalledTimes(1);
    expect(clientB.close).toHaveBeenCalledTimes(1);
  });

  it('swallows a client close error during cleanup (does not reject)', async () => {
    const client = fakeClient();
    client.close = vi.fn().mockRejectedValue(new Error('close failed'));
    createClient.mockImplementation(() => client);
    const loader = createEnvCatalogLoader({ servers: [HTTP_SERVER] });
    const result = await loader.load({});
    await expect(result.cleanup()).resolves.toBeUndefined();
  });
});
