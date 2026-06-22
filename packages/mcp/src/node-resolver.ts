import {
  NOOP_LOGGER,
  PipelineNodeExecutionError,
  type McpNodeResolver,
  type NodeSpec,
  type NodeExecutionContext,
  type McpToolNodeOutput,
  type ResolvedProvider,
  type ResolvedTool,
  type McpNodeSpecMeta,
  type Logger,
} from '@openpipeline/core';
import { z } from 'zod';

import { McpSchemaConverter } from './schema-converter.js';

export interface ParsedMcpKey {
  providerKey: string;
  toolName: string;
}

/** Parse `mcp:<provider>:<tool>` (last-colon split so tool names may contain colons). */
export function parseMcpKey(key: string): ParsedMcpKey {
  if (!key.startsWith('mcp:')) throw new Error(`[mcp] not an mcp key: "${key}"`);
  const rest = key.slice('mcp:'.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`[mcp] malformed key "${key}" (expected mcp:<provider>:<tool>)`);
  }
  return { providerKey: rest.slice(0, colonIdx), toolName: rest.slice(colonIdx + 1) };
}

/** Generic MCP tool output schema (used when the tool declares no output schema). */
const GenericMcpOutputSchema: z.ZodType<McpToolNodeOutput> = z.object({
  kind: z.literal('mcp_tool'),
  providerKey: z.string(),
  toolName: z.string(),
  output: z.unknown(),
});

/**
 * Resolves `mcp:<provider>:<tool>` keys to synthesized NodeSpecs at compile time,
 * reading the per-run catalog cache the engine flows through. Provide this to the
 * engine as `mcpNodeResolver` alongside a `catalogLoader`.
 */
export class McpNodeResolverImpl implements McpNodeResolver {
  private readonly converter: McpSchemaConverter;

  constructor(private readonly logger: Logger = NOOP_LOGGER) {
    this.converter = new McpSchemaConverter(logger);
  }

  // Resolution is fully synchronous (catalog is already cached), but the
  // McpNodeResolver contract is `Promise<NodeSpec>`. We honor that return type
  // without a misleading `async` keyword (there is no I/O to await), wrapping the
  // result so throws still surface as rejections for direct callers.
  resolveSpec(
    key: string,
    ctx: { userId?: string; tenantId?: string; mcpCatalogCache?: readonly unknown[] }
  ): Promise<NodeSpec> {
    return Promise.resolve().then(() => {
      const { providerKey, toolName } = parseMcpKey(key);
      const providers = (ctx.mcpCatalogCache ?? []) as readonly ResolvedProvider[];

      const provider = providers.find((p) => p.key === providerKey);
      if (!provider) {
        throw new PipelineNodeExecutionError(key, {
          kind: 'NODE_EXECUTION',
          code: 'NODE_MCP_PROVIDER_UNAVAILABLE',
          message: `MCP provider not available: ${providerKey}. It may be disabled or disconnected.`,
        });
      }

      const tool = provider.tools.find((t) => t.name === toolName);
      if (!tool) {
        throw new PipelineNodeExecutionError(key, {
          kind: 'NODE_EXECUTION',
          code: 'NODE_MCP_TOOL_NOT_EXPOSED',
          message: `MCP tool not exposed: ${providerKey}/${toolName}.`,
        });
      }

      const inputResult = this.converter.convert(tool.inputSchema ?? { type: 'object' }, {
        providerKey,
        toolName,
      });
      if (!inputResult.success) {
        throw new PipelineNodeExecutionError(key, {
          kind: 'NODE_EXECUTION',
          code: 'NODE_MCP_SCHEMA_INCOMPATIBLE',
          message: `MCP tool input schema could not be converted: ${providerKey}/${toolName} (${inputResult.reason.kind}).`,
        });
      }

      return this.buildSpec(provider, tool, inputResult.zodSchema);
    });
  }

  private buildSpec(provider: ResolvedProvider, tool: ResolvedTool, inputZod: z.ZodType): NodeSpec {
    const meta: McpNodeSpecMeta = {
      providerKey: provider.key,
      providerDisplayName: provider.displayName,
      toolName: tool.name,
      iconUrl: provider.iconUrl,
    };

    const outputSchema = this.synthesizeOutputSchema(provider, tool);

    const spec: NodeSpec<unknown, McpToolNodeOutput> = {
      key: `mcp:${provider.key}:${tool.name}`,
      nodeType: 'MCP_TOOL',
      displayName: `${provider.displayName} - ${tool.name}`,
      description: tool.description || `MCP tool: ${provider.key}/${tool.name}`,
      icon: 'puzzle',
      inputSchema: inputZod,
      outputSchema,
      handler: async (input: unknown, ctx: NodeExecutionContext): Promise<McpToolNodeOutput> => {
        // Re-resolve the tool from the per-run catalog (provider may have changed).
        const providers = (ctx.mcpCatalogCache ?? []) as readonly ResolvedProvider[];
        const runProvider = providers.find((p) => p.key === provider.key);
        const runTool = runProvider?.tools.find((t) => t.name === tool.name) ?? tool;

        ctx.logger.debug(`[mcp] invoke ${provider.key}/${tool.name}`);
        const output = await runTool.invoke(input);
        return { kind: 'mcp_tool', providerKey: provider.key, toolName: tool.name, output };
      },
      meta: { mcp: meta },
    };

    return spec;
  }

  private synthesizeOutputSchema(
    provider: ResolvedProvider,
    tool: ResolvedTool
  ): z.ZodType<McpToolNodeOutput> {
    if (!tool.outputSchema) return GenericMcpOutputSchema;
    const result = this.converter.convert(tool.outputSchema, {
      providerKey: provider.key,
      toolName: `${tool.name}:output`,
    });
    if (!result.success) return GenericMcpOutputSchema;
    return z.object({
      kind: z.literal('mcp_tool'),
      providerKey: z.string(),
      toolName: z.string(),
      output: result.zodSchema,
    });
  }
}
