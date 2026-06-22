import type { z } from 'zod';
import type { NodeType, RunDeliveryMode } from './enums.js';
import type { PipelineNodeOutput } from './node-output.js';
import type { CostBundle } from './cost.js';
import type { NodeEvent, RunContext } from './state.js';

// ── Child step ─────────────────────────────────────────────────────────────────

export interface ChildStepCreate {
  nodeId: string;
  parentStepId: string;
  input: unknown;
}

export interface ChildStepFinish {
  status: 'SUCCESS' | 'FAILED';
  input?: unknown;
  output?: unknown;
  error?: unknown;
  cost?: CostBundle;
}

export interface ModelOverrides {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Second argument to a node handler. Backend-only capabilities (LLM instances,
 * logger, MCP catalog) are deliberately typed loosely so that authoring a
 * custom node never drags a heavy framework dependency into core:
 *   - `createLLM` returns `unknown` — the LlmFactory adapter decides the type;
 *     cast it at the call site.
 *   - `mcpCatalogCache` is `unknown[]` — the MCP adapter casts it.
 *   - `logger` is a minimal subset interface.
 */
export interface NodeExecutionContext {
  nodeId: string;
  nodeLabel: string;
  stepId: string;

  runId: string;
  pipelineId: string;
  deliveryMode: RunDeliveryMode;
  context?: RunContext;

  signal?: AbortSignal;

  emit: (event: NodeEvent) => void;
  createChildStep: (params: ChildStepCreate) => Promise<{ childStepId: string }>;
  finishChildStep: (childStepId: string, result: ChildStepFinish) => Promise<void>;
  reportCost: (cost: CostBundle) => void;

  /** Create an LLM instance via the configured LlmFactory. Returns `unknown` — cast at call site. */
  createLLM: (modelId: string, overrides?: ModelOverrides) => unknown;

  /** Per-run MCP catalog cache, if loaded. Cast by the MCP adapter. */
  mcpCatalogCache?: readonly unknown[];

  logger: Logger;
}

export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

// ── NodeSpec ────────────────────────────────────────────────────────────────────

export type NodeHandler<TInput, TOutput extends PipelineNodeOutput> = (
  input: TInput,
  ctx: NodeExecutionContext
) => Promise<TOutput>;

/**
 * The contract every node implements. Pure data + Zod + a handler — no
 * framework coupling. This is the public plugin API: author a node with
 * {@link defineNode} and register it with the engine.
 */
export interface NodeSpec<
  TInput = unknown,
  TOutput extends PipelineNodeOutput = PipelineNodeOutput,
> {
  /** Unique key. Built-ins use dotted names (`control.if`); MCP uses `mcp:<provider>:<tool>`. */
  key: string;
  nodeType: NodeType;
  displayName: string;
  description: string;
  /** Icon name (consumer-defined; e.g. a lucide icon key). */
  icon: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  handler: NodeHandler<TInput, TOutput>;
  /**
   * Node-specific metadata surfaced verbatim by the catalog API (e.g. for a
   * builder UI to drive slot visibility). MCP nodes fill `meta.mcp`.
   */
  meta?: Record<string, unknown>;
}

/**
 * Author a custom node. Thin identity helper that gives you full type inference
 * on `handler` from the input/output schemas.
 */
export function defineNode<TInput, TOutput extends PipelineNodeOutput>(
  spec: NodeSpec<TInput, TOutput>
): NodeSpec<TInput, TOutput> {
  return spec;
}

// ── MCP node meta ───────────────────────────────────────────────────────────────

/** Standard MCP tool annotations (a subset of the MCP spec's annotations). */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpNodeSpecMeta {
  providerKey: string;
  providerDisplayName: string;
  toolName: string;
  iconUrl?: string;
  annotations?: McpToolAnnotations;
}
