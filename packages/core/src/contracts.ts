import type { RunDeliveryMode, RunStatus, RunStepStatus } from './enums.js';
import type { CostBundle } from './cost.js';
import type { PipelineError } from './state.js';
import type { PipelineWithGraph, PipelineRow, PipelineNodeRow, PipelineEdgeRow } from './graph.js';
import type { NodeSpec, Logger } from './node-spec.js';

// The inversion layer. These interfaces are what the engine depends on instead
// of NestJS DI + Prisma. A host provides implementations; reference adapters
// (in-memory, Prisma) ship separately.

// ── LLM ───────────────────────────────────────────────────────────────────────

/**
 * Creates language-model instances on demand. The returned value is `unknown`
 * — it is whatever your LLM client uses (e.g. a LangChain `BaseChatModel`).
 * Node handlers cast it. This is the single seam through which OpenPipeline
 * stays provider-agnostic.
 */
export interface LlmFactory {
  createModel(modelId: string, overrides?: { temperature?: number; maxTokens?: number }): unknown;
}

// ── Logger ──────────────────────────────────────────────────────────────────────

// Logger is defined alongside NodeExecutionContext in node-spec.ts. It flows to
// consumers through the core barrel; we only import it here for NOOP_LOGGER.

/** No-op logger used as the default. */
export const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ── Persistence: PipelineStore ────────────────────────────────────────────────

export interface PipelineDraft {
  id?: string;
  name: string;
  description?: string;
  outputJsonSchema?: unknown;
  nodes: ReadonlyArray<Omit<PipelineNodeRow, 'pipelineId'>>;
  edges: ReadonlyArray<Omit<PipelineEdgeRow, 'pipelineId'>>;
}

export interface RunCreate {
  pipelineId: string;
  userId?: string;
  deliveryMode: RunDeliveryMode;
  triggerSource?: string;
  input?: unknown;
}

export interface RunComplete {
  status: RunStatus;
  output?: unknown;
  error?: PipelineError;
  cost?: CostBundle;
  lastState?: unknown;
}

export interface RunSummary {
  id: string;
  pipelineId: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt?: Date;
  cost?: CostBundle;
}

/**
 * Persistence for pipelines and runs. The Mate-X repositories (with their
 * multi-tenant permission logic) collapse into this single interface; the
 * engine never sees `companyId` / `scope`. A host that needs tenancy wraps
 * these calls in its own adapter.
 */
export interface PipelineStore {
  load(pipelineId: string): Promise<PipelineWithGraph>;
  save(draft: PipelineDraft): Promise<string>;
  createRun(run: RunCreate): Promise<{ runId: string; startedAt: Date }>;
  completeRun(runId: string, result: RunComplete): Promise<void>;
  /**
   * Atomically add a cost delta to a run. Separated so non-Postgres backends
   * can implement it however they like (the Prisma adapter uses a jsonb update).
   */
  updateRunCostAtomic(runId: string, delta: CostBundle): Promise<void>;
  listRuns(pipelineId: string, opts?: { limit?: number }): Promise<RunSummary[]>;
}

// ── Persistence: StepRecorder ─────────────────────────────────────────────────

export interface StepStart {
  runId: string;
  nodeId: string;
  nodeLabel: string;
}

export interface StepFinish {
  status: RunStepStatus;
  input?: unknown;
  output?: unknown;
  error?: PipelineError;
  cost?: CostBundle;
}

/**
 * Records per-node execution steps. Kept distinct from PipelineStore because it
 * is on the hot path and needs its own serialization guarantee: LangGraph
 * fan-in can call `start()` concurrently, so an implementation MUST assign
 * `sequenceIndex` under a mutex (see the in-memory reference impl).
 */
export interface StepRecorder {
  start(step: StepStart): Promise<string>;
  finish(stepId: string, result: StepFinish): Promise<void>;
  startChild(params: {
    runId: string;
    parentStepId: string;
    nodeId: string;
    input: unknown;
  }): Promise<string>;
  finishChild(childStepId: string, result: StepFinish): Promise<void>;
  /** Mark any still-RUNNING steps of a run as FAILED (crash recovery). */
  finalizeStaleSteps(runId: string): Promise<void>;
}

// ── MCP catalog (optional) ────────────────────────────────────────────────────

export interface ResolvedTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool input (MCP standard). */
  inputSchema?: unknown;
  /** Optional JSON Schema for the tool output (MCP standard). */
  outputSchema?: unknown;
  invoke(input: unknown): Promise<unknown>;
}

export interface ResolvedProvider {
  key: string;
  displayName: string;
  iconUrl?: string;
  tools: ResolvedTool[];
}

export interface CatalogResult {
  providers: ResolvedProvider[];
  /** Close any open MCP client connections. Called once per run in a finally block. */
  cleanup(): Promise<void>;
}

/**
 * Loads the available MCP tool catalog for a run. The default single-tenant
 * loader reads providers from config/env. Multi-tenant curation (admin
 * allowlist, per-user OAuth) is implemented as an optional CatalogPolicy on top
 * of a loader — it is NOT part of this core contract.
 */
export interface CatalogLoader {
  load(ctx: { userId?: string; tenantId?: string }): Promise<CatalogResult>;
}

// ── Node lookup (optional MCP delegation) ─────────────────────────────────────

/**
 * Resolves `mcp:<provider>:<tool>` keys to a synthesized NodeSpec at compile
 * time. The registry delegates to this when an MCP key is encountered. Optional
 * — graphs with only static nodes never need it.
 */
export interface McpNodeResolver {
  resolveSpec(
    key: string,
    ctx: { userId?: string; tenantId?: string; mcpCatalogCache?: readonly unknown[] }
  ): Promise<NodeSpec>;
}
