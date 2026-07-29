import { Annotation } from '@langchain/langgraph';
import type { AnnotationRoot, StateDefinition } from '@langchain/langgraph';
import type { NodeSpec, PipelineDraft } from '@openpipeline/core';
import type { GraphValidationIssue } from '@openpipeline/nodes';

/**
 * The concrete run-state shape that flows through the compiled planner
 * LangGraph. Hand-written (not inferred from the annotation below) for the
 * same reason `@openpipeline/core`'s `PipelineState` is: it keeps LangGraph's
 * deep channel generics off internal call sites while still giving real
 * type-safety instead of `any`. Must stay in lock-step with
 * {@link PlannerStateAnnotation}.
 */
export interface PlannerState {
  instruction: string;
  /**
   * Attempt counter. Starts at 1 (the first `design` call IS attempt 1) and is
   * incremented only by the `correct` node (D2: "correct: attempts++"). A
   * successful plan with zero corrections reports `attempts === 1`.
   *
   * Always equals the number of `design` calls actually made, whether the
   * run ends by validating cleanly or by exhausting `maxAttempts` — see
   * `correct.node.ts`'s doc comment (T1 review I3) for why the gate against
   * `maxAttempts` runs BEFORE this increment rather than after: checking
   * post-increment (`attempts++` then `attempts >= maxAttempts`) makes the
   * happy-path and exhaustion-path meanings of this field diverge (design-call
   * count vs. design-call-count-plus-one) and silently caps the loop at
   * `maxAttempts - 1` actual `design` calls. With the pre-increment gate,
   * `maxAttempts` design calls are made in total, so `maxAttempts: 1` means
   * "no corrections" and `maxAttempts: 2` means "one correction round" (never
   * a dead setting identical to `maxAttempts: 1`).
   */
  attempts: number;
  /**
   * Short id (LLM-facing, e.g. "n1") -> persisted UUID. Merged (never
   * replaced) across attempts so a short id the model reuses in a correction
   * round keeps the exact same UUID (D4).
   */
  idMap: Record<string, string>;
  draft?: PipelineDraft;
  /** Last validation pass's issues. Empty once/if the draft becomes valid. */
  validationIssues: GraphValidationIssue[];
  /**
   * Warnings accumulated across every node of the run. APPEND semantics (D7)
   * — never last-write-wins.
   */
  plannerWarnings: string[];
  /** Human-readable, short-id-rewritten feedback for the next `design` call. */
  designFeedback?: string;
  /**
   * Set (to a short diagnostic string) by `design` when the LLM's structured
   * output failed `PlannerDraftSchema.parse` on THIS attempt — a schema-shape
   * defect, not a graph-structure one, so `validate` has nothing to check (no
   * `PlannerDraft` was ever produced) and is skipped entirely for this round
   * (T1 review round 3, M6: previously this rejected `plan()` outright with a
   * raw `ZodError`, unrecoverable, unlike every graph-level defect which gets
   * `maxAttempts` tries). `buildPlannerGraph`'s `routeAfterDesign` reads this
   * to route straight to `correct`. Unconditionally cleared back to
   * `undefined` by `design` on every run (success or failure) so it can never
   * go stale — mirrors `designFeedback`'s own clearing discipline.
   */
  designError?: string;

  // ── T2: MCP-catalog path (intent -> select) — only populated when the
  // planner is constructed with `catalogLoader`/`mcpNodeResolver` (D2). Every
  // field below stays `undefined`/empty on the no-MCP path; nothing here
  // changes the no-catalog graph's behavior.

  /** `intent`'s one-line summary of what the instruction is asking for. */
  taskSummary?: string;
  /** `intent`'s decision: does fulfilling this instruction need an MCP tool? `false` skips `select` entirely. */
  needsMcp?: boolean;
  /** `intent`'s hint of which MCP provider keys are likely relevant — informational, not enforced by `select`. */
  candidateProviderKeys?: string[];
  /**
   * `NodeSpec`s synthesized by `mcpNodeResolver.resolveSpec` for each of
   * `select`'s model-chosen, catalog-validated `mcp:<provider>:<tool>` keys
   * that resolved successfully (fail-soft per key — D2). Merged with
   * `runtime.specs` by `design`/`validate` so the design catalog and graph
   * validation both recognize the selected MCP tools. Left untouched (not
   * reset) by an empty D2b re-selection round so an earlier round's resolved
   * specs survive (T2 review Minor 4) — see `select.node.ts`.
   */
  mcpSpecs?: NodeSpec[];
  /**
   * Pre-rendered catalog text for {@link mcpSpecs}, built once by `select`
   * (not re-derived by `design` on every attempt) for the same
   * duplicate-warning reason `runtime.catalog` is computed once per `plan()`
   * call rather than once per `design` attempt (T1 review round 2, I3).
   */
  mcpCatalogText?: string;
  /**
   * Set by `correct` on every call it makes (never omitted — mirrors
   * `designFeedback`'s clearing discipline so a stale value can never
   * survive): `'design'` or `'select'` when continuing (D2b's routing
   * extension: an unresolved `mcp:` key routes back to `select` instead of
   * `design`, catalog path only), `undefined` when exhausted. `routeAfterCorrect`
   * reads this directly instead of re-deriving continue/stop/target from
   * `attempts`/`validationIssues` (same "trust the decision, don't recompute
   * on post-update state" reasoning as the original `designFeedback` proxy).
   */
  correctTarget?: 'design' | 'select';
}

const plannerStateSpec: StateDefinition = {
  instruction: Annotation<string>(),

  attempts: Annotation<number>({
    reducer: (_existing: number, update: number): number => update,
    default: (): number => 1,
  }),

  idMap: Annotation<Record<string, string>>({
    reducer: (
      existing: Record<string, string>,
      update: Record<string, string>
    ): Record<string, string> => ({ ...existing, ...update }),
    default: (): Record<string, string> => ({}),
  }),

  draft: Annotation<PipelineDraft | undefined>({
    reducer: (_existing: PipelineDraft | undefined, update: PipelineDraft | undefined) => update,
    default: (): PipelineDraft | undefined => undefined,
  }),

  validationIssues: Annotation<GraphValidationIssue[]>({
    reducer: (
      _existing: GraphValidationIssue[],
      update: GraphValidationIssue[]
    ): GraphValidationIssue[] => update,
    default: (): GraphValidationIssue[] => [],
  }),

  plannerWarnings: Annotation<string[]>({
    reducer: (existing: string[], update: string[]): string[] => [...existing, ...update],
    default: (): string[] => [],
  }),

  designFeedback: Annotation<string | undefined>({
    reducer: (_existing: string | undefined, update: string | undefined) => update,
    default: (): string | undefined => undefined,
  }),

  designError: Annotation<string | undefined>({
    reducer: (_existing: string | undefined, update: string | undefined) => update,
    default: (): string | undefined => undefined,
  }),

  taskSummary: Annotation<string | undefined>({
    reducer: (_existing: string | undefined, update: string | undefined) => update,
    default: (): string | undefined => undefined,
  }),

  needsMcp: Annotation<boolean | undefined>({
    reducer: (_existing: boolean | undefined, update: boolean | undefined) => update,
    default: (): boolean | undefined => undefined,
  }),

  candidateProviderKeys: Annotation<string[] | undefined>({
    reducer: (_existing: string[] | undefined, update: string[] | undefined) => update,
    default: (): string[] | undefined => undefined,
  }),

  mcpSpecs: Annotation<NodeSpec[] | undefined>({
    reducer: (_existing: NodeSpec[] | undefined, update: NodeSpec[] | undefined) => update,
    default: (): NodeSpec[] | undefined => undefined,
  }),

  mcpCatalogText: Annotation<string | undefined>({
    reducer: (_existing: string | undefined, update: string | undefined) => update,
    default: (): string | undefined => undefined,
  }),

  correctTarget: Annotation<'design' | 'select' | undefined>({
    reducer: (
      _existing: 'design' | 'select' | undefined,
      update: 'design' | 'select' | undefined
    ) => update,
    default: (): 'design' | 'select' | undefined => undefined,
  }),
};

/**
 * The LangGraph annotation whose channels back {@link PlannerState}. Typed as
 * the erased `AnnotationRoot<StateDefinition>` (mirroring
 * `@openpipeline/core`'s `PipelineStateAnnotation`) to keep LangGraph's
 * per-channel generics off the public surface; consumers inside this package
 * program against the concrete `PlannerState`.
 */
export const PlannerStateAnnotation: AnnotationRoot<StateDefinition> =
  Annotation.Root(plannerStateSpec);
