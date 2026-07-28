import { END, START, StateGraph } from '@langchain/langgraph';
import { NOOP_LOGGER } from '@openpipeline/core';

import { checkAbort } from './abort.js';
import { correctNode } from './nodes/correct.node.js';
import { designNode } from './nodes/design.node.js';
import { validateNode } from './nodes/validate.node.js';
import { buildSpecCatalogText } from './prompts.js';
import type { PlannerRuntime } from './runtime.js';
import { PlannerStateAnnotation, type PlannerState } from './state.js';
import type { PipelinePlannerOptions, PlanRequest, PlannerResult } from './types.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TEMPERATURE = 0.3;

/**
 * Narrows a compiled planner graph's `unknown` `.invoke()` output to
 * {@link PlannerState} — mirrors `@openpipeline/runtime`'s `readFinalState`:
 * a real runtime guard (checking a discriminating field), not a blind cast.
 */
function readPlannerState(output: unknown): PlannerState {
  if (output !== null && typeof output === 'object' && 'instruction' in output) {
    return output as PlannerState;
  }
  throw new Error('[PipelinePlanner] unexpected LangGraph output shape from plan()');
}

/**
 * Builds a fresh compiled `design -> validate -> correct` LangGraph for a
 * single `plan()` call (D2). `catalogLoader`-driven `intent -> select`
 * routing is not implemented in this build — see {@link PipelinePlanner}'s
 * constructor, which rejects those options up front so this always builds
 * `START -> design`.
 */
// `PlannerStateAnnotation` is deliberately typed as the erased
// `AnnotationRoot<StateDefinition>` (see state.ts) — the same "shield"
// `@openpipeline/core`'s `PipelineStateAnnotation` uses to keep LangGraph's
// per-channel generics off the public surface. That erasure means
// `StateGraph`'s own inferred node/router parameter type is the generic
// `StateType<StateDefinition>`, not the concrete `PlannerState` these
// closures actually receive at runtime. `@openpipeline/nodes`'s
// `compiler.ts` hits the identical tension against `PipelineStateAnnotation`
// and resolves it the same way: a `never` cast at the `addNode` call site
// (`runner as never`) rather than fighting the erasure with an unsound `as
// PlannerState` inside the closure.
function buildPlannerGraph(runtime: PlannerRuntime, maxAttempts: number) {
  const design = (state: PlannerState) => designNode(state, runtime);
  const validate = (state: PlannerState) => validateNode(state, runtime);
  const correct = (state: PlannerState) => correctNode(state, runtime, maxAttempts);
  const routeAfterValidate = (state: PlannerState) =>
    state.validationIssues.length === 0 ? 'end' : 'correct';
  // Trusts `correctNode`'s own continue/stop decision instead of
  // re-deriving it from `state.attempts` here. Conditional-edge routers only
  // ever observe state *after* the preceding node's update has been merged,
  // so re-checking `attempts >= maxAttempts` on the post-update value would
  // go stale on the very last permitted round: correctNode gates on the
  // OLD (pre-increment) `attempts` (see its doc comment / T1 review I3), so
  // the round where `attempts` becomes exactly `maxAttempts` is precisely
  // the round it just decided TO continue on — re-checking `>=` here would
  // wrongly end the run one `design` call early, right back into the same
  // off-by-one this was fixing. `designFeedback` is a reliable proxy instead:
  // `correctNode` sets it if and only if it decided to continue, and
  // `designNode` unconditionally clears it back to `undefined` on every run,
  // so it can never be stale here.
  const routeAfterCorrect = (state: PlannerState) =>
    state.designFeedback !== undefined ? 'design' : 'end';

  return new StateGraph(PlannerStateAnnotation)
    .addNode('design', design as never)
    .addNode('validate', validate as never)
    .addNode('correct', correct as never)
    .addEdge(START, 'design')
    .addEdge('design', 'validate')
    .addConditionalEdges('validate', routeAfterValidate as never, { end: END, correct: 'correct' })
    .addConditionalEdges('correct', routeAfterCorrect as never, { end: END, design: 'design' })
    .compile();
}

/**
 * D1's public API: turns a natural-language instruction into a validated
 * `PipelineDraft` via an LLM-driven design -> validate -> correct loop.
 *
 * This build implements only the no-MCP path: `specs` must be static
 * (TOOL/LLM/IF) `NodeSpec`s, and the constructor throws if `catalogLoader` or
 * `mcpNodeResolver` is supplied — the `intent -> select` routing D2 describes
 * for MCP tool selection is a tracked follow-up (a real `select` LangGraph
 * node has to exist before `correct` can route selection-related errors to
 * it), not something this build silently degrades into ignoring a configured
 * catalog.
 */
export class PipelinePlanner {
  private readonly llmFactory: PipelinePlannerOptions['llmFactory'];
  private readonly modelId: string;
  private readonly specsInput: PipelinePlannerOptions['specs'];
  private readonly maxAttempts: number;
  private readonly temperature: number;
  private readonly logger: NonNullable<PipelinePlannerOptions['logger']>;

  constructor(options: PipelinePlannerOptions) {
    if (options.catalogLoader || options.mcpNodeResolver) {
      throw new Error(
        '[PipelinePlanner] catalogLoader/mcpNodeResolver-driven MCP tool selection is not ' +
          'implemented in this build (no-MCP path only, D2 intent/select nodes are a tracked ' +
          'follow-up). Construct without them.'
      );
    }
    if (!options.modelId) {
      throw new Error('[PipelinePlanner] modelId is required (D8 — no vendor default).');
    }

    this.llmFactory = options.llmFactory;
    this.modelId = options.modelId;
    this.specsInput = options.specs;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async plan(request: PlanRequest): Promise<PlannerResult> {
    checkAbort(request.signal);

    const specs = typeof this.specsInput === 'function' ? this.specsInput() : this.specsInput;
    if (specs.length === 0) {
      throw new Error(
        '[PipelinePlanner] no NodeSpecs were provided — the planner has nothing to design with.'
      );
    }

    // Computed once per `plan()` call, not once per `design` attempt (T1
    // review round 2, I3) — `specs` is fixed for the whole run, so both the
    // `z.toJSONSchema` work and the resulting `catalogWarnings` are identical
    // on every attempt. Seeded into the graph's initial input below instead
    // of being re-returned by `design.node.ts` on every call, so the
    // APPEND-semantics `plannerWarnings` channel (D7) receives each warning
    // exactly once per run rather than once per attempt.
    const catalog = buildSpecCatalogText(specs);

    const runtime: PlannerRuntime = {
      llmFactory: this.llmFactory,
      modelId: this.modelId,
      temperature: this.temperature,
      specs,
      catalog,
      logger: this.logger,
      signal: request.signal,
      onProgress: request.onProgress,
    };

    const app = buildPlannerGraph(runtime, this.maxAttempts);
    // Each design/correction round costs 3 LangGraph super-steps (design ->
    // validate -> correct), so a run bounded by `maxAttempts` needs ~3 *
    // maxAttempts super-steps in the worst case (always-invalid drafts,
    // every round routes validate -> correct -> design again). LangGraph's
    // default `recursionLimit` is 25, which silently caps out around
    // `maxAttempts = 8` and throws an opaque `GraphRecursionError` instead of
    // the documented exhaustion `PlannerResult` (T1 review round 2, I1) —
    // derive an explicit limit from the already-known loop bound instead of
    // trusting the library default. The `+ 2` covers START -> design and a
    // final correct -> END super-step.
    const rawOutput: unknown = await app.invoke(
      { instruction: request.instruction, plannerWarnings: catalog.warnings },
      { recursionLimit: this.maxAttempts * 3 + 2 }
    );
    const finalState = readPlannerState(rawOutput);

    if (!finalState.draft) {
      // Structurally unreachable via the graph wired in buildPlannerGraph
      // (design always runs, and always populates `draft`, before any path
      // can reach END) — kept as a defensive invariant check rather than an
      // `as PipelineDraft` cast that would hide a future wiring regression.
      throw new Error('[PipelinePlanner] planning finished with no draft produced.');
    }

    return {
      draft: finalState.draft,
      attempts: finalState.attempts,
      unresolvedValidationErrors:
        finalState.validationIssues.length > 0 ? finalState.validationIssues : undefined,
      plannerWarnings:
        finalState.plannerWarnings.length > 0 ? finalState.plannerWarnings : undefined,
    };
  }
}
