import type {
  CatalogLoader,
  Logger,
  LlmFactory,
  McpNodeResolver,
  NodeSpec,
  PipelineDraft,
  RunContext,
} from '@openpipeline/core';
import type { GraphValidationIssue } from '@openpipeline/nodes';

/**
 * A source of {@link NodeSpec}s handed to the planner. A plain array is
 * resolved once; a factory is called fresh on every {@link PipelinePlanner.plan}
 * call, so a caller backed by a live {@link NodeSpecRegistry} always sees its
 * current contents (e.g. `() => registry.list()`).
 */
export type PlannerSpecsInput = readonly NodeSpec[] | (() => readonly NodeSpec[]);

export interface PipelinePlannerOptions {
  llmFactory: LlmFactory;
  /** No vendor default (D8) — a model id is always required. */
  modelId: string;
  specs: PlannerSpecsInput;
  /**
   * MCP tool selection (intent -> select -> design routing). NOT implemented
   * in this build: the planner only supports the no-catalog, static-specs-only
   * path. Passing either option throws synchronously from the constructor —
   * see {@link PipelinePlanner}'s doc comment for the tracked follow-up.
   */
  catalogLoader?: CatalogLoader;
  mcpNodeResolver?: McpNodeResolver;
  /** Max design attempts before giving up. Default 3. */
  maxAttempts?: number;
  /** Sampling temperature passed to `llmFactory.createModel`. Default 0.3. */
  temperature?: number;
  /**
   * Receives one `debug(...)` call per node entry (`design`/`validate`/`correct`,
   * phase + attempt number) throughout `plan()`. Defaults to `NOOP_LOGGER`
   * (no-op) if omitted.
   */
  logger?: Logger;
}

export interface PlanRequest {
  instruction: string;
  /**
   * Reserved for the MCP-catalog path (T2 — `catalogLoader`/`mcpNodeResolver`
   * loading a live tool catalog for the `intent -> select` routing D2
   * describes). Accepted here already so `PlanRequest`'s shape doesn't need a
   * breaking change once T2 lands, but **not read anywhere in this build**:
   * the no-MCP design/validate/correct loop has no catalog to load and no use
   * for it (T1 review round 3, M3).
   */
  context?: RunContext;
  signal?: AbortSignal;
  onProgress?: (event: PlannerProgressEvent) => void;
}

export type PlannerPhase = 'intent' | 'select' | 'design' | 'validate' | 'correct';

export interface PlannerProgressEvent {
  phase: PlannerPhase;
  attempt: number;
  detail?: string;
}

export interface PlannerResult {
  draft: PipelineDraft;
  /**
   * Present only when the loop was exhausted (`attempts` reached `maxAttempts`)
   * while the draft still failed validation. Absent on a successful plan.
   */
  unresolvedValidationErrors?: GraphValidationIssue[];
  /**
   * Non-fatal degradations accumulated across every node of the run (D7 —
   * appended, never overwritten). May be present alongside a successful
   * result (e.g. a spec whose schema could not be embedded in the design
   * prompt) or alongside `unresolvedValidationErrors`.
   */
  plannerWarnings?: string[];
  attempts: number;
}
