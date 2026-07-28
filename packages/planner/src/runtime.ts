import type { LlmFactory, Logger, NodeSpec } from '@openpipeline/core';

import type { SpecCatalogResult } from './prompts.js';
import type { PlannerProgressEvent } from './types.js';

/**
 * Dependency bag closed over by every node function for a single `plan()`
 * call. Built fresh per call (planner graphs are cheap to construct and are
 * NOT cached/reused across calls — unlike `PipelineCompiler`'s LRU-cached
 * compiled pipelines, there is no cross-call state here worth caching), so a
 * closure is simpler and safer than threading everything through LangGraph's
 * `RunnableConfig.configurable` the way the per-run-cached execution kernel
 * has to.
 */
export interface PlannerRuntime {
  llmFactory: LlmFactory;
  modelId: string;
  temperature: number;
  specs: readonly NodeSpec[];
  /**
   * `buildSpecCatalogText(specs)`'s result, computed exactly once per
   * `plan()` call (in `PipelinePlanner.plan`, before the graph is invoked)
   * rather than once per `design` node execution. `specs` (and therefore this
   * catalog) is instruction-independent and identical on every attempt, so
   * recomputing it per attempt was both wasted `z.toJSONSchema` work and —
   * because `design.node.ts` used to return `catalog.warnings` into the
   * APPEND-semantics `plannerWarnings` channel on every call — the source of
   * one duplicate warning per attempt (T1 review round 2, I3). `design.node.ts`
   * reads `catalog.text` for the prompt and no longer re-derives or re-emits
   * `catalog.warnings` itself; `PipelinePlanner.plan` seeds them into the
   * graph's initial input exactly once instead.
   */
  catalog: SpecCatalogResult;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (event: PlannerProgressEvent) => void;
}
