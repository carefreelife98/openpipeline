import { Annotation } from '@langchain/langgraph';
import type { AnnotationRoot, StateDefinition } from '@langchain/langgraph';
import type { PipelineDraft } from '@openpipeline/core';
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
