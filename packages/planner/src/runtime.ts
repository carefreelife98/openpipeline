import type { LlmFactory, Logger, NodeSpec } from '@openpipeline/core';

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
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (event: PlannerProgressEvent) => void;
}
