import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  NodeInputs,
  NodeSpec,
  PipelineDraft,
  PipelineEdgeRow,
  PipelineNodeRow,
} from '@openpipeline/core';

import { checkAbort } from '../abort.js';
import { applyAutoFill } from '../auto-fill.js';
import { buildIdAssignment, type IdAssignment } from '../id-map.js';
import { computeLayeredPositions } from '../layout.js';
import { mergeSpecs } from '../mcp-routing.js';
import { buildDesignPrompt, DESIGN_SYSTEM_PROMPT } from '../prompts.js';
import type { PlannerRuntime } from '../runtime.js';
import {
  classifyStructuredOutputError,
  describeStructuredOutputFailure,
  type StructuredOutputSchemaFailure,
} from '../schema-failure.js';
import { PlannerDraftSchema, type PlannerDraft, type PlannerDraftNode } from '../schema.js';
import type { PlannerState } from '../state.js';
import { asStructuredOutputModel } from '../structured-output.js';

const MAX_NAME_LENGTH = 80;

function derivePipelineName(instruction: string): string {
  const trimmed = instruction.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`;
}

/**
 * Rewrites a `state`-binding path's leading `outputs.<shortId>` segment to
 * `outputs.<uuid>`, using the same node-id-extraction pattern
 * `@openpipeline/nodes`'s graph-validator.ts uses for `REF_SOURCE_MISSING` /
 * `REF_NOT_PREDECESSOR` detection, so the rewritten path is exactly what that
 * validator will look for. Paths outside the `outputs.*` shape (e.g.
 * `meta.*`, `input.*`) are left untouched. Any short id encountered here that
 * wasn't already resolved (referenced only inside a binding path, never as a
 * node/edge id) still gets a stable uuid via `idAssignment.resolve` — kept
 * reversible for feedback even though it will fail `REF_SOURCE_MISSING`.
 */
function rewriteStatePath(path: string, idAssignment: IdAssignment): string {
  const match = /^outputs\.([^.[]+)(.*)$/.exec(path);
  if (!match) return path;
  const [, shortId, rest] = match;
  return `outputs.${idAssignment.resolve(shortId as string)}${rest as string}`;
}

function remapInputs(inputs: PlannerDraftNode['inputs'], idAssignment: IdAssignment): NodeInputs {
  const remapped: NodeInputs = {};
  for (const [slot, binding] of Object.entries(inputs)) {
    remapped[slot] =
      binding.kind === 'state'
        ? { kind: 'state', path: rewriteStatePath(binding.path, idAssignment) }
        : binding;
  }
  return remapped;
}

/**
 * Renders a classified structured-output schema failure into a short,
 * model-readable feedback sentence (T1 review round 3, M6) built around
 * {@link describeStructuredOutputFailure}'s shared summary.
 */
function describeSchemaFailure(failure: StructuredOutputSchemaFailure): string {
  return `your previous response did not match the required schema: ${describeStructuredOutputFailure(failure)}`;
}

/**
 * D2's design node: resolve specs, build the catalog-embedding prompt
 * (feeding back the previous attempt's short-id-rewritten errors when this is
 * a correction round), get a structured `PlannerDraft` from the LLM (D3),
 * remap its short ids to stable UUIDs (D4), apply deterministic auto-fill
 * (D5), compute advisory layered positions (D6), and produce the
 * `@openpipeline/core` `PipelineDraft` the rest of the loop validates.
 *
 * If the model's structured output fails schema validation — either
 * `PlannerDraftSchema.parse(rawOutput)` throwing (a schema-SHAPE defect: the
 * adapter resolved with something that only loosely matches) or
 * `structuredModel.invoke(messages)` itself rejecting with an
 * `OutputParserException` (a provider `functionCalling` override, e.g.
 * `ChatOpenAI`, validates its own zod schema INSIDE `invoke` — T3 review
 * llm-robustness #1) — this no longer aborts `plan()` with a raw error (T1
 * review round 3, M6; extended to the `invoke`-rejects shape in T3): both are
 * caught here (a single `try` spans `invoke` AND `.parse`, so neither shape
 * escapes uncaught) and converted into `state.designError` +
 * `state.validationIssues`, which routes straight to `correct` (skipping
 * `validate` — there is no `PlannerDraft` to build a graph from) and consumes
 * an attempt exactly like a graph-level defect does. Only exhausting every
 * attempt on nothing but parse failures still surfaces as an error — see
 * `planner.ts`'s `readPlannerState`/`draft` check. Any other error (a genuine
 * LLM/network failure) still rethrows.
 */
export async function designNode(
  state: PlannerState,
  runtime: PlannerRuntime
): Promise<Partial<PlannerState>> {
  checkAbort(runtime.signal);
  runtime.logger.debug(`[PipelinePlanner] design attempt=${String(state.attempts)}`);
  runtime.onProgress?.({
    phase: 'design',
    attempt: state.attempts,
    detail: state.designFeedback ? 'revising draft after validation feedback' : 'generating draft',
  });

  // T2: merges in whatever `select` resolved this round (empty/undefined on
  // the no-MCP path, and on the MCP path before `select` has ever run) — see
  // `mergeSpecs`'s doc comment for why mcp specs are appended, not prepended.
  const specsByKey = new Map(
    mergeSpecs(runtime.specs, state.mcpSpecs).map((spec) => [spec.key, spec] as const)
  );

  // `state.mcpCatalogText` is built once by `select` per round (never
  // recomputed here) for the exact duplicate-warning reason
  // `runtime.catalog.text` is computed once per `plan()` call rather than
  // once per `design` attempt (T1 review round 2, I3) — see `select.node.ts`.
  const catalogText = state.mcpCatalogText
    ? `${runtime.catalog.text}\n${state.mcpCatalogText}`
    : runtime.catalog.text;

  const prompt = buildDesignPrompt({
    instruction: state.instruction,
    catalogText,
    feedback: state.designFeedback,
  });

  const rawModel = runtime.llmFactory.createModel(runtime.modelId, {
    temperature: runtime.temperature,
  });
  const structuredModel = asStructuredOutputModel(rawModel).withStructuredOutput(
    PlannerDraftSchema,
    { method: 'functionCalling' }
  );

  const messages = [new SystemMessage(DESIGN_SYSTEM_PROMPT), new HumanMessage(prompt)];

  let plannerDraft: PlannerDraft;
  try {
    // T3 review llm-robustness #1: `invoke` is inside this `try` too, not
    // just the defensive `.parse()` re-validation below — a real provider
    // `functionCalling` adapter can reject `invoke` itself with a
    // schema-validation error; it must not bypass this fail-soft path just
    // because it never reaches `rawOutput`/`.parse()` at all.
    const rawOutput = await structuredModel.invoke(messages);
    // Defensive re-validation: a structured-output adapter (real or fake) can
    // still hand back a shape that only loosely matches — surface a loud
    // ZodError rather than silently trusting `rawOutput`.
    plannerDraft = PlannerDraftSchema.parse(rawOutput);
  } catch (err) {
    const failure = classifyStructuredOutputError(err);
    if (!failure) throw err;
    const message = describeSchemaFailure(failure);
    return {
      designError: message,
      // MERGE onto `state.validationIssues`, never replace it (T1 carried-over
      // minor, t1-review-r2.md's re-review round): `validationIssues` is a
      // last-write-wins channel, so returning ONLY this attempt's schema issue
      // would silently drop whatever `validate` found on the previous pass —
      // e.g. attempt 1's real dangling-edge defect (still relevant: `draft`
      // stays whatever attempt 1 last produced, since THIS attempt never
      // reached a `PipelineDraft` to replace it) would vanish from
      // `unresolvedValidationErrors` the instant a later attempt merely fails
      // to parse, on top of the genuine structural defect never having been
      // fixed. Appending keeps both, oldest first.
      validationIssues: [...state.validationIssues, { code: 'NODE_TYPE_MISMATCH', message }],
      designFeedback: undefined,
    };
  }

  const idAssignment = buildIdAssignment(plannerDraft, state.idMap);

  const resolvedSpecByShortId = new Map<string, NodeSpec>();
  const nodeRows: Array<Omit<PipelineNodeRow, 'pipelineId'>> = plannerDraft.nodes.map((node) => {
    const spec = specsByKey.get(node.key);
    if (spec) resolvedSpecByShortId.set(node.id, spec);
    return {
      // An unresolved key falls back to 'TOOL' — a harmless placeholder never
      // surfaced as a successful result: validate() independently flags any
      // node whose key has no matching spec (NODE_TYPE_MISMATCH, reused —
      // see validate.node.ts), which routes back through correct() instead of
      // ever reaching a `validationIssues.length === 0` END.
      id: idAssignment.resolve(node.id),
      nodeType: spec?.nodeType ?? 'TOOL',
      key: node.key,
      label: node.label,
      inputs: remapInputs(node.inputs, idAssignment),
    };
  });

  const edgeRows: Array<Omit<PipelineEdgeRow, 'pipelineId'>> = plannerDraft.edges.map((edge) => ({
    id: crypto.randomUUID(),
    fromNodeId: idAssignment.resolve(edge.from),
    toNodeId: idAssignment.resolve(edge.to),
    label: edge.label,
  }));

  const specsByNodeId = new Map<string, NodeSpec>();
  for (const [shortId, spec] of resolvedSpecByShortId) {
    specsByNodeId.set(idAssignment.resolve(shortId), spec);
  }
  const filledNodes = applyAutoFill(nodeRows, edgeRows, specsByNodeId);
  const positionedNodes = computeLayeredPositions(filledNodes, edgeRows);

  const draft: PipelineDraft = {
    id: state.draft?.id,
    name: derivePipelineName(state.instruction),
    description: state.instruction,
    nodes: positionedNodes,
    edges: edgeRows,
  };

  return {
    draft,
    idMap: idAssignment.idMap,
    // No `plannerWarnings` key here (not even `[]`): the catalog's warnings
    // are instruction-independent and identical on every attempt, so
    // `PipelinePlanner.plan` seeds them into the APPEND-semantics
    // `plannerWarnings` channel exactly once, via the graph's initial input,
    // instead of this node re-emitting the same duplicate on every attempt
    // (T1 review round 2, I3). Omitting the key (rather than passing `[]`)
    // means the channel's reducer is never invoked here, so a future warning
    // source added to `design` can append its own entries without needing to
    // also thread the catalog's through.
    //
    // Clear consumed feedback so a later successful attempt doesn't carry a
    // stale correction note around in state past the point it was acted on.
    designFeedback: undefined,
    // Clear a previous attempt's schema-parse failure (T1 review round 3,
    // M6): this attempt DID parse, so `routeAfterDesign` must route to
    // `validate`, not stale-route back to `correct`.
    designError: undefined,
  };
}
