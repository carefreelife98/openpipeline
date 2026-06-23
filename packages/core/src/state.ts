import { Annotation } from '@langchain/langgraph';
import type { AnnotationRoot, StateDefinition } from '@langchain/langgraph';

import { ZERO_COST, mergeCost, type CostBundle } from './cost.js';
import type { RunDeliveryMode } from './enums.js';
import type { PipelineOutputs } from './node-output.js';

/**
 * Minimal, host-supplied context for a run. Replaces Mate-X's `SessionData`
 * (Flow OAuth + company). All fields are optional; multi-tenancy (companyId,
 * scope) is intentionally absent from core. A host that needs per-user MCP
 * tokens supplies `getOAuthToken`.
 */
export interface RunContext {
  /** Opaque audit id. No FK, no tenancy semantics in core. */
  userId?: string;
  /** Opaque tenant id for hosts that implement multi-tenant adapters. */
  tenantId?: string;
  /** Resolve a pre-obtained OAuth token for an MCP provider, if the host has one. */
  getOAuthToken?(service: string): Promise<string | undefined> | string | undefined;
}

export interface PipelineMeta {
  runId: string;
  pipelineId: string;
  /** User-facing pipeline name — exposed to the resolver LLM for whole-pipeline context. */
  pipelineName: string;
  /** User-authored pipeline description, or "". */
  pipelineDescription: string;
  deliveryMode: RunDeliveryMode;
  context?: RunContext;
  /**
   * Per-run MCP catalog cache. The runtime loads it once at run start (only if
   * the graph has MCP nodes) and flows it through the state so the LRU compile
   * cache never holds a stale closure. Typed as `unknown[]` so core stays free
   * of MCP adapter types; the MCP package casts it.
   */
  mcpCatalogCache?: readonly unknown[];
}

// ── Node meta ────────────────────────────────────────────────────────────────

export type NodeExecutionStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ABORTED';

export interface NodeMeta {
  status: NodeExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  error?: PipelineError;
}

export type NodeMetaMap = Record<string, NodeMeta>;

// ── Events ────────────────────────────────────────────────────────────────────

export type NodeEventKind =
  | 'NODE_START'
  | 'NODE_OUTPUT'
  | 'NODE_END'
  | 'NODE_FAILED'
  | 'RESOLVER_START'
  | 'RESOLVER_END'
  | 'LLM_CHUNK';

export interface NodeEvent {
  nodeId: string;
  eventKind: NodeEventKind;
  timestamp: string;
  payload: unknown;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export type PipelineErrorKind =
  | 'VALIDATION'
  | 'NODE_EXECUTION'
  | 'RESOLVER'
  | 'COMPILE'
  | 'RUNTIME'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'COST_CAP';

export interface PipelineError {
  kind: PipelineErrorKind;
  code: string;
  message: string;
  nodeId?: string;
  stack?: string;
}

// ── LangGraph annotation ───────────────────────────────────────────────────────

/**
 * The concrete run-state shape that flows through the compiled LangGraph. This
 * is the single source of truth for `PipelineStateType` — hand-written (rather
 * than inferred from the annotation below via `typeof annotation.State`) so that
 *
 *  1. the public `.d.ts` surface stays free of LangGraph's deep channel generics
 *     (the original portability concern), and
 *  2. consumers get a real, fully-typed state instead of `any`.
 *
 * It must stay in lock-step with the channels declared in
 * {@link PipelineStateAnnotation}.
 */
export interface PipelineState {
  meta: PipelineMeta;
  outputs: PipelineOutputs;
  nodeMeta: NodeMetaMap;
  cost: CostBundle;
  events: NodeEvent[];
}

// The channel spec backing `PipelineState`. Each `Annotation<T>(...)` binds the
// channel's value type to the matching field of `PipelineState`, and the reducer
// params are explicitly typed so the merge logic stays fully type-checked.
//
// `default` seeds every reduced channel, so LangGraph always invokes these
// reducers with a defined accumulator — no `existing ?? …` guard is needed.
const pipelineStateSpec: StateDefinition = {
  meta: Annotation<PipelineMeta>(),

  outputs: Annotation<PipelineOutputs>({
    value: (existing: PipelineOutputs, updates: PipelineOutputs): PipelineOutputs => ({
      ...existing,
      ...updates,
    }),
    default: (): PipelineOutputs => ({}),
  }),

  nodeMeta: Annotation<NodeMetaMap>({
    value: (existing: NodeMetaMap, updates: NodeMetaMap): NodeMetaMap => ({
      ...existing,
      ...updates,
    }),
    default: (): NodeMetaMap => ({}),
  }),

  cost: Annotation<CostBundle>({
    value: (existing: CostBundle, updates: CostBundle): CostBundle => mergeCost(existing, updates),
    default: (): CostBundle => ZERO_COST,
  }),

  events: Annotation<NodeEvent[]>({
    value: (existing: NodeEvent[], updates: NodeEvent[]): NodeEvent[] => [...existing, ...updates],
    default: (): NodeEvent[] => [],
  }),
};

/**
 * The LangGraph annotation whose channels back `PipelineState`.
 *
 * The exported type is the base `AnnotationRoot<StateDefinition>` — the erased
 * form LangGraph itself uses (e.g. `AnnotationRoot.isInstance`) — rather than the
 * deeply-inferred per-channel generic. This is the intentional "shield": it keeps
 * LangGraph's per-channel generics off the public `.d.ts` surface (the original
 * portability concern) and lets `StateGraph` consumers adopt the annotation
 * without coupling to the exact inferred `StateType`. It replaces the prior
 * `: any`, which collapsed every consumer's `PipelineStateType` to `any`.
 *
 * Consumers should program against the concrete, fully-typed `PipelineState` /
 * `PipelineStateType` for run-state access; the annotation value exists only to
 * construct the `StateGraph`.
 */
export const PipelineStateAnnotation: AnnotationRoot<StateDefinition> =
  Annotation.Root(pipelineStateSpec);

export type PipelineStateType = PipelineState;
