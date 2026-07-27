import {
  NOOP_LOGGER,
  RUN_DELIVERY_MODE,
  type NodeExecutionContext,
  type NodeSpec,
  type ResolvedProvider,
  type ResolvedTool,
} from '@openpipeline/core';
import { describe, it, expect, vi } from 'vitest';

import { McpNodeResolverImpl } from '../src/node-resolver.js';

function makeExecutionContext(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    nodeId: 'n1',
    nodeLabel: 'MCP Node',
    stepId: 'step-1',
    runId: 'run-1',
    pipelineId: 'pipeline-1',
    deliveryMode: RUN_DELIVERY_MODE.INVOKE,
    emit: vi.fn(),
    createChildStep: vi.fn(),
    finishChildStep: vi.fn(),
    reportCost: vi.fn(),
    createLLM: vi.fn(),
    logger: NOOP_LOGGER,
    ...overrides,
  };
}

describe('McpNodeResolverImpl — declared output schema validation', () => {
  it('throws MCP_OUTPUT_SCHEMA_MISMATCH when tool output violates its declared schema', async () => {
    const tool: ResolvedTool = {
      name: 'tool',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
      },
      invoke: vi.fn().mockResolvedValue({ n: 'not-a-number' }),
    };
    const provider: ResolvedProvider = {
      key: 'prov',
      displayName: 'Prov',
      tools: [tool],
    };

    const resolver = new McpNodeResolverImpl();
    const spec = (await resolver.resolveSpec('mcp:prov:tool', {
      mcpCatalogCache: [provider],
    })) as NodeSpec<unknown, never>;

    const ctx = makeExecutionContext({ mcpCatalogCache: [provider] });

    await expect(spec.handler({}, ctx)).rejects.toThrow(/MCP_OUTPUT_SCHEMA_MISMATCH/);
    await expect(spec.handler({}, ctx)).rejects.toThrow(/provider contract/i);
  });

  it('passes through when the tool declares no output schema (GenericMcpOutputSchema)', async () => {
    const tool: ResolvedTool = {
      name: 'tool',
      inputSchema: { type: 'object' },
      invoke: vi.fn().mockResolvedValue({ anything: 'goes' }),
    };
    const provider: ResolvedProvider = {
      key: 'prov',
      displayName: 'Prov',
      tools: [tool],
    };

    const resolver = new McpNodeResolverImpl();
    const spec = (await resolver.resolveSpec('mcp:prov:tool', {
      mcpCatalogCache: [provider],
    })) as NodeSpec<unknown, never>;

    const ctx = makeExecutionContext({ mcpCatalogCache: [provider] });

    const result = await spec.handler({}, ctx);
    expect(result).toEqual({
      kind: 'mcp_tool',
      providerKey: 'prov',
      toolName: 'tool',
      output: { anything: 'goes' },
    });
  });
});

describe('McpNodeResolverImpl — transport error retry (#S7/H2)', () => {
  it('retries once on a retryable transport error and succeeds', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('MCP error -32000: Connection closed'))
      .mockResolvedValueOnce({ ok: true });
    const tool: ResolvedTool = {
      name: 'tool',
      inputSchema: { type: 'object' },
      invoke,
    };
    const provider: ResolvedProvider = { key: 'prov', displayName: 'Prov', tools: [tool] };

    const resolver = new McpNodeResolverImpl();
    const spec = (await resolver.resolveSpec('mcp:prov:tool', {
      mcpCatalogCache: [provider],
    })) as NodeSpec<unknown, never>;

    const warn = vi.fn();
    const ctx = makeExecutionContext({
      mcpCatalogCache: [provider],
      logger: { ...NOOP_LOGGER, warn },
    });

    const result = await spec.handler({}, ctx);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      kind: 'mcp_tool',
      providerKey: 'prov',
      toolName: 'tool',
      output: { ok: true },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying once'));
  });

  it('does not retry a non-retryable error and rejects immediately', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('MCP error -32602: Invalid params'));
    const tool: ResolvedTool = {
      name: 'tool',
      inputSchema: { type: 'object' },
      invoke,
    };
    const provider: ResolvedProvider = { key: 'prov', displayName: 'Prov', tools: [tool] };

    const resolver = new McpNodeResolverImpl();
    const spec = (await resolver.resolveSpec('mcp:prov:tool', {
      mcpCatalogCache: [provider],
    })) as NodeSpec<unknown, never>;

    const ctx = makeExecutionContext({ mcpCatalogCache: [provider] });

    await expect(spec.handler({}, ctx)).rejects.toThrow(/Invalid params/);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('surfaces the retried call error if it fails again too', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('MCP error -32000: Connection closed'));
    const tool: ResolvedTool = {
      name: 'tool',
      inputSchema: { type: 'object' },
      invoke,
    };
    const provider: ResolvedProvider = { key: 'prov', displayName: 'Prov', tools: [tool] };

    const resolver = new McpNodeResolverImpl();
    const spec = (await resolver.resolveSpec('mcp:prov:tool', {
      mcpCatalogCache: [provider],
    })) as NodeSpec<unknown, never>;

    const ctx = makeExecutionContext({ mcpCatalogCache: [provider] });

    await expect(spec.handler({}, ctx)).rejects.toThrow(/Connection closed/);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
