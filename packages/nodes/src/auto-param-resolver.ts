import type { CostBundle, PipelineOutputs } from '@openpipeline/core';
import type { z } from 'zod';

export interface AutoParamResolveRequest {
  runId: string;
  nodeId: string;
  nodeLabel: string;
  /** Schema containing only the `auto` slots still to fill. */
  remainingSchema: z.ZodType;
  /** Already-resolved explicit inputs, for context. */
  explicitContext: Record<string, unknown>;
  /** Outputs of ancestor nodes, for context. */
  predecessorOutputs: PipelineOutputs;
  parentStepId: string;
  pipelineName: string;
  pipelineDescription: string;
  signal?: AbortSignal;
}

export interface AutoParamResolveResult {
  params: Record<string, unknown>;
  cost: CostBundle;
}

/**
 * Fills `auto` input slots with an LLM at runtime. Optional: graphs that use no
 * `auto` bindings never need one. A reference implementation can be built on the
 * LlmFactory; OpenPipeline core does not bundle one (it would couple to a
 * provider + needs a cost cap — see the plan's follow-ups).
 */
export interface AutoParamResolver {
  resolve(req: AutoParamResolveRequest): Promise<AutoParamResolveResult>;
}
