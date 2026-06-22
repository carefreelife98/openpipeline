import { z } from 'zod';
import {
  computeAncestors,
  computeRemainingSchema,
  toPipelineError,
  createCostAccumulator,
  PipelineAbortedError,
  PipelineNodeExecutionError,
  NOOP_LOGGER,
  type NodeMeta,
  type NodeSpec,
  type PipelineStateType,
  type NodeInputs,
  type PipelineNodeOutput,
  type NodeExecutionContext,
  type NodeEvent,
  type CostBundle,
  type CostAccumulator,
  type PipelineNodeRow,
  type CompiledNode,
  type LlmFactory,
  type StepRecorder,
  type Logger,
} from '@openpipeline/core';
import type { ValueBindingResolver } from './value-binding-resolver.js';
import type { AutoParamResolver } from './auto-param-resolver.js';

export interface NodeRunnerDeps {
  bindingResolver: Pick<ValueBindingResolver, 'resolveExplicit'>;
  stepRecorder: Pick<StepRecorder, 'start' | 'finish'>;
  llmFactory: LlmFactory;
  logger?: Logger;
  /** Optional — required only if any node uses `auto` bindings. */
  autoParamResolver?: AutoParamResolver;
  /** Topology-filtered map, filled by the compiler. */
  nodeMap: ReadonlyMap<string, CompiledNode>;
}

/**
 * Per-run AbortSignal arrives via RunnableConfig.configurable (not a closure),
 * because compiled graphs are cached and a closure would leak a stale signal.
 */
interface NodeRunnerConfig {
  configurable?: { signal?: AbortSignal };
}

export type NodeRunnerFn = (
  state: PipelineStateType,
  config?: NodeRunnerConfig
) => Promise<Partial<PipelineStateType>>;

export function makeNodeRunner(
  node: PipelineNodeRow,
  spec: NodeSpec,
  deps: NodeRunnerDeps
): NodeRunnerFn {
  const logger = deps.logger ?? NOOP_LOGGER;

  return async (
    state: PipelineStateType,
    config?: NodeRunnerConfig
  ): Promise<Partial<PipelineStateType>> => {
    const signal = config?.configurable?.signal;

    const stepId = await deps.stepRecorder.start({
      runId: state.meta.runId,
      nodeId: node.id,
      nodeLabel: node.label,
    });

    const startedAt = new Date().toISOString();
    const events: NodeEvent[] = [
      { nodeId: node.id, eventKind: 'NODE_START', timestamp: startedAt, payload: null },
    ];

    try {
      checkAbort(signal);

      const inputs = (node.inputs as NodeInputs) ?? {};
      const explicit = deps.bindingResolver.resolveExplicit(inputs, state, {
        nodeId: node.id,
        nodeLabel: node.label,
      });

      checkAbort(signal);

      const autoSlots = Object.entries(inputs)
        .filter(([, b]) => b.kind === 'auto')
        .map(([n]) => n);

      const costAcc = createCostAccumulator();
      let resolved: Record<string, unknown> = explicit;

      if (autoSlots.length > 0) {
        if (!deps.autoParamResolver) {
          throw new Error(
            `Node "${node.label}" has auto-bound slots [${autoSlots.join(', ')}] but no AutoParamResolver was provided.`
          );
        }
        // remainingSchema must contain ONLY the auto slots. Omit explicit and
        // unspecified keys — leaving unspecified keys would let the resolver
        // fill optional slots and override the author's intent (unset = default).
        const allInputKeys =
          spec.inputSchema instanceof z.ZodObject
            ? Object.keys((spec.inputSchema as z.ZodObject).shape)
            : [];
        const keysToOmit = allInputKeys.filter((k) => !autoSlots.includes(k));
        const remainingSchema = computeRemainingSchema(spec.inputSchema, keysToOmit);

        const filled = await deps.autoParamResolver.resolve({
          runId: state.meta.runId,
          nodeId: node.id,
          nodeLabel: node.label,
          remainingSchema,
          explicitContext: explicit,
          predecessorOutputs: extractPredecessorOutputs(state, node.id, deps.nodeMap),
          parentStepId: stepId,
          pipelineName: state.meta.pipelineName ?? '',
          pipelineDescription: state.meta.pipelineDescription ?? '',
          signal,
        });
        costAcc.add(filled.cost);
        resolved = { ...explicit, ...filled.params };
      }

      checkAbort(signal);
      const parsed = spec.inputSchema.parse(resolved);

      checkAbort(signal);
      const ctx = buildExecutionContext(node, state, stepId, deps, costAcc, signal, logger);
      const output = await spec.handler(parsed as never, ctx);

      checkAbort(signal);
      const validatedOutput = spec.outputSchema.parse(output) as PipelineNodeOutput;

      const finishedAt = new Date().toISOString();
      const totalCost = costAcc.total();

      await deps.stepRecorder.finish(stepId, {
        status: 'SUCCESS',
        input: parsed,
        output: validatedOutput,
        cost: totalCost,
      });

      const meta: NodeMeta = { status: 'SUCCESS', startedAt, finishedAt };
      events.push({ nodeId: node.id, eventKind: 'NODE_END', timestamp: finishedAt, payload: null });

      return {
        outputs: { [node.id]: validatedOutput },
        nodeMeta: { [node.id]: meta },
        cost: totalCost,
        events,
      };
    } catch (err) {
      const pipelineError = toPipelineError(err);
      logger.error(
        `[NodeRunner] node FAILED: ${node.label} (id=${node.id.slice(0, 8)}, key=${node.key}) — ` +
          `${pipelineError.kind}/${pipelineError.code}: ${pipelineError.message?.slice(0, 2000) ?? '(no message)'}`
      );
      if (stepId) {
        try {
          await deps.stepRecorder.finish(stepId, { status: 'FAILED', error: pipelineError });
        } catch (finishErr) {
          logger.warn('[NodeRunner] failed to record FAILED step', { stepId, finishErr });
        }
      }
      throw new PipelineNodeExecutionError(node.id, pipelineError);
    }
  };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PipelineAbortedError();
}

function buildExecutionContext(
  node: PipelineNodeRow,
  state: PipelineStateType,
  stepId: string,
  deps: NodeRunnerDeps,
  costAcc: CostAccumulator,
  signal: AbortSignal | undefined,
  logger: Logger
): NodeExecutionContext {
  return {
    nodeId: node.id,
    nodeLabel: node.label,
    stepId,
    runId: state.meta.runId,
    pipelineId: state.meta.pipelineId,
    deliveryMode: state.meta.deliveryMode,
    context: state.meta.context,
    signal,
    emit: (_event: NodeEvent) => {
      // Phase 1: events are returned at node end; in-handler emit is a best-effort stub.
    },
    createChildStep: async () => ({ childStepId: '' }),
    finishChildStep: async () => undefined,
    reportCost: (c: CostBundle) => costAcc.add(c),
    createLLM: (modelId, overrides) => deps.llmFactory.createModel(modelId, overrides),
    logger,
    mcpCatalogCache: state.meta.mcpCatalogCache,
  };
}

function extractPredecessorOutputs(
  state: PipelineStateType,
  selfNodeId: string,
  nodeMap: ReadonlyMap<string, CompiledNode>
): PipelineStateType['outputs'] {
  const ancestors = computeAncestors(selfNodeId, nodeMap);
  const filtered: PipelineStateType['outputs'] = {};
  for (const ancestorId of ancestors) {
    if (state.outputs[ancestorId] !== undefined) {
      filtered[ancestorId] = state.outputs[ancestorId];
    }
  }
  return filtered;
}
