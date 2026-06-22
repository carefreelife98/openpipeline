/**
 * OpenPipeline MCP example — runs a pipeline with an `mcp:` node end to end.
 *
 * For a real MCP server you'd use `createEnvCatalogLoader` from @openpipeline/mcp:
 *
 *   import { createEnvCatalogLoader, McpNodeResolverImpl } from '@openpipeline/mcp';
 *   const catalogLoader = createEnvCatalogLoader({
 *     servers: [
 *       { key: 'github', transportType: 'stdio', command: 'npx',
 *         args: ['-y', '@modelcontextprotocol/server-github'],
 *         authType: 'none', env: { GITHUB_TOKEN: process.env.GH_TOKEN! } },
 *     ],
 *   });
 *   const engine = new PipelineEngine({ store, llmFactory, catalogLoader,
 *     mcpNodeResolver: new McpNodeResolverImpl() });
 *
 * To keep this example hermetic (no network, no child processes), we supply a
 * MOCK CatalogLoader that satisfies the same interface. The engine → resolver →
 * tool.invoke path is exactly the same as with a real server.
 */
import { PipelineEngine } from '@openpipeline/runtime';
import { MemoryStore } from '@openpipeline/store-memory';
import { McpNodeResolverImpl } from '@openpipeline/mcp';
import type { CatalogLoader } from '@openpipeline/core';

// A mock CatalogLoader exposing one "weather" provider with one tool.
const mockCatalogLoader: CatalogLoader = {
  async load() {
    return {
      providers: [
        {
          key: 'weather',
          displayName: 'Weather',
          tools: [
            {
              name: 'get_forecast',
              description: 'Get a (fake) forecast for a city.',
              inputSchema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
              outputSchema: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                  summary: { type: 'string' },
                  tempC: { type: 'number' },
                },
                required: ['city', 'summary', 'tempC'],
              },
              invoke: async (input: unknown) => {
                const { city } = input as { city: string };
                return { city, summary: 'Sunny', tempC: 24 };
              },
            },
          ],
        },
      ],
      cleanup: async () => {},
    };
  },
};

const engine = new PipelineEngine({
  store: new MemoryStore(),
  llmFactory: { createModel: () => ({ invoke: async () => ({ content: '' }) }) },
  catalogLoader: mockCatalogLoader,
  mcpNodeResolver: new McpNodeResolverImpl(console),
  logger: console,
});

const pipelineId = await engine.save({
  name: 'mcp-forecast',
  nodes: [
    {
      id: 'forecast',
      nodeType: 'MCP_TOOL',
      key: 'mcp:weather:get_forecast',
      label: 'Get forecast',
      inputs: { city: { kind: 'literal', value: 'Seoul' } },
    },
  ],
  edges: [],
});

const { runId, done } = await engine.run({ pipelineId });
const result = await done;

console.log('\n── Result ──────────────────────────────');
console.log('runId:', runId);
console.log('status:', result.status);
console.log('outputs:', JSON.stringify(result.outputs, null, 2));
