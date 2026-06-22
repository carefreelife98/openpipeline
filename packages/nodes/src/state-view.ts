import type {
  PipelineStateType,
  PipelineMeta,
  PipelineOutputs,
  NodeMetaMap,
  NodeEvent,
  CostBundle,
} from '@openpipeline/core';

/**
 * Concrete, type-checked view of the run state.
 *
 * Why this exists: `@openpipeline/core` exports `PipelineStateAnnotation` as
 * `any` on purpose — it keeps LangGraph's internal `StateGraph` generics off the
 * public `.d.ts` surface (cross-package portability). The cost is that the
 * derived `PipelineStateType` collapses to `any`, so every `state.meta` /
 * `state.outputs` access inside the kernel would be untyped.
 *
 * This interface mirrors the annotation channels declared in
 * `core/src/state.ts` exactly, rebuilt from core's exported building blocks, so
 * the kernel reads state through real types instead of `any`.
 */
export interface PipelineState {
  meta: PipelineMeta;
  outputs: PipelineOutputs;
  nodeMeta: NodeMetaMap;
  cost: CostBundle;
  events: NodeEvent[];
}

/**
 * The single, sanctioned boundary between LangGraph's `any`-typed state and the
 * type-checked kernel. LangGraph invokes node runners with the runtime value
 * produced by `PipelineStateAnnotation`, whose channels are exactly
 * {@link PipelineState}; this asserts that contract once, in one named place,
 * instead of scattering casts at every access site.
 */
export function toPipelineState(state: PipelineStateType): PipelineState {
  return state;
}
