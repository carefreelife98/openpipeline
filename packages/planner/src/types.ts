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
   * MCP tool selection (T2 — an `intent -> select` step ahead of `design`).
   * Opt-in: MUST be provided together with {@link mcpNodeResolver} (the
   * constructor throws synchronously if only one of the two is supplied — see
   * {@link PipelinePlanner}'s doc comment). Omitting both keeps the exact
   * no-MCP `design -> validate -> correct` loop.
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
   * Passed through to `catalogLoader.load(context)` and
   * `mcpNodeResolver.resolveSpec(key, context)` on the MCP-catalog path (T2 —
   * see {@link PipelinePlannerOptions.catalogLoader}). Defaults to `{}` when
   * omitted. Never read on the no-MCP path — the no-catalog
   * design/validate/correct loop has no catalog to load and no use for it
   * (T1 review round 3, M3).
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
