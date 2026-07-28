import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  NodeInputs,
  NodeSpec,
  PipelineDraft,
  PipelineEdgeRow,
  PipelineNodeRow,
} from '@openpipeline/core';
import { z } from 'zod';

import { checkAbort } from '../abort.js';
import { applyAutoFill } from '../auto-fill.js';
import { buildIdAssignment, type IdAssignment } from '../id-map.js';
import { computeLayeredPositions } from '../layout.js';
import { buildDesignPrompt, DESIGN_SYSTEM_PROMPT } from '../prompts.js';
import type { PlannerRuntime } from '../runtime.js';
import { PlannerDraftSchema, type PlannerDraft, type PlannerDraftNode } from '../schema.js';
import type { PlannerState } from '../state.js';
import { asStructuredOutputModel } from '../structured-output.js';

const MAX_NAME_LENGTH = 80;
/** How many of a ZodError's issues to quote back to the model — enough to be actionable, not a full dump. */
const MAX_SCHEMA_ISSUES = 3;

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
 * Renders the first few issues of a `PlannerDraftSchema.parse` failure into a
 * short, model-readable summary (T1 review round 3, M6). Capped at
 * {@link MAX_SCHEMA_ISSUES} — enough to be actionable without dumping the
 * entire ZodError tree into the next design prompt.
 */
function describeSchemaFailure(err: z.ZodError): string {
  const summary = err.issues
    .slice(0, MAX_SCHEMA_ISSUES)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
  return `your previous response did not match the required schema: ${summary}`;
}

/**
 * D2's design node: resolve specs, build the catalog-embedding prompt
 * (feeding back the previous attempt's short-id-rewritten errors when this is
 * a correction round), get a structured `PlannerDraft` from the LLM (D3),
 * remap its short ids to stable UUIDs (D4), apply deterministic auto-fill
 * (D5), compute advisory layered positions (D6), and produce the
 * `@openpipeline/core` `PipelineDraft` the rest of the loop validates.
 *
 * If the model's structured output fails `PlannerDraftSchema.parse` (a
 * schema-SHAPE defect — the adapter handed back something that only loosely
 * matches), this no longer aborts `plan()` with a raw `ZodError` (T1 review
 * round 3, M6): it's caught here and converted into `state.designError` +
 * `state.validationIssues`, which routes straight to `correct` (skipping
 * `validate` — there is no `PlannerDraft` to build a graph from) and consumes
 * an attempt exactly like a graph-level defect does. Only exhausting every
 * attempt on nothing but parse failures still surfaces as an error — see
 * `planner.ts`'s `readPlannerState`/`draft` check.
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

  const specsByKey = new Map(runtime.specs.map((spec) => [spec.key, spec] as const));

  const prompt = buildDesignPrompt({
    instruction: state.instruction,
    catalogText: runtime.catalog.text,
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
  const rawOutput = await structuredModel.invoke(messages);

  let plannerDraft: PlannerDraft;
  try {
    // Defensive re-validation: a structured-output adapter (real or fake) can
    // still hand back a shape that only loosely matches — surface a loud
    // ZodError rather than silently trusting `rawOutput`.
    plannerDraft = PlannerDraftSchema.parse(rawOutput);
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;
    const message = describeSchemaFailure(err);
    return {
      designError: message,
      validationIssues: [{ code: 'NODE_TYPE_MISMATCH', message }],
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
