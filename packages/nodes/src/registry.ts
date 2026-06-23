import type { NodeSpec, NodeType, McpNodeResolver, PipelineNodeOutput } from '@openpipeline/core';

export interface NodeResolveContext {
  userId?: string;
  tenantId?: string;
  /** Per-run cached MCP catalog, passed by the runtime so all MCP nodes share one load. */
  mcpCatalogCache?: readonly unknown[];
}

/**
 * Registry of node specs. Two lookup paths:
 *   - static specs (TOOL / LLM / IF): synchronous map lookup
 *   - `mcp:` keys: delegated to an optional McpNodeResolver
 *
 * De-@Injectable'd from the Mate-X original: a plain class you construct and
 * register nodes on. The MCP resolver is optional — graphs with only static
 * nodes never need it.
 */
export class NodeSpecRegistry {
  private readonly specs = new Map<string, NodeSpec>();

  constructor(private readonly mcpResolver?: McpNodeResolver) {}

  register<TInput, TOutput extends PipelineNodeOutput>(spec: NodeSpec<TInput, TOutput>): this {
    if (this.specs.has(spec.key)) {
      throw new Error(`Duplicate NodeSpec: ${spec.key}`);
    }
    this.specs.set(spec.key, spec as NodeSpec);
    return this;
  }

  async get(key: string, ctx: NodeResolveContext = {}): Promise<NodeSpec> {
    if (key.startsWith('mcp:')) {
      if (!this.mcpResolver) {
        throw new Error(
          `[NodeSpecRegistry] MCP node "${key}" requires an McpNodeResolver. ` +
            `Pass one to the registry (see @openpipeline/mcp) or remove MCP nodes from the graph.`
        );
      }
      return this.mcpResolver.resolveSpec(key, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        mcpCatalogCache: ctx.mcpCatalogCache,
      });
    }
    const spec = this.specs.get(key);
    if (!spec) {
      throw new Error(`NodeSpec not found: ${key}`);
    }
    return spec;
  }

  list(filter?: { nodeType?: NodeType }): NodeSpec[] {
    const all = Array.from(this.specs.values());
    if (!filter?.nodeType) return all;
    return all.filter((s) => s.nodeType === filter.nodeType);
  }
}
