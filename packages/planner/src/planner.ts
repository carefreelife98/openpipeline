import { END, START, StateGraph } from '@langchain/langgraph';
import { NOOP_LOGGER, type CatalogLoader, type McpNodeResolver } from '@openpipeline/core';

import { checkAbort } from './abort.js';
import { correctNode } from './nodes/correct.node.js';
import { designNode } from './nodes/design.node.js';
import { intentNode } from './nodes/intent.node.js';
import { selectNode } from './nodes/select.node.js';
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
 * Exported (not just used internally) so `state.test.ts` can narrow the same
 * `StateGraph(PlannerStateAnnotation).invoke()` erasure the same way, rather
 * than reaching for an unsound `as PlannerState`/`as unknown as PlannerState`
 * cast that would silently paper over a real structural mismatch (T2 review
 * Minor 6 / gate hole — this is exactly the kind of test-only type gap that
 * `tsconfig.test.json` now catches).
 */
export function readPlannerState(output: unknown): PlannerState {
  if (output !== null && typeof output === 'object' && 'instruction' in output) {
    return output as PlannerState;
  }
  throw new Error('[PipelinePlanner] unexpected LangGraph output shape from plan()');
}

/**
 * Builds a fresh compiled LangGraph for a single `plan()` call (D2).
 *
 * Two topologies, chosen by whether `runtime.catalogLoader`/`mcpNodeResolver`
 * are both set (the constructor guarantees they are set together or neither
 * is — see {@link PipelinePlanner}'s constructor):
 *
 * - No catalog: `START -> design -> validate -> correct -> (design | end)` —
 *   T1's original loop, byte-for-byte unchanged in shape.
 * - Catalog configured: `START -> intent -> (select | design)`, `select ->
 *   design` unconditionally, and `correct -> (select | design | end)` — D2's
 *   `intent`/`select` nodes only ever exist in the compiled graph on this
 *   path, so `select` genuinely cannot run without a catalog (matches
 *   `select.node.ts`'s `requireCatalogDeps` defensive guard: reaching it any
 *   other way is a wiring bug, not a reachable runtime state).
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
// PlannerState` inside the closure. Built imperatively (statement-by-statement
// on one `const graph`, not a single reassigned fluent chain) so the two
// topologies can share the common nodes/edges — `compiler.ts` uses the same
// imperative style for its own conditionally-shaped graph — which means node
// names lose the fluent chain's own literal-type tracking the same way
// `compiler.ts`'s dynamic node ids do, so every node-name string argument
// below is `as never` too, not just the handler/router closures.
function buildPlannerGraph(runtime: PlannerRuntime, maxAttempts: number) {
  const intent = (state: PlannerState) => intentNode(state, runtime);
  const select = (state: PlannerState) => selectNode(state, runtime);
  const design = (state: PlannerState) => designNode(state, runtime);
  const validate = (state: PlannerState) => validateNode(state, runtime);
  const correct = (state: PlannerState) => correctNode(state, runtime, maxAttempts);

  // D2: `needsMcp: false` skips `select` (and therefore its catalog load and
  // its LLM call) entirely.
  const routeAfterIntent = (state: PlannerState) =>
    state.needsMcp === false ? 'design' : 'select';
  // T1 review round 3, M6: a schema-parse failure has no `PlannerDraft` to
  // build a `PipelineWithGraph` from, so `validate` can't run at all for this
  // round — route straight to `correct` instead. `designNode` sets
  // `designError` if and only if THIS attempt failed to parse, and
  // unconditionally clears it back to `undefined` on every successful parse
  // (mirroring `designFeedback`'s own clearing discipline), so it can never
  // be stale here.
  const routeAfterDesign = (state: PlannerState) =>
    state.designError !== undefined ? 'correct' : 'validate';
  const routeAfterValidate = (state: PlannerState) =>
    state.validationIssues.length === 0 ? 'end' : 'correct';
  // Trusts `correctNode`'s own continue/stop/target decision instead of
  // re-deriving it from `state.attempts` here. Conditional-edge routers only
  // ever observe state *after* the preceding node's update has been merged,
  // so re-checking `attempts >= maxAttempts` on the post-update value would
  // go stale on the very last permitted round: correctNode gates on the
  // OLD (pre-increment) `attempts` (see its doc comment / T1 review I3), so
  // the round where `attempts` becomes exactly `maxAttempts` is precisely
  // the round it just decided TO continue on — re-checking `>=` here would
  // wrongly end the run one `design` call early, right back into the same
  // off-by-one this was fixing. `correctTarget` is a reliable proxy instead
  // (D2b): `correctNode` sets it to `'design'`/`'select'` if and only if it
  // decided to continue (and to which node), and unconditionally clears it
  // back to `undefined` when exhausted, so it can never be stale here.
  const routeAfterCorrect = (state: PlannerState) => state.correctTarget ?? 'end';

  const catalogPathActive =
    runtime.catalogLoader !== undefined && runtime.mcpNodeResolver !== undefined;

  const graph = new StateGraph(PlannerStateAnnotation)
    .addNode('design' as never, design as never)
    .addNode('validate' as never, validate as never)
    .addNode('correct' as never, correct as never);

  if (catalogPathActive) {
    graph.addNode('intent' as never, intent as never);
    graph.addNode('select' as never, select as never);
  }

  graph.addEdge(START, (catalogPathActive ? 'intent' : 'design') as never);

  if (catalogPathActive) {
    graph.addConditionalEdges(
      'intent' as never,
      routeAfterIntent as never,
      {
        design: 'design',
        select: 'select',
      } as never
    );
    graph.addEdge('select' as never, 'design' as never);
  }

  graph.addConditionalEdges(
    'design' as never,
    routeAfterDesign as never,
    {
      validate: 'validate',
      correct: 'correct',
    } as never
  );
  graph.addConditionalEdges(
    'validate' as never,
    routeAfterValidate as never,
    {
      end: END,
      correct: 'correct',
    } as never
  );
  graph.addConditionalEdges(
    'correct' as never,
    routeAfterCorrect as never,
    (catalogPathActive
      ? { end: END, design: 'design', select: 'select' }
      : { end: END, design: 'design' }) as never
  );

  return graph.compile();
}

/**
 * D1's public API: turns a natural-language instruction into a validated
 * `PipelineDraft` via an LLM-driven design -> validate -> correct loop.
 *
 * `specs` (static TOOL/LLM/IF `NodeSpec`s) is always required. `catalogLoader`
 * and `mcpNodeResolver` (D2's `intent -> select` MCP tool-selection routing)
 * are optional but MUST be provided together — the constructor throws a clear
 * error if only one is supplied, since neither one alone is enough to load a
 * catalog AND resolve a selection from it. Passing neither keeps the graph
 * exactly the no-MCP `design -> validate -> correct` loop T1 shipped.
 */
export class PipelinePlanner {
  private readonly llmFactory: PipelinePlannerOptions['llmFactory'];
  private readonly modelId: string;
  private readonly specsInput: PipelinePlannerOptions['specs'];
  private readonly maxAttempts: number;
  private readonly temperature: number;
  private readonly logger: NonNullable<PipelinePlannerOptions['logger']>;
  private readonly catalogLoader?: CatalogLoader;
  private readonly mcpNodeResolver?: McpNodeResolver;

  constructor(options: PipelinePlannerOptions) {
    const hasCatalogLoader = options.catalogLoader !== undefined;
    const hasMcpNodeResolver = options.mcpNodeResolver !== undefined;
    // D2: the MCP-catalog path needs BOTH a way to load the catalog and a way
    // to resolve a selection from it into a NodeSpec — one without the other
    // can never produce a usable `select` node, so it's rejected up front
    // instead of silently degrading (e.g. loading a catalog that can never be
    // turned into specs, or resolving specs no catalog ever offered).
    if (hasCatalogLoader !== hasMcpNodeResolver) {
      const supplied = hasCatalogLoader ? 'catalogLoader' : 'mcpNodeResolver';
      const missing = hasCatalogLoader ? 'mcpNodeResolver' : 'catalogLoader';
      throw new Error(
        `[PipelinePlanner] catalogLoader and mcpNodeResolver must be provided together to enable ` +
          `the MCP tool-selection (intent -> select) path (D2) — only ${supplied} was supplied; ` +
          `${missing} is also required. Provide both, or neither for the static-specs-only path.`
      );
    }
    if (!options.modelId) {
      throw new Error('[PipelinePlanner] modelId is required (D8 — no vendor default).');
    }

    this.llmFactory = options.llmFactory;
    this.modelId = options.modelId;
    this.specsInput = options.specs;
    this.catalogLoader = options.catalogLoader;
    this.mcpNodeResolver = options.mcpNodeResolver;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    // T1 review round 3, I1-R3: `maxAttempts` used to flow unvalidated into
    // BOTH loop-stop conditions (`correct.node.ts`'s `state.attempts >=
    // maxAttempts` gate and `recursionLimit: maxAttempts * 3 + 2` below) —
    // poisoning it broke both simultaneously instead of just one. `NaN` is
    // the realistic path (`Number(unset/non-numeric env var)`; `??` does NOT
    // default `NaN`, only `null`/`undefined`): `attempts >= NaN` is always
    // `false` and `recursionLimit: NaN` never trips LangGraph's own check
    // either, so the planner called the model forever, at real cost, with no
    // error. `0`/negative/non-integer values are the same class of bug in
    // the other direction (an internal LangGraph `GraphRecursionError` or
    // `recursionLimit` rejection instead of the documented `PlannerResult`).
    // One guard closes all of them.
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('[PipelinePlanner] maxAttempts must be an integer >= 1.');
    }
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

    const catalogPathActive =
      this.catalogLoader !== undefined && this.mcpNodeResolver !== undefined;

    const runtime: PlannerRuntime = {
      llmFactory: this.llmFactory,
      modelId: this.modelId,
      temperature: this.temperature,
      specs,
      catalog,
      logger: this.logger,
      signal: request.signal,
      onProgress: request.onProgress,
      // D2: `context` bases both `catalogLoader.load(ctx)` and
      // `mcpNodeResolver.resolveSpec(key, ctx)`'s `ctx` — an empty object on
      // the no-MCP path (never read there) and whenever a caller omits
      // `request.context`. `mcpCatalogBox` starts empty every `plan()` call
      // (never reused across calls) — `select.node.ts` populates `.loaded` at
      // most once per call, and the `finally` below reads it back after
      // `app.invoke()` settles to guarantee `cleanup()` fires exactly once.
      context: request.context ?? {},
      mcpCatalogBox: {},
      catalogLoader: this.catalogLoader,
      mcpNodeResolver: this.mcpNodeResolver,
    };

    const app = buildPlannerGraph(runtime, this.maxAttempts);
    // Each design/correction round costs 3 LangGraph super-steps on the
    // no-MCP path (design -> validate -> correct) or 4 on the MCP-catalog
    // path (select -> design -> validate -> correct — D2b's routing
    // extension can send `correct` back to `select`, so every round has to
    // budget for a `select` super-step even though a given round might not
    // actually spend it), so a run bounded by `maxAttempts` needs ~3 (or 4) *
    // maxAttempts super-steps in the worst case (always-invalid drafts, every
    // round routes validate -> correct -> design/select again). LangGraph's
    // default `recursionLimit` is 25, which silently caps out around
    // `maxAttempts = 8` (no-MCP) or `maxAttempts = 6` (MCP) and throws an
    // opaque `GraphRecursionError` instead of the documented exhaustion
    // `PlannerResult` (T1 review round 2, I1) — derive an explicit limit from
    // the already-known loop bound instead of trusting the library default.
    // The trailing `+2`/`+3` covers `START -> design`/`START -> intent -> select`
    // and a final `correct -> END` super-step.
    const superStepsPerRound = catalogPathActive ? 4 : 3;
    const recursionLimitSlack = catalogPathActive ? 3 : 2;
    let finalState: PlannerState;
    // T2 review Important 2: a `cleanup()` rejection must never replace the
    // `try` block's own outcome — per JS semantics an unguarded `await` in a
    // `finally` throws and REPLACES whatever the `try` produced, silently
    // discarding a completed draft on the success path or masking
    // `PipelineAbortedError`/a genuine LLM failure on the failure path (the
    // package's own tests, and callers, rely on `err instanceof
    // PipelineAbortedError` still working). Declared outside the try/finally
    // so it survives into the success-path result below; stays `undefined`
    // whenever cleanup either never ran or succeeded.
    let cleanupWarning: string | undefined;
    try {
      const rawOutput: unknown = await app.invoke(
        { instruction: request.instruction, plannerWarnings: catalog.warnings },
        { recursionLimit: this.maxAttempts * superStepsPerRound + recursionLimitSlack }
      );
      finalState = readPlannerState(rawOutput);
    } finally {
      // D2: guaranteed exactly once per `plan()` call, on EVERY exit path —
      // success, a thrown error (e.g. an LLM failure mid-run), or a
      // `PipelineAbortedError` from `checkAbort` — by reading the SAME
      // `mcpCatalogBox` reference `select.node.ts` populates, rather than
      // making `select` (or any other node) responsible for its own cleanup:
      // `select` may run more than once per `plan()` call (D2b's
      // correct-routing extension), and cleanup must fire only once, after
      // the whole run settles, never after every individual `select` entry.
      // A no-op on the no-MCP path and on any run where `select` never ran
      // (`needsMcp: false`, or `catalogLoader`/`mcpNodeResolver` weren't
      // configured) — `.loaded` is `undefined` in both cases.
      //
      // Its OWN try/catch (T2 review Important 2): a rejecting `cleanup()`
      // (e.g. an MCP transport whose socket the server already closed) is
      // never silent (always `logger.warn`) but also never allowed to
      // propagate out of this `finally` — see the doc comment above.
      try {
        await runtime.mcpCatalogBox.loaded?.cleanup();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[PipelinePlanner] MCP catalog cleanup() failed after plan() settled: ${reason}`,
          err
        );
        cleanupWarning = `[planner] MCP catalog cleanup failed after the run completed: ${reason}`;
      }
    }

    if (!finalState.draft) {
      // Reachable in exactly one case since T1 review round 3's M6 fix:
      // EVERY attempt, including the last, failed `PlannerDraftSchema.parse`
      // (a schema-shape defect, never a graph-structure one — see
      // `designNode`/`routeAfterDesign`), so no `PlannerDraft` was ever
      // produced to validate or return. Per the review's "unresolvedValidationErrors
      // entry or a clear error — pick the existing exhaustion shape": there is
      // no draft here to attach `unresolvedValidationErrors` to, so this
      // throw — an EXISTING shape, not a new one — is the one that applies;
      // it also still covers the (structurally unreachable via the graph
      // wired in buildPlannerGraph) defensive case of a wiring regression.
      throw new Error('[PipelinePlanner] planning finished with no draft produced.');
    }

    // T2 review Important 2: surface a rejecting cleanup() on the success
    // path as a warning rather than silently swallowing it (it was already
    // logged via `logger.warn` above) — appended after `finalState`'s own
    // warnings, never replacing them.
    const plannerWarnings = cleanupWarning
      ? [...finalState.plannerWarnings, cleanupWarning]
      : finalState.plannerWarnings;

    return {
      draft: finalState.draft,
      attempts: finalState.attempts,
      unresolvedValidationErrors:
        finalState.validationIssues.length > 0 ? finalState.validationIssues : undefined,
      plannerWarnings: plannerWarnings.length > 0 ? plannerWarnings : undefined,
    };
  }
}
